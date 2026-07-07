/**
 * AAPC — Google Apps Script Backend v3 (Phase 2)
 *
 * doGet  → multi-action JSON API (getProfile, getHistory, checkDuplicate)
 * doPost → receive LIFF submission → save to Data_Log + upsert Points_Master
 *
 * Scheduled (via installTriggers):
 *   runDailyBatch()    — daily 17:00, match Data_Log ↔ Order_Verification
 *                        award/reject/clawback, send LINE push
 *   cleanOldOrders()   — Sunday 02:00, delete Order_Verification rows > 60 days
 *
 * One-time setup:
 *   setupSchemaPhase2() — migrate sheets to Phase 2 schema (idempotent)
 *   installTriggers()   — install time-based triggers
 *
 * Tests: testCalculatePoints(), testSave()
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const AAPC_SHEET_ID  = '1xDDMTsY8BkBCfxL1KpKB3y1KJ48_jLu39MVvhF7ud10';
const SHEET_DATA_LOG = 'Data_Log';
const SHEET_POINTS   = 'Points_Master';
const SHEET_ORDERS   = 'Order_Verification';
const SHEET_CONFIG   = 'Config_Points';
const SHEET_BATCH    = 'Batch_Log';
const LINE_PUSH_URL  = 'https://api.line.me/v2/bot/message/push';

// Data_Log column indices (0-based) — 14 columns
const COL = {
  TIMESTAMP:         0,
  USER_ID:           1,
  DISPLAY_NAME:      2,
  ORDER_ID:          3,
  TRACKING_NO:       4,
  PICTURE_URL:       5,
  STATUS:            6,  // รอตรวจ | Verifying | ได้แต้ม | ซ้ำ | ไม่ผ่าน | ดูดแต้มคืน
  REASON:            7,
  POINTS_AWARDED:    8,
  ORDER_VALUE:       9,
  BASE_POINTS:      10,
  BONUS_MULTIPLIER: 11,
  BONUS_REASON:     12,
  PROCESSED_AT:     13,
};
const DATA_LOG_HEADERS = [
  'Timestamp','UserID','DisplayName','OrderID','TrackingNo','PictureUrl',
  'Status','Reason','PointsAwarded','OrderValue','BasePoints','BonusMultiplier','BonusReason','ProcessedAt'
];

// Points_Master column indices (0-based) — 6 columns
const PM = {
  USER_ID:           0,
  DISPLAY_NAME:      1,
  TIER_POINTS:       2,
  REDEEMABLE_POINTS: 3,
  TIER:              4,
  LAST_UPDATED:      5,
};
const POINTS_HEADERS = ['UserID','DisplayName','TierPoints','RedeemablePoints','Tier','LastUpdated'];

// Order_Verification column indices (0-based) — 9 columns
const OV = {
  ORDER_ID:     0,
  TRACKING_NO:  1,
  JST_ID:       2,
  VALUE:        3,
  SKUS:         4,  // comma-separated
  PLATFORM:     5,
  ORDER_DATE:   6,
  STATUS:       7,
  PROCESSED_AT: 8,
};
const OV_HEADERS = ['OrderID','TrackingNo','JST_ID','Value','SKUs','Platform','OrderDate','Status','ProcessedAt'];

// Config_Points columns  (CampaignId = col ต่อท้าย, ไว้ให้ Admin Promotion Manager อ้างอิงแก้/ลบ — loadConfigPoints อ่าน 0-6 เท่าเดิม)
const CFG = { SKU_KEYWORD: 0, PLATFORM: 1, MULTIPLIER: 2, FLAT_BONUS: 3, START_DATE: 4, END_DATE: 5, NOTE: 6, CAMPAIGN_ID: 7 };
const CFG_HEADERS = ['SKU_Keyword','Platform','Multiplier','FlatBonus','StartDate','EndDate','Note','CampaignId'];

// Batch_Log columns
const BL = { RUN_AT: 0, TYPE: 1, ROWS_PROCESSED: 2, ROWS_AWARDED: 3, ROWS_FAILED: 4, ROWS_CLAWBACK: 5, STATUS: 6, ERROR: 7 };
const BL_HEADERS = ['RunAt','Type','RowsProcessed','RowsAwarded','RowsFailed','RowsClawback','Status','ErrorMessage'];

// Constants
const VERIFYING_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RECHECK_WINDOW_DAYS  = 10; // re-check awarded orders for clawback within 10 days
const ORDER_VERIFICATION_KEEP_DAYS = 60;
const TIME_BUDGET_MS = 5 * 60 * 1000; // 5 min — leave 1 min buffer before GAS 6-min cap
const LOCK_TIMEOUT_MS = 30 * 1000;    // 30 sec to acquire lock

// ─── Phase 3: Redeem + Consent ────────────────────────────────────────────────
const SHEET_REDEMPTIONS  = 'Redemptions';
const SHEET_CONSENT      = 'Consent';
const REDEEM_RATE        = 50;   // 50 points = ฿50 per coupon unit
const COUPON_EXPIRY_DAYS = 365;  // 1 year (was 30) — บอสขอ 2026-07-06
const POINTS_BASE_RATE   = 200;  // ทุก 200฿ = 1 คะแนน (base) — source of truth ให้ calculatePoints + Admin explainer
const CAMPAIGN_LIST_LIMIT     = 5;   // Admin โชว์โปรฯ ล่าสุดกี่รายการ
const CAMPAIGN_MAX_MULTIPLIER = 5;   // cap ตัวคูณ กัน fat-finger/abuse — บอสยืนยันสูงสุดไม่เกิน 5 (2026-07-06)
const CONSENT_VERSION    = '1.0';

// Redemptions columns (0-based) — 12 cols. GAS auto-fills A–H; admin page fills I–L.
const RD = {
  USER_ID: 0, DISPLAY_NAME: 1, CODE: 2, UNITS: 3, VALUE: 4, REQUEST_ID: 5,
  ISSUED_AT: 6, EXPIRY_AT: 7,
  USED_WITH_ORDER: 8,  // admin: เลขออเดอร์ที่เอาคูปองไปใช้
  USED: 9,             // admin: checkbox TRUE เมื่อใช้แล้ว
  USED_AT: 10,         // admin: วันที่ใช้
  USED_BY: 11,         // admin: ชื่อแอดมินที่กดยืนยันใช้คูปอง (admin.html)
};
const RD_HEADERS = ['UserID','DisplayName','Code','Units','Value','RequestId','IssuedAt','ExpiryAt','UsedWithOrder','Used','UsedAt','UsedBy'];

// Consent columns (0-based)
const CN = { USER_ID: 0, DISPLAY_NAME: 1, VERSION: 2, CONSENTED_AT: 3 };
const CN_HEADERS = ['UserID','DisplayName','ConsentVersion','ConsentedAt'];

// ─── Tier Config — SINGLE SOURCE OF TRUTH (thresholds + discount %) ──────────
// แก้ระดับ/เปอร์เซ็นต์ส่วนลดที่ array นี้ที่เดียว แล้ว redeploy — frontend ดึงผ่าน getProfile.tierTable
const TIER_CONFIG = [
  { key: 'silver',  name: 'เงิน', nameEn: 'Silver',  min: 0,    max: 499,  discountPct: 5  },
  { key: 'gold',    name: 'ทอง',  nameEn: 'Gold',    min: 500,  max: 999,  discountPct: 10 },
  { key: 'diamond', name: 'เพชร', nameEn: 'Diamond', min: 1000, max: null, discountPct: 20 },
];

// ─── Tier Computation ─────────────────────────────────────────────────────────
function computeTier(points) {
  const p = Number(points) || 0;
  let idx = 0;
  for (let i = TIER_CONFIG.length - 1; i >= 0; i--) {
    if (p >= TIER_CONFIG[i].min) { idx = i; break; }
  }
  const cur  = TIER_CONFIG[idx];
  const next = TIER_CONFIG[idx + 1] || null;
  return {
    tier:         cur.name,
    nextTier:     next ? next.name : null,
    pointsToNext: next ? next.min - p : 0,
    key:          cur.key,
    nameEn:       cur.nameEn,
    discountPct:  cur.discountPct,
  };
}

function tierTablePublic() {
  return TIER_CONFIG.map(function (t) {
    return { key: t.key, name: t.name, nameEn: t.nameEn, min: t.min, max: t.max, discountPct: t.discountPct };
  });
}

// ─── ID Normalization ─────────────────────────────────────────────────────────
function normalizeId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function isCancelledStatus(s) {
  const x = String(s || '').toLowerCase();
  return x.indexOf('cancel') >= 0 || x.indexOf('refund') >= 0 ||
         x.indexOf('ยกเลิก') >= 0 || x.indexOf('คืนเงิน') >= 0 || x.indexOf('ลบ') >= 0;
}

// ─── Schema Migration (idempotent) ────────────────────────────────────────────
function setupSchemaPhase2() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const report = [];

  // 1. Points_Master: rename TotalPoints → TierPoints, add RedeemablePoints
  let pm = ss.getSheetByName(SHEET_POINTS);
  if (!pm) {
    pm = ss.insertSheet(SHEET_POINTS);
    pm.appendRow(POINTS_HEADERS);
    report.push('Created Points_Master');
  } else {
    const headers = pm.getRange(1, 1, 1, Math.max(pm.getLastColumn(), 1)).getValues()[0];
    const hasRedeem = headers.indexOf('RedeemablePoints') >= 0;
    const hasTier   = headers.indexOf('TierPoints') >= 0;
    const idxTotal  = headers.indexOf('TotalPoints');

    if (!hasTier && idxTotal >= 0) {
      pm.getRange(1, idxTotal + 1).setValue('TierPoints');
      report.push('Renamed TotalPoints → TierPoints');
    }
    if (!hasRedeem) {
      // Insert RedeemablePoints after TierPoints (col 3 = idx 2)
      pm.insertColumnAfter(PM.TIER_POINTS + 1);
      pm.getRange(1, PM.REDEEMABLE_POINTS + 1).setValue('RedeemablePoints');
      // Copy TierPoints → RedeemablePoints for existing users
      const lastRow = pm.getLastRow();
      if (lastRow > 1) {
        const tierVals = pm.getRange(2, PM.TIER_POINTS + 1, lastRow - 1, 1).getValues();
        pm.getRange(2, PM.REDEEMABLE_POINTS + 1, lastRow - 1, 1).setValues(tierVals);
      }
      report.push('Added RedeemablePoints column (init = TierPoints)');
    }
  }

  // 2. Data_Log: add new columns at end
  let dl = ss.getSheetByName(SHEET_DATA_LOG);
  if (!dl) {
    dl = ss.insertSheet(SHEET_DATA_LOG);
    dl.appendRow(DATA_LOG_HEADERS);
    report.push('Created Data_Log');
  } else {
    const headers = dl.getRange(1, 1, 1, Math.max(dl.getLastColumn(), 1)).getValues()[0];
    for (let i = 0; i < DATA_LOG_HEADERS.length; i++) {
      if (headers[i] !== DATA_LOG_HEADERS[i]) {
        dl.getRange(1, i + 1).setValue(DATA_LOG_HEADERS[i]);
      }
    }
    report.push('Data_Log headers verified/extended');
  }

  // 3. Order_Verification: ensure SKUs + ProcessedAt
  let ov = ss.getSheetByName(SHEET_ORDERS);
  if (!ov) {
    ov = ss.insertSheet(SHEET_ORDERS);
    ov.appendRow(OV_HEADERS);
    report.push('Created Order_Verification');
  } else {
    const headers = ov.getRange(1, 1, 1, Math.max(ov.getLastColumn(), 1)).getValues()[0];
    // If old schema (no SKUs at column 5), insert SKUs column after Value
    if (headers.indexOf('SKUs') < 0) {
      ov.insertColumnAfter(OV.VALUE + 1);
      ov.getRange(1, OV.SKUS + 1).setValue('SKUs');
      report.push('Added SKUs column to Order_Verification');
    }
    // Ensure all headers present
    for (let i = 0; i < OV_HEADERS.length; i++) {
      const cur = ov.getRange(1, i + 1).getValue();
      if (cur !== OV_HEADERS[i]) ov.getRange(1, i + 1).setValue(OV_HEADERS[i]);
    }
  }

  // 4. Config_Points
  let cfg = ss.getSheetByName(SHEET_CONFIG);
  if (!cfg) {
    cfg = ss.insertSheet(SHEET_CONFIG);
    cfg.appendRow(CFG_HEADERS);
    report.push('Created Config_Points');
  }

  // 5. Batch_Log
  let bl = ss.getSheetByName(SHEET_BATCH);
  if (!bl) {
    bl = ss.insertSheet(SHEET_BATCH);
    bl.appendRow(BL_HEADERS);
    report.push('Created Batch_Log');
  }

  Logger.log('setupSchemaPhase2 complete:\n' + report.join('\n'));
  return report;
}

// ─── Schema Migration Phase 3 (idempotent) ────────────────────────────────────
function setupSchemaPhase3() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const report = [];
  if (!ss.getSheetByName(SHEET_REDEMPTIONS)) {
    ss.insertSheet(SHEET_REDEMPTIONS).appendRow(RD_HEADERS);
    report.push('Created Redemptions');
  }
  if (!ss.getSheetByName(SHEET_CONSENT)) {
    ss.insertSheet(SHEET_CONSENT).appendRow(CN_HEADERS);
    report.push('Created Consent');
  }
  Logger.log('setupSchemaPhase3 complete:\n' + (report.join('\n') || 'nothing to do — sheets already exist'));
  return report;
}

// ─── Load Config_Points → rules array ─────────────────────────────────────────
function loadConfigPoints() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_CONFIG);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const rules = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const mult = Number(row[CFG.MULTIPLIER]);
    rules.push({
      skuKeyword: String(row[CFG.SKU_KEYWORD] || '').trim().toUpperCase(),
      platform:   String(row[CFG.PLATFORM]    || '').trim().toUpperCase(),
      multiplier: (mult >= 1 ? mult : 1),
      flatBonus:  Number(row[CFG.FLAT_BONUS]) || 0,
      startDate:  row[CFG.START_DATE] instanceof Date ? row[CFG.START_DATE] : null,
      endDate:    row[CFG.END_DATE]   instanceof Date ? row[CFG.END_DATE]   : null,
      note:       String(row[CFG.NOTE] || ''),
    });
  }
  return rules;
}

function isRuleActive(rule, orderDate) {
  if (!orderDate) return !rule.startDate && !rule.endDate; // no order date → only rules with no date constraint
  if (rule.startDate && orderDate < rule.startDate) return false;
  if (rule.endDate && orderDate > rule.endDate) return false; // datetime ตรงๆ — end ว่าง = ไม่มีวันหมด
  return true;
}

// Re-interpret a Date read from a spreadsheet cell (GAS แปลง serial→Date โดยใช้ spreadsheet's timezone,
// ไม่ใช่ script's timezone) ให้เป็น instant ที่ถูกต้องตาม Asia/Bangkok (ตรงกับที่ JSTerp export มาจริง).
// ดึง spreadsheet timezone แบบ dynamic กัน sheet timezone เปลี่ยนอนาคตแล้วโค้ดพังเงียบ.
function _toBangkok(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  const sheetTz = SpreadsheetApp.openById(AAPC_SHEET_ID).getSpreadsheetTimeZone();
  const iso = Utilities.formatDate(d, sheetTz, "yyyy-MM-dd'T'HH:mm:ss");
  const fixed = new Date(iso + '+07:00');
  return isNaN(fixed.getTime()) ? null : fixed;
}

// ─── Points Formula (pure) ────────────────────────────────────────────────────
function calculatePoints(orderValue, skus, platform, orderDate, configRules) {
  const basePoints = Math.floor(Number(orderValue) / POINTS_BASE_RATE);
  if (basePoints === 0) {
    return { points: 0, basePoints: 0, multiplier: 1, flat: 0, reason: 'มูลค่า < 200 บาท' };
  }

  const skuUpper = (skus || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const platformUpper = String(platform || '').trim().toUpperCase();

  const matched = configRules.filter(r => {
    if (!isRuleActive(r, orderDate)) return false;
    // Multi-family SKU: comma-separated, boundary match (family "ATP-00270" match "ATP-00270-34" แต่ไม่ match "ATP-0027X")
    const kws = String(r.skuKeyword || '').split(',').map(k => k.trim()).filter(Boolean);
    if (kws.length && !skuUpper.some(s => kws.some(kw => s === kw || s.startsWith(kw + '-')))) return false;
    // Multi-channel: comma-separated, membership test (ว่าง = ทุกช่องทาง)
    const plats = String(r.platform || '').split(',').map(p => p.trim()).filter(Boolean);
    if (plats.length && plats.indexOf(platformUpper) === -1) return false;
    return true;
  });

  let maxMult = 1, bestRule = null;
  for (let i = 0; i < matched.length; i++) {
    if (matched[i].multiplier > maxMult) {
      maxMult = matched[i].multiplier;
      bestRule = matched[i];
    }
  }

  // FlatBonus from SKU-specific rules only (skuKeyword non-empty)
  let totalFlat = 0;
  for (let i = 0; i < matched.length; i++) {
    if (matched[i].skuKeyword) totalFlat += matched[i].flatBonus;
  }

  const points = basePoints * maxMult + totalFlat;
  const reasonParts = [];
  if (bestRule && maxMult > 1) {
    if (bestRule.skuKeyword)       reasonParts.push('SKU ' + bestRule.skuKeyword + '×' + maxMult);
    else if (bestRule.platform)    reasonParts.push(bestRule.platform + '×' + maxMult);
    else                            reasonParts.push((bestRule.note || 'Campaign') + '×' + maxMult);
  }
  if (totalFlat > 0) reasonParts.push('+' + totalFlat + ' flat');

  return {
    points: points,
    basePoints: basePoints,
    multiplier: maxMult,
    flat: totalFlat,
    reason: reasonParts.join(' | '),
  };
}

// ─── Load Order_Verification → Maps ───────────────────────────────────────────
function loadOrderVerificationMap() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  const result = { byOrderId: new Map(), byTracking: new Map() };
  if (!sheet) return result;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const oid = normalizeId(row[OV.ORDER_ID]);
    const trk = normalizeId(row[OV.TRACKING_NO]);
    const order = {
      orderId:    oid,
      trackingNo: trk,
      value:      Number(row[OV.VALUE]) || 0,
      skus:       String(row[OV.SKUS] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      platform:   String(row[OV.PLATFORM] || '').trim(),
      orderDate:  row[OV.ORDER_DATE] instanceof Date ? _toBangkok(row[OV.ORDER_DATE]) : null,
      status:     String(row[OV.STATUS] || ''),
    };
    if (oid) result.byOrderId.set(oid, order);
    if (trk) result.byTracking.set(trk, order);
  }
  return result;
}

// ─── doGet: Multi-Action JSON API ────────────────────────────────────────────
function doGet(e) {
  const action = (e.parameter && e.parameter.action) || '';
  let result;
  try {
    if      (action === 'getProfile')     result = actionGetProfile(e.parameter.userId);
    else if (action === 'getHistory')     result = actionGetHistory(e.parameter.userId);
    else if (action === 'checkDuplicate') result = actionCheckDuplicate(e.parameter);
    else if (action === 'getCoupons')     result = actionGetCoupons(e.parameter.userId);
    else if (action === 'getConsent')     result = actionGetConsent(e.parameter.userId);
    else if (action === 'getLookupKeys')  result = actionGetLookupKeys(e.parameter);
    else                                  result = { error: 'unknown action: ' + action };
  } catch (err) {
    result = { error: err.toString() };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── actionGetProfile ─────────────────────────────────────────────────────────
function actionGetProfile(userId) {
  if (!userId) return { error: 'userId required' };

  const ss    = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_POINTS);
  if (!sheet) return _emptyProfile(userId);

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][PM.USER_ID] === userId) {
      const tierPoints  = Number(data[i][PM.TIER_POINTS]) || 0;
      const redeemable  = Number(data[i][PM.REDEEMABLE_POINTS]) || 0;
      const tierInfo    = computeTier(tierPoints);
      return {
        userId:       userId,
        displayName:  data[i][PM.DISPLAY_NAME] || '',
        points:       tierPoints,       // tier-counting balance (lifetime)
        redeemable:   redeemable,        // spendable balance
        tier:         tierInfo.tier,
        nextTierName: tierInfo.nextTier,
        pointsToNext: tierInfo.pointsToNext,
        tierKey:      tierInfo.key,
        discountPct:  tierInfo.discountPct,
        tierTable:    tierTablePublic(),
      };
    }
  }
  return _emptyProfile(userId);
}

// โปรไฟล์เริ่มต้น (ยังไม่มีแถวใน Points_Master) — shape เดียวกับ found-branch ทุก field
function _emptyProfile(userId) {
  const t0 = computeTier(0);
  return {
    userId: userId, displayName: '', points: 0, redeemable: 0,
    tier: t0.tier, nextTierName: t0.nextTier, pointsToNext: t0.pointsToNext,
    tierKey: t0.key, discountPct: t0.discountPct, tierTable: tierTablePublic(),
  };
}

// ─── actionGetHistory ─────────────────────────────────────────────────────────
function actionGetHistory(userId) {
  if (!userId) return [];

  const ss    = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_DATA_LOG);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[COL.USER_ID] !== userId) continue;
    const ts = row[COL.TIMESTAMP];
    rows.push({
      date:           ts instanceof Date ? Utilities.formatDate(ts, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : String(ts),
      orderId:        row[COL.ORDER_ID]    || '',
      trackingNo:     row[COL.TRACKING_NO] || '',
      status:         row[COL.STATUS]      || 'รอตรวจ',
      reason:         row[COL.REASON]      || '',
      pointsAwarded:  Number(row[COL.POINTS_AWARDED]) || 0,
      bonusReason:    row[COL.BONUS_REASON] || '',
    });
  }
  rows.reverse();
  return rows.slice(0, 30);   // 30 ล่าสุด (was 50) — บอสขอ 2026-07-06
}

// ─── actionCheckDuplicate ─────────────────────────────────────────────────────
function actionCheckDuplicate(params) {
  const orderId    = normalizeId(params.orderId);
  const trackingNo = normalizeId(params.trackingNo);
  if (!orderId && !trackingNo) return { isDuplicate: false };

  const ss    = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_DATA_LOG);
  if (!sheet) return { isDuplicate: false };

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const s = row[COL.STATUS] || 'รอตรวจ';
    if (s === 'ไม่ผ่าน' || s === 'ดูดแต้มคืน') continue; // allow resubmit
    const rowOrder = normalizeId(row[COL.ORDER_ID]);
    const rowTrack = normalizeId(row[COL.TRACKING_NO]);
    if ((orderId && rowOrder === orderId) || (trackingNo && rowTrack === trackingNo)) {
      return { isDuplicate: true, existingStatus: s };
    }
  }
  return { isDuplicate: false };
}

// ─── doPost: Receive LIFF Submission ─────────────────────────────────────────
function doPost(e) {
  try {
    Logger.log('doPost body: ' + (e.postData && e.postData.contents));
    const data = JSON.parse(e.postData.contents);
    const type = String((data && data.type) || 'order');
    let resp;
    if (type === 'redeem') {
      resp = actionRedeem(data);
    } else if (type === 'consent') {
      resp = actionSetConsent(data);
    } else if (type === 'adminAuth') {
      resp = actionAdminAuth(data);
    } else if (type === 'adminLookup') {
      resp = actionAdminLookup(data);
    } else if (type === 'adminUseCoupon') {
      resp = actionAdminUseCoupon(data);
    } else if (type === 'adminMemberSearch') {
      resp = actionAdminMemberSearch(data);
    } else if (type === 'adminListCampaigns') {
      resp = actionAdminListCampaigns(data);
    } else if (type === 'adminSaveCampaign') {
      resp = actionAdminSaveCampaign(data);
    } else if (type === 'adminDeleteCampaign') {
      resp = actionAdminDeleteCampaign(data);
    } else {
      saveOrderData(data);
      ensurePointsMasterRow(data);
      resp = { status: 'success' };
    }
    return ContentService.createTextOutput(JSON.stringify(resp))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('doPost ERROR: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── saveOrderData ────────────────────────────────────────────────────────────
function saveOrderData(data) {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_DATA_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_DATA_LOG);
    sheet.appendRow(DATA_LOG_HEADERS);
  }
  const safe = data || {};
  sheet.appendRow([
    new Date(),
    String(safe.userId         || 'GUEST').trim(),
    String(safe.displayName    || 'Guest').trim(),
    normalizeId(safe.orderId),
    normalizeId(safe.trackingNumber),
    safe.pictureUrl     || '',
    'รอตรวจ',  // Status
    '',         // Reason
    0,          // PointsAwarded
    '',         // OrderValue (fill by batch)
    0,          // BasePoints
    1,          // BonusMultiplier
    '',         // BonusReason
    '',         // ProcessedAt
  ]);
}

// ─── ensurePointsMasterRow ────────────────────────────────────────────────────
function ensurePointsMasterRow(data) {
  const userId      = String((data && data.userId) || 'GUEST').trim();
  const displayName = String((data && data.displayName) || '').trim();
  if (userId === 'GUEST') return;

  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_POINTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_POINTS);
    sheet.appendRow(POINTS_HEADERS);
  }
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][PM.USER_ID] === userId) {
      if (rows[i][PM.DISPLAY_NAME] !== displayName && displayName) {
        sheet.getRange(i + 1, PM.DISPLAY_NAME + 1).setValue(displayName);
      }
      return;
    }
  }
  const tierInfo = computeTier(0);
  sheet.appendRow([userId, displayName, 0, 0, tierInfo.tier, new Date()]);
}

// ─── logBatch ─────────────────────────────────────────────────────────────────
function logBatch(type, status, info) {
  try {
    const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_BATCH);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_BATCH);
      sheet.appendRow(BL_HEADERS);
    }
    sheet.appendRow([
      new Date(),
      type,
      (info && info.processed) || 0,
      (info && info.awarded)   || 0,
      (info && info.failed)    || 0,
      (info && info.clawback)  || 0,
      status,
      (info && info.error)     || '',
    ]);
  } catch (e) {
    Logger.log('logBatch failed: ' + e);
  }
}

// ─── runDailyBatch (main) ─────────────────────────────────────────────────────
function runDailyBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    logBatch('daily', 'skipped', { error: 'lock-not-acquired' });
    return;
  }

  const startTime = Date.now();
  const now = new Date();

  try {
    const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
    const logSheet = ss.getSheetByName(SHEET_DATA_LOG);
    const pmSheet  = ss.getSheetByName(SHEET_POINTS);
    if (!logSheet || !pmSheet) {
      logBatch('daily', 'failed', { error: 'missing-sheets: run setupSchemaPhase2() first' });
      return;
    }

    const ov = loadOrderVerificationMap();
    const configRules = loadConfigPoints();
    const logData = logSheet.getDataRange().getValues();

    // Track awarded orders (Set for O(1) duplicate detection)
    const awardedSet = new Set();
    for (let i = 1; i < logData.length; i++) {
      if (logData[i][COL.STATUS] === 'ได้แต้ม') {
        const oid = normalizeId(logData[i][COL.ORDER_ID]);
        const trk = normalizeId(logData[i][COL.TRACKING_NO]);
        if (oid) awardedSet.add('O:' + oid);
        if (trk) awardedSet.add('T:' + trk);
      }
    }

    // Track clawback-already-done (so we don't double-clawback)
    const clawbackSet = new Set();
    for (let i = 1; i < logData.length; i++) {
      if (logData[i][COL.STATUS] === 'ดูดแต้มคืน') {
        const oid = normalizeId(logData[i][COL.ORDER_ID]);
        const uid = String(logData[i][COL.USER_ID] || '');
        clawbackSet.add(uid + '|' + oid);
      }
    }

    const updates = [];      // { rowIndex, values: [...] }
    const clawbackRows = []; // new rows to append
    const pointsDelta = new Map();
    let processed = 0, awarded = 0, failed = 0, clawback = 0;
    let timedOut = false;

    // ─── Phase 1: Process pending (รอตรวจ + Verifying)
    for (let i = 1; i < logData.length; i++) {
      if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break; }
      const row = logData[i];
      const status = row[COL.STATUS];
      if (status !== 'รอตรวจ' && status !== 'Verifying') continue;

      processed++;
      const userId     = String(row[COL.USER_ID] || '').trim();
      const orderId    = normalizeId(row[COL.ORDER_ID]);
      const trackingNo = normalizeId(row[COL.TRACKING_NO]);
      const submittedAt = row[COL.TIMESTAMP] instanceof Date ? row[COL.TIMESTAMP] : null;

      let order = null;
      if (orderId    && ov.byOrderId.has(orderId))     order = ov.byOrderId.get(orderId);
      if (!order && trackingNo && ov.byTracking.has(trackingNo)) order = ov.byTracking.get(trackingNo);

      let newStatus, reason = '', points = 0, basePoints = 0, multiplier = 1, bonusReason = '', orderValue = row[COL.ORDER_VALUE] || '';

      if (!order) {
        // Not found in OV
        if (status === 'Verifying' && submittedAt && (Date.now() - submittedAt.getTime()) > VERIFYING_TIMEOUT_MS) {
          newStatus = 'ไม่ผ่าน';
          reason = 'ไม่พบออเดอร์ในระบบ (timeout 7 วัน)';
          failed++;
        } else if (status === 'รอตรวจ') {
          newStatus = 'Verifying';
          reason = 'รอข้อมูลออเดอร์จาก JST (24-48 ชม.)';
          // Don't count as processed-final
          processed--;
        } else {
          continue; // Verifying within timeout — no change
        }
      } else {
        orderValue = order.value;
        if (isCancelledStatus(order.status)) {
          newStatus = 'ไม่ผ่าน';
          reason = 'ออเดอร์ถูกยกเลิก/คืนเงินแล้ว';
          failed++;
        } else if (order.value < 200) {
          newStatus = 'ไม่ผ่าน';
          reason = 'มูลค่าออเดอร์ต่ำกว่า 200 บาท';
          failed++;
        } else {
          const dupKeyO = order.orderId    ? 'O:' + order.orderId    : null;
          const dupKeyT = order.trackingNo ? 'T:' + order.trackingNo : null;
          if ((dupKeyO && awardedSet.has(dupKeyO)) || (dupKeyT && awardedSet.has(dupKeyT))) {
            newStatus = 'ซ้ำ';
            reason = 'ออเดอร์นี้สะสมแต้มไปแล้ว';
            failed++;
          } else {
            const calc = calculatePoints(order.value, order.skus, order.platform, order.orderDate, configRules);
            if (calc.points === 0) {
              newStatus = 'ไม่ผ่าน';
              reason = calc.reason || 'ไม่ผ่านเงื่อนไข';
              failed++;
            } else {
              newStatus = 'ได้แต้ม';
              reason = '';
              points = calc.points;
              basePoints = calc.basePoints;
              multiplier = calc.multiplier;
              bonusReason = calc.reason;
              if (dupKeyO) awardedSet.add(dupKeyO);
              if (dupKeyT) awardedSet.add(dupKeyT);
              if (userId && userId !== 'GUEST') {
                pointsDelta.set(userId, (pointsDelta.get(userId) || 0) + points);
              }
              awarded++;
            }
          }
        }
      }

      updates.push({
        rowIndex: i + 1,
        status: newStatus,
        reason: reason,
        points: points,
        orderValue: orderValue,
        basePoints: basePoints,
        multiplier: multiplier,
        bonusReason: bonusReason,
        processedAt: now,
      });
    }

    // ─── Phase 2: Clawback scan (ได้แต้ม rows where OV now cancelled)
    if (!timedOut) {
      for (let i = 1; i < logData.length; i++) {
        if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break; }
        const row = logData[i];
        if (row[COL.STATUS] !== 'ได้แต้ม') continue;

        const orderId    = normalizeId(row[COL.ORDER_ID]);
        const trackingNo = normalizeId(row[COL.TRACKING_NO]);
        const userId     = String(row[COL.USER_ID] || '');

        let order = null;
        if (orderId    && ov.byOrderId.has(orderId))    order = ov.byOrderId.get(orderId);
        if (!order && trackingNo && ov.byTracking.has(trackingNo)) order = ov.byTracking.get(trackingNo);
        if (!order || !isCancelledStatus(order.status)) continue;

        const clawbackKey = userId + '|' + orderId;
        if (clawbackSet.has(clawbackKey)) continue;

        const originalPoints = Number(row[COL.POINTS_AWARDED] || 0);
        if (originalPoints <= 0) continue;

        clawbackRows.push([
          now,
          userId,
          String(row[COL.DISPLAY_NAME] || ''),
          String(row[COL.ORDER_ID] || ''),
          String(row[COL.TRACKING_NO] || ''),
          '',  // PictureUrl
          'ดูดแต้มคืน',
          'ออเดอร์ถูกยกเลิก/คืนเงินภายหลัง',
          -originalPoints,
          Number(row[COL.ORDER_VALUE] || 0),
          Number(row[COL.BASE_POINTS] || 0),
          Number(row[COL.BONUS_MULTIPLIER] || 1),
          'Clawback',
          now,
        ]);
        clawbackSet.add(clawbackKey);

        if (userId && userId !== 'GUEST') {
          pointsDelta.set(userId, (pointsDelta.get(userId) || 0) - originalPoints);
        }
        clawback++;
      }
    }

    // ─── Phase 3: Write back to Data_Log
    for (let k = 0; k < updates.length; k++) {
      if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break; }
      const u = updates[k];
      logSheet.getRange(u.rowIndex, COL.STATUS + 1).setValue(u.status);
      logSheet.getRange(u.rowIndex, COL.REASON + 1).setValue(u.reason);
      logSheet.getRange(u.rowIndex, COL.POINTS_AWARDED + 1).setValue(u.points);
      if (u.orderValue !== '') logSheet.getRange(u.rowIndex, COL.ORDER_VALUE + 1).setValue(u.orderValue);
      logSheet.getRange(u.rowIndex, COL.BASE_POINTS + 1).setValue(u.basePoints);
      logSheet.getRange(u.rowIndex, COL.BONUS_MULTIPLIER + 1).setValue(u.multiplier);
      logSheet.getRange(u.rowIndex, COL.BONUS_REASON + 1).setValue(u.bonusReason);
      logSheet.getRange(u.rowIndex, COL.PROCESSED_AT + 1).setValue(u.processedAt);
    }

    // Append clawback rows
    if (clawbackRows.length > 0) {
      const startRow = logSheet.getLastRow() + 1;
      logSheet.getRange(startRow, 1, clawbackRows.length, clawbackRows[0].length).setValues(clawbackRows);
    }

    // ─── Phase 4: Update Points_Master + recompute Tiers
    applyPointsDeltaAndRecomputeTiers(pmSheet, pointsDelta, now);

    const finalStatus = timedOut ? 'partial' : 'success';
    logBatch('daily', finalStatus, { processed: processed, awarded: awarded, failed: failed, clawback: clawback, error: timedOut ? 'time-budget-reached' : '' });

    // Send LINE push notifications (best-effort)
    try { sendPushNotifications(); } catch (e) { Logger.log('push notify error: ' + e); }

  } catch (e) {
    logBatch('daily', 'failed', { error: e.toString() });
    Logger.log('runDailyBatch error: ' + e);
  } finally {
    lock.releaseLock();
  }
}

// ─── applyPointsDeltaAndRecomputeTiers ────────────────────────────────────────
function applyPointsDeltaAndRecomputeTiers(pmSheet, pointsDelta, now) {
  const pmData = pmSheet.getDataRange().getValues();
  for (let i = 1; i < pmData.length; i++) {
    const uid       = String(pmData[i][PM.USER_ID] || '');
    const curTier   = Number(pmData[i][PM.TIER_POINTS]) || 0;
    const curRedeem = Number(pmData[i][PM.REDEEMABLE_POINTS]) || 0;
    const delta     = pointsDelta.get(uid) || 0;

    const newTierPts = curTier + delta;
    const newRedeem  = curRedeem + delta;
    const newTier    = computeTier(newTierPts).tier;
    const oldTier    = String(pmData[i][PM.TIER] || '');

    let changed = false;
    if (delta !== 0) {
      pmSheet.getRange(i + 1, PM.TIER_POINTS       + 1).setValue(newTierPts);
      pmSheet.getRange(i + 1, PM.REDEEMABLE_POINTS + 1).setValue(newRedeem);
      pmSheet.getRange(i + 1, PM.LAST_UPDATED      + 1).setValue(now);
      changed = true;
    }
    // Always recompute tier — handles Boss manual edits too
    if (newTier !== oldTier) {
      pmSheet.getRange(i + 1, PM.TIER + 1).setValue(newTier);
      changed = true;
    }
  }
}

// ─── cleanOldOrders (weekly) ──────────────────────────────────────────────────
const PDPA_RETENTION_YEARS = 2;

function cleanOldOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    logBatch('cleanup', 'skipped', { error: 'lock-not-acquired' });
    return;
  }
  try {
    const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);

    // 1. Delete Order_Verification rows older than ORDER_VERIFICATION_KEEP_DAYS
    const ovSheet = ss.getSheetByName(SHEET_ORDERS);
    let ovDeleted = 0;
    if (ovSheet) {
      const data   = ovSheet.getDataRange().getValues();
      const cutoff = new Date(Date.now() - ORDER_VERIFICATION_KEEP_DAYS * 24 * 60 * 60 * 1000);
      const rowsToDelete = [];
      for (let i = 1; i < data.length; i++) {
        const d = data[i][OV.ORDER_DATE];
        if (d instanceof Date && d < cutoff) rowsToDelete.push(i + 1);
      }
      for (let j = rowsToDelete.length - 1; j >= 0; j--) ovSheet.deleteRow(rowsToDelete[j]);
      ovDeleted = rowsToDelete.length;
    }

    // 2. PDPA: anonymize PII in Data_Log rows older than PDPA_RETENTION_YEARS
    const pdpaCutoff = new Date();
    pdpaCutoff.setFullYear(pdpaCutoff.getFullYear() - PDPA_RETENTION_YEARS);
    let dlAnon = 0, rdAnon = 0;

    const dlSheet = ss.getSheetByName(SHEET_DATA_LOG);
    if (dlSheet) {
      const dlData = dlSheet.getDataRange().getValues();
      for (let i = 1; i < dlData.length; i++) {
        const ts = dlData[i][COL.TIMESTAMP];
        if (!(ts instanceof Date) || ts >= pdpaCutoff) continue;
        if (String(dlData[i][COL.USER_ID] || '') === '[anonymized]') continue;
        // Blank: UserID, DisplayName, PictureUrl (keep points/status for audit)
        dlSheet.getRange(i + 1, COL.USER_ID      + 1).setValue('[anonymized]');
        dlSheet.getRange(i + 1, COL.DISPLAY_NAME + 1).setValue('[anonymized]');
        dlSheet.getRange(i + 1, COL.PICTURE_URL  + 1).setValue('');
        dlAnon++;
      }
    }

    // 3. PDPA: anonymize PII in Redemptions rows older than PDPA_RETENTION_YEARS
    const rdSheet = ss.getSheetByName(SHEET_REDEMPTIONS);
    if (rdSheet) {
      const rdData = rdSheet.getDataRange().getValues();
      for (let i = 1; i < rdData.length; i++) {
        const issued = rdData[i][RD.ISSUED_AT];
        if (!(issued instanceof Date) || issued >= pdpaCutoff) continue;
        if (String(rdData[i][RD.USER_ID] || '') === '[anonymized]') continue;
        rdSheet.getRange(i + 1, RD.USER_ID      + 1).setValue('[anonymized]');
        rdSheet.getRange(i + 1, RD.DISPLAY_NAME + 1).setValue('[anonymized]');
        rdAnon++;
      }
    }

    logBatch('cleanup', 'success', { ovDeleted, dlAnon, rdAnon });
  } catch (e) {
    logBatch('cleanup', 'failed', { error: e.toString() });
  } finally {
    lock.releaseLock();
  }
}

// ─── sendPushNotifications ────────────────────────────────────────────────────
function sendPushNotifications() {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) { Logger.log('LINE_CHANNEL_ACCESS_TOKEN not set'); return; }

  const ss       = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const logSheet = ss.getSheetByName(SHEET_DATA_LOG);
  const pmSheet  = ss.getSheetByName(SHEET_POINTS);
  if (!logSheet) return;

  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');
  const logData = logSheet.getDataRange().getValues();
  const userMessages = new Map();

  for (let i = 1; i < logData.length; i++) {
    const row    = logData[i];
    const status = String(row[COL.STATUS] || '');
    if (status === 'รอตรวจ' || status === 'Verifying') continue;

    const processedAt = row[COL.PROCESSED_AT];
    const rowDate = processedAt instanceof Date ? Utilities.formatDate(processedAt, 'Asia/Bangkok', 'dd/MM/yyyy') : '';
    if (rowDate !== today) continue;

    const userId = String(row[COL.USER_ID] || '');
    if (!userId || userId === 'GUEST') continue;

    if (!userMessages.has(userId)) userMessages.set(userId, []);
    userMessages.get(userId).push({
      orderId:       String(row[COL.ORDER_ID]    || ''),
      trackingNo:    String(row[COL.TRACKING_NO] || ''),
      status:        status,
      reason:        String(row[COL.REASON]      || ''),
      pointsAwarded: Number(row[COL.POINTS_AWARDED]) || 0,
      bonusReason:   String(row[COL.BONUS_REASON] || ''),
    });
  }

  if (userMessages.size === 0) { Logger.log('no notifications today'); return; }

  const pmData = pmSheet ? pmSheet.getDataRange().getValues() : [];
  const pmIndex = new Map();
  for (let i = 1; i < pmData.length; i++) pmIndex.set(String(pmData[i][PM.USER_ID]), pmData[i]);

  let sent = 0;
  userMessages.forEach(function (items, userId) {
    const pmRow      = pmIndex.get(userId);
    const tierPoints = pmRow ? Number(pmRow[PM.TIER_POINTS]) || 0 : 0;
    const redeemable = pmRow ? Number(pmRow[PM.REDEEMABLE_POINTS]) || 0 : 0;
    const tier       = pmRow ? String(pmRow[PM.TIER] || 'เงิน') : 'เงิน';

    const lines = ['สวัสดีค่ะ — อัปเดตคะแนนสะสม ATIPA วันนี้\n'];
    for (let k = 0; k < items.length; k++) {
      const it  = items[k];
      const ref = it.orderId || it.trackingNo || '—';
      if (it.status === 'ได้แต้ม') {
        const bonus = it.bonusReason ? ' (' + it.bonusReason + ')' : '';
        lines.push('✓ ออเดอร์ ' + ref + '\n  ได้รับ ' + it.pointsAwarded + ' คะแนน' + bonus);
      } else if (it.status === 'ซ้ำ') {
        lines.push('○ ออเดอร์ ' + ref + '\n  เคยสะสมคะแนนไปแล้ว');
      } else if (it.status === 'ไม่ผ่าน') {
        lines.push('✗ ออเดอร์ ' + ref + '\n  ' + (it.reason || 'ไม่ผ่านเงื่อนไข'));
      } else if (it.status === 'ดูดแต้มคืน') {
        lines.push('⚠️ ออเดอร์ ' + ref + '\n  ' + (it.reason || 'หักคะแนนคืน') + ' (' + it.pointsAwarded + ' คะแนน)');
      }
    }
    lines.push('\nคะแนนสะสมรวม: ' + tierPoints.toLocaleString() + ' คะแนน (' + tier + ')');
    lines.push('คะแนนแลกได้: ' + redeemable.toLocaleString() + ' คะแนน');
    lines.push('ขอบคุณที่ใช้บริการ ATIPA ค่ะ');

    _linePush(userId, token, lines.join('\n'));
    sent++;
  });
  Logger.log('sendPushNotifications: sent to ' + sent + ' users');
}

function _linePush(userId, token, text) {
  try {
    UrlFetchApp.fetch(LINE_PUSH_URL, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({ to: userId, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    Logger.log('_linePush error for ' + userId + ': ' + err);
  }
}

// ─── installTriggers (run once) ───────────────────────────────────────────────
function installTriggers() {
  // Remove existing AAPC triggers
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    const fn = existing[i].getHandlerFunction();
    if (fn === 'runDailyBatch' || fn === 'cleanOldOrders') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  // Daily 17:00 → runDailyBatch (ย้ายจาก 00:00 → 17:00, บอสขอ 2026-07-06: ลูกค้าโดน LINE push กวนตอนนอน)
  ScriptApp.newTrigger('runDailyBatch').timeBased().atHour(17).everyDays(1).inTimezone('Asia/Bangkok').create();
  // Sunday 02:00 → cleanOldOrders
  ScriptApp.newTrigger('cleanOldOrders').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).inTimezone('Asia/Bangkok').create();
  Logger.log('Triggers installed: runDailyBatch (daily 17:00), cleanOldOrders (Sun 02:00) — Asia/Bangkok');
}

// ─── Redeem: coupon code generator ────────────────────────────────────────────
function genCouponCode() {
  // Charset excludes ambiguous chars (0/O, 1/I) — customers & admin type these by hand
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function chunk() {
    let s = '';
    for (let i = 0; i < 4; i++) s += charset.charAt(Math.floor(Math.random() * charset.length));
    return s;
  }
  return 'ATIPA-' + chunk() + '-' + chunk();
}

function _couponFromRow(row) {
  const issued = row[RD.ISSUED_AT];
  const expiry = row[RD.EXPIRY_AT];
  const usedFlag = row[RD.USED] === true || String(row[RD.USED]).toUpperCase() === 'TRUE';
  const expired  = expiry instanceof Date && expiry < new Date();
  return {
    code:   String(row[RD.CODE] || ''),
    units:  Number(row[RD.UNITS]) || 0,
    value:  Number(row[RD.VALUE]) || 0,
    issued: issued instanceof Date ? Utilities.formatDate(issued, 'Asia/Bangkok', 'dd/MM/yyyy') : String(issued || ''),
    expiry: expiry instanceof Date ? Utilities.formatDate(expiry, 'Asia/Bangkok', 'dd/MM/yyyy') : String(expiry || ''),
    used:   usedFlag || expired,
    expired: expired,
    usedWithOrder: String(row[RD.USED_WITH_ORDER] || ''),
  };
}

// ─── actionRedeem ──────────────────────────────────────────────────────────────
// Decrements RedeemablePoints ONLY (TierPoints untouched). Lock-guarded vs runDailyBatch.
function actionRedeem(data) {
  const userId      = String((data && data.userId) || '').trim();
  const displayName = String((data && data.displayName) || '').trim();
  const units       = Math.floor(Number(data && data.units));
  const requestId   = String((data && data.requestId) || '').trim();

  if (!userId || userId === 'GUEST') return { status: 'error', message: 'userId required' };
  if (!(units >= 1))                 return { status: 'error', message: 'จำนวนคูปองต้องมากกว่า 0' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { status: 'error', message: 'ระบบกำลังประมวลผล กรุณาลองใหม่อีกครั้งใน 1-2 นาที' };
  }

  try {
    const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
    let rdSheet = ss.getSheetByName(SHEET_REDEMPTIONS);
    if (!rdSheet) { rdSheet = ss.insertSheet(SHEET_REDEMPTIONS); rdSheet.appendRow(RD_HEADERS); }

    // Idempotency — same requestId returns the coupon already issued (handles double-tap / retry)
    if (requestId) {
      const rdData = rdSheet.getDataRange().getValues();
      for (let i = 1; i < rdData.length; i++) {
        if (String(rdData[i][RD.REQUEST_ID]) === requestId) {
          return { status: 'success', duplicate: true, coupon: _couponFromRow(rdData[i]) };
        }
      }
    }

    const pmSheet = ss.getSheetByName(SHEET_POINTS);
    if (!pmSheet) return { status: 'error', message: 'ไม่พบฐานข้อมูลคะแนน' };
    const pmData = pmSheet.getDataRange().getValues();
    let pmRow = -1, redeemable = 0;
    for (let i = 1; i < pmData.length; i++) {
      if (String(pmData[i][PM.USER_ID]) === userId) {
        pmRow = i + 1;
        redeemable = Number(pmData[i][PM.REDEEMABLE_POINTS]) || 0;
        break;
      }
    }
    if (pmRow < 0) return { status: 'error', message: 'ไม่พบบัญชีสมาชิก' };

    const cost = units * REDEEM_RATE;
    if (redeemable < cost) {
      return { status: 'error', message: 'แต้มแลกได้ไม่พอ (มี ' + redeemable + ' ต้องใช้ ' + cost + ')', redeemable: redeemable };
    }

    const now    = new Date();
    const expiry = new Date(now.getTime() + COUPON_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const code   = genCouponCode();

    // 1. Redemptions row — admin cols (UsedWithOrder/Used/UsedAt) left blank
    rdSheet.appendRow([userId, displayName, code, units, cost, requestId, now, expiry, '', false, '']);

    // 2. Decrement RedeemablePoints ONLY (Tier stays — ADR-007)
    pmSheet.getRange(pmRow, PM.REDEEMABLE_POINTS + 1).setValue(redeemable - cost);
    pmSheet.getRange(pmRow, PM.LAST_UPDATED + 1).setValue(now);

    // 3. Audit row in Data_Log — status แลกแต้ม, negative points (shows in History)
    const dl = ss.getSheetByName(SHEET_DATA_LOG);
    if (dl) {
      dl.appendRow([
        now, userId, displayName, '', '', '',
        'แลกแต้ม', 'แลกคูปองส่วนลด ' + code, -cost,
        '', 0, 1, 'ส่วนลด ฿' + cost, now,
      ]);
    }

    // 4. LINE push (best-effort) — send coupon code to the customer
    try {
      const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
      if (token) {
        _linePush(userId, token,
          'แลกคูปองสำเร็จ 🎉\nรหัสคูปอง: ' + code + '\nส่วนลด ฿' + cost +
          '\nใช้ได้ถึง ' + Utilities.formatDate(expiry, 'Asia/Bangkok', 'dd/MM/yyyy') +
          '\nแต้มแลกได้คงเหลือ ' + (redeemable - cost) + ' คะแนน\n\nแจ้งรหัสนี้กับแอดมินเพื่อรับส่วนลดค่ะ');
      }
    } catch (e) { Logger.log('redeem push error: ' + e); }

    return {
      status: 'success',
      coupon: {
        code: code, units: units, value: cost,
        issued: Utilities.formatDate(now,    'Asia/Bangkok', 'dd/MM/yyyy'),
        expiry: Utilities.formatDate(expiry, 'Asia/Bangkok', 'dd/MM/yyyy'),
      },
      redeemable: redeemable - cost,
    };
  } catch (err) {
    Logger.log('actionRedeem error: ' + err);
    return { status: 'error', message: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── actionGetCoupons ─────────────────────────────────────────────────────────
function actionGetCoupons(userId) {
  if (!userId) return { coupons: [] };
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_REDEMPTIONS);
  if (!sheet) return { coupons: [] };
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][RD.USER_ID]) !== userId) continue;
    out.push(_couponFromRow(data[i]));
  }
  out.reverse(); // newest first
  return { coupons: out };
}

// ─── Admin Redeem (admin.html) ───────────────────────────────────────────────
// แอดมินกรอก coupon code → ตรวจสถานะ → mark used. Auth = shared password (Script Property).

// Idempotent: ensure the Redemptions sheet has the UsedBy header at column 12. Run once.
function ensureUsedByColumn() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_REDEMPTIONS);
  if (!sheet) { Logger.log('Redemptions sheet not found'); return; }
  const col = RD.USED_BY + 1; // 12
  const cur = sheet.getRange(1, col).getValue();
  if (String(cur).trim() !== 'UsedBy') {
    sheet.getRange(1, col).setValue('UsedBy');
    Logger.log('UsedBy header added at column ' + col);
  } else {
    Logger.log('UsedBy header already present');
  }
}

// Shared-password check. Set Script Property ADMIN_PASSWORD by hand (like LINE_CHANNEL_ACCESS_TOKEN).
function isAdminOk(pwd) {
  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  return !!stored && String(pwd) === String(stored);
}

function actionAdminAuth(data) {
  if (!data || !isAdminOk(data.password)) return { status: 'error', code: 'auth' };
  return { status: 'ok' };
}

function _adminCouponState(row) {
  const usedFlag = row[RD.USED] === true || String(row[RD.USED]).toUpperCase() === 'TRUE';
  const expiry   = row[RD.EXPIRY_AT];
  const expired  = expiry instanceof Date && expiry < new Date();
  if (usedFlag) return 'used';
  if (expired)  return 'expired';
  return 'valid';
}

function _fmtDate(v) {
  return v instanceof Date ? Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : String(v || '');
}

// actionAdminLookup — read-only, no lock. Returns discount value + coupon state.
function actionAdminLookup(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const code = String((data && data.code) || '').trim().toUpperCase();
  if (!code) return { status: 'error', code: 'nocode' };

  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_REDEMPTIONS);
  if (!sheet) return { status: 'notfound' };
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][RD.CODE]).trim().toUpperCase() !== code) continue;
    const row = rows[i];
    return {
      status: 'ok',
      coupon: {
        code:          String(row[RD.CODE] || ''),
        value:         Number(row[RD.VALUE]) || 0,
        units:         Number(row[RD.UNITS]) || 0,
        expiry:        row[RD.EXPIRY_AT] instanceof Date ? Utilities.formatDate(row[RD.EXPIRY_AT], 'Asia/Bangkok', 'dd/MM/yyyy') : '',
        state:         _adminCouponState(row),
        usedWithOrder: String(row[RD.USED_WITH_ORDER] || ''),
        usedAt:        _fmtDate(row[RD.USED_AT]),
        usedBy:        String(row[RD.USED_BY] || ''),
      },
    };
  }
  return { status: 'notfound' };
}

// actionAdminUseCoupon — write, lock-guarded (serializes 2 admins on the same coupon).
function actionAdminUseCoupon(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const code      = String((data && data.code) || '').trim().toUpperCase();
  const orderId   = String((data && data.orderId) || '').trim().toUpperCase();
  const adminName = String((data && data.adminName) || '').trim();
  if (!code)      return { status: 'error', code: 'nocode' };
  if (!orderId)   return { status: 'error', code: 'noorder' };
  if (!adminName) return { status: 'error', code: 'noname' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { status: 'error', code: 'busy', message: 'ระบบกำลังประมวลผล กรุณาลองใหม่ใน 1-2 นาที' };
  }
  try {
    const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_REDEMPTIONS);
    if (!sheet) return { status: 'error', code: 'notfound' };
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][RD.CODE]).trim().toUpperCase() !== code) continue;
      const row = rows[i];
      const state = _adminCouponState(row);
      if (state === 'used') {
        return { status: 'error', code: 'used',
                 usedWithOrder: String(row[RD.USED_WITH_ORDER] || ''),
                 usedAt: _fmtDate(row[RD.USED_AT]),
                 usedBy: String(row[RD.USED_BY] || '') };
      }
      if (state === 'expired') return { status: 'error', code: 'expired' };

      const now = new Date();
      const r = i + 1;
      sheet.getRange(r, RD.USED_WITH_ORDER + 1).setValue(orderId);
      sheet.getRange(r, RD.USED + 1).setValue(true);
      sheet.getRange(r, RD.USED_AT + 1).setValue(now);
      sheet.getRange(r, RD.USED_BY + 1).setValue(adminName);
      return {
        status: 'success',
        coupon: {
          code:          code,
          value:         Number(row[RD.VALUE]) || 0,
          usedWithOrder: orderId,
          usedAt:        Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'),
        },
      };
    }
    return { status: 'error', code: 'notfound' };
  } catch (err) {
    Logger.log('actionAdminUseCoupon error: ' + err);
    return { status: 'error', code: 'exception', message: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// actionAdminMemberSearch — read-only, no lock. ค้นสมาชิกจากชื่อ LINE (partial, case-insensitive)
// สำหรับแอดมินเช็ค tier/ส่วนลดตอนเปิดบิล — ไม่คืน userId เต็ม (PDPA minimization)
const MEMBER_SEARCH_LIMIT = 20;

function actionAdminMemberSearch(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const qRaw = String((data && data.query) || '').trim();
  const q = qRaw.normalize('NFC').toLowerCase();
  if (q.length < 2) return { status: 'error', code: 'shortquery' };

  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const pm = ss.getSheetByName(SHEET_POINTS);
  if (!pm) return { status: 'ok', count: 0, truncated: false, members: [] };

  const rows = pm.getDataRange().getValues();
  const matches = [];
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][PM.DISPLAY_NAME] || '').trim();
    if (!name) continue;
    if (name.normalize('NFC').toLowerCase().indexOf(q) < 0) continue;
    matches.push(rows[i]);
  }
  // เรียงคนที่ active ล่าสุดขึ้นก่อน — มักเป็นคนที่กำลังคุยกับแอดมินอยู่
  matches.sort(function (a, b) {
    const da = a[PM.LAST_UPDATED], db = b[PM.LAST_UPDATED];
    return (db instanceof Date ? db.getTime() : 0) - (da instanceof Date ? da.getTime() : 0);
  });
  const truncated = matches.length > MEMBER_SEARCH_LIMIT;
  const top = matches.slice(0, MEMBER_SEARCH_LIMIT);

  // Enrich จาก Data_Log: รูปโปรไฟล์ + ออเดอร์ล่าสุด ต่อ userId ที่ match — ไว้แยกคนชื่อซ้ำ
  // Data_Log append ตามเวลา → แถวหลังสุดชนะ ไม่ต้อง sort
  const wanted = {};
  top.forEach(function (r) { wanted[String(r[PM.USER_ID])] = true; });
  const latest = {};
  const dl = ss.getSheetByName(SHEET_DATA_LOG);
  if (dl && top.length) {
    const d = dl.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      const uid = String(d[i][COL.USER_ID] || '');
      if (!wanted[uid]) continue;
      const cur = latest[uid] || {};
      const pic = String(d[i][COL.PICTURE_URL] || '');
      if (pic) cur.pictureUrl = pic;
      const oid = String(d[i][COL.ORDER_ID] || '');
      if (oid) { cur.lastOrderId = oid; cur.lastOrderAt = d[i][COL.TIMESTAMP]; }
      latest[uid] = cur;
    }
  }

  const members = top.map(function (r) {
    const uid   = String(r[PM.USER_ID] || '');
    const pts   = Number(r[PM.TIER_POINTS]) || 0;
    const t     = computeTier(pts);
    const extra = latest[uid] || {};
    return {
      displayName:  String(r[PM.DISPLAY_NAME] || ''),
      userIdMasked: uid.length > 10 ? uid.slice(0, 6) + '…' + uid.slice(-4) : uid,
      tier:         t.tier,
      tierKey:      t.key,
      discountPct:  t.discountPct,
      tierPoints:   pts,
      redeemable:   Number(r[PM.REDEEMABLE_POINTS]) || 0,
      lastUpdated:  _fmtDate(r[PM.LAST_UPDATED]),
      pictureUrl:   extra.pictureUrl  || '',
      lastOrderId:  extra.lastOrderId || '',
      lastOrderAt:  _fmtDate(extra.lastOrderAt),
    };
  });
  return { status: 'ok', count: members.length, truncated: truncated, members: members };
}

// ─── Admin Promotion Manager ──────────────────────────────────────────────────
// จัดการโปรโมชั่น point ×N ตามช่วงวันที่ + ช่องทาง (ไลฟ์/แคมเปญ) ผ่านหน้า admin
// ใช้ engine เดิม: 1 แคมเปญ = 1 row ใน Config_Points (skuKeyword='', flatBonus=0, มี CampaignId)
// calculatePoints/isRuleActive/loadConfigPoints รองรับอยู่แล้ว — ที่เพิ่มคือ CRUD + guard

// ensure คอลัมน์ CampaignId มีใน Config_Points (idempotent, backward-compatible)
function ensureCampaignSchema() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_CONFIG);
  if (!sheet) { sheet = ss.insertSheet(SHEET_CONFIG); sheet.appendRow(CFG_HEADERS); return sheet; }
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (String(header[CFG.CAMPAIGN_ID] || '') !== 'CampaignId') {
    sheet.getRange(1, CFG.CAMPAIGN_ID + 1).setValue('CampaignId');
  }
  return sheet;
}

// สถานะโปรฯ เทียบกับ "ตอนนี้": upcoming / active / expired (datetime ตรงๆ — end ว่าง = ไม่มีวันหมด)
function _campaignStatus(startDate, endDate, now) {
  now = now || new Date();
  if (startDate instanceof Date && now < startDate) return 'upcoming';
  if (endDate instanceof Date && now > endDate) return 'expired';
  return 'active';
}

// distinct Platform จริงจาก Order_Verification — ให้ dropdown ช่องทางตรงข้อมูลจริง (ไม่ hardcode)
function _distinctOrderPlatforms() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const seen = {};
  for (let i = 1; i < data.length; i++) {
    const p = String(data[i][OV.PLATFORM] || '').trim();
    if (p) seen[p] = true;
  }
  return Object.keys(seen).sort();
}

// 'yyyy-MM-dd' → Date (script tz midnight) หรือ null
function _parseYMD(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// 'yyyy-MM-ddTHH:mm' (จาก <input type="datetime-local">) → Date (script tz = Asia/Bangkok, ตรงกับที่ admin กรอก)
// รองรับ 'yyyy-MM-dd' เก่า (เที่ยงคืน) ให้ backward-compat กับโปรฯ ก่อน Phase 3 ด้วย
function _parseDateTime(s) {
  const str = String(s || '').trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    return isNaN(d.getTime()) ? null : d;
  }
  return _parseYMD(str);
}

// actionAdminListCampaigns — read-only. คืนโปรฯ ล่าสุด 5 รายการ + platformsSeen + baseRate
function actionAdminListCampaigns(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const sheet = ensureCampaignSchema();
  const rows = sheet.getDataRange().getValues();
  const now = new Date();
  const campaigns = [];
  for (let i = 1; i < rows.length; i++) {
    const id = String(rows[i][CFG.CAMPAIGN_ID] || '').trim();
    if (!id) continue; // แสดงเฉพาะแคมเปญที่สร้างผ่าน UI (rule เดิมที่กรอกมือไม่มี id → ไม่ยุ่ง)
    const start = rows[i][CFG.START_DATE] instanceof Date ? rows[i][CFG.START_DATE] : null;
    const end   = rows[i][CFG.END_DATE]   instanceof Date ? rows[i][CFG.END_DATE]   : null;
    const skuKeyword  = String(rows[i][CFG.SKU_KEYWORD] || '').trim();
    const platformRaw = String(rows[i][CFG.PLATFORM]    || '').trim();
    campaigns.push({
      id:                id,
      multiplier:        Number(rows[i][CFG.MULTIPLIER]) || 1,
      skus:              skuKeyword  ? skuKeyword.split(',').map(function (s) { return s.trim(); }).filter(Boolean)  : [],
      platforms:         platformRaw ? platformRaw.split(',').map(function (p) { return p.trim(); }).filter(Boolean) : [],
      startDateForInput: start ? Utilities.formatDate(start, 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm") : '',
      endDateForInput:   end   ? Utilities.formatDate(end,   'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm") : '',
      startDate:         start ? Utilities.formatDate(start, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : '',
      endDate:           end   ? Utilities.formatDate(end,   'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : 'ไม่มีวันหมด',
      note:              String(rows[i][CFG.NOTE] || ''),
      status:            _campaignStatus(start, end, now),
      _sort:             start ? start.getTime() : 0,
    });
  }
  campaigns.sort(function (a, b) { return b._sort - a._sort; });
  const top = campaigns.slice(0, CAMPAIGN_LIST_LIMIT);
  top.forEach(function (c) { delete c._sort; });
  return {
    status:        'ok',
    campaigns:     top,
    platformsSeen: _distinctOrderPlatforms(),
    baseRate:      POINTS_BASE_RATE,
    maxMultiplier: CAMPAIGN_MAX_MULTIPLIER,
  };
}

// actionAdminSaveCampaign — create (ไม่มี id) หรือ update (มี id) โปรฯ ×N ช่วงวัน-เวลา + หลายช่องทาง + หลายรุ่น SKU
function actionAdminSaveCampaign(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const mult = Math.round(Number(data && data.multiplier));
  if (!(mult >= 1 && mult <= CAMPAIGN_MAX_MULTIPLIER)) {
    return { status: 'error', code: 'badmultiplier', message: 'ตัวคูณต้องเป็น 1–' + CAMPAIGN_MAX_MULTIPLIER };
  }
  const startRaw = String((data && data.startDate) || '').trim();
  const endRaw   = String((data && data.endDate)   || '').trim();
  const start = startRaw ? _parseDateTime(startRaw) : null;
  const end   = endRaw   ? _parseDateTime(endRaw)   : null;
  if (startRaw && !start) return { status: 'error', code: 'baddate', message: 'รูปแบบวันเริ่มไม่ถูกต้อง' };
  if (endRaw   && !end)   return { status: 'error', code: 'baddate', message: 'รูปแบบวันจบไม่ถูกต้อง' };
  if (start && end && start > end) return { status: 'error', code: 'baddate', message: 'วันเริ่มต้องไม่เกินวันจบ' };
  // end ว่าง = ไม่มีวันหมด (โปรฯ ถาวร); start ว่าง = active ทันที
  const skus = String((data && data.skus) || '').split(',')
    .map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean).join(',');   // '' = ทุกสินค้า
  const platform = String((data && data.platform) || '').split(',')
    .map(function (p) { return p.trim(); }).filter(Boolean).join(',');                 // '' = ทุกช่องทาง
  const note     = String((data && data.note) || '').trim().slice(0, 120);
  const id       = String((data && data.id) || '').trim();

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
    const sheet = ensureCampaignSchema();
    if (id) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][CFG.CAMPAIGN_ID] || '').trim() === id) {
          const r = i + 1;
          sheet.getRange(r, CFG.SKU_KEYWORD + 1).setValue(skus);
          sheet.getRange(r, CFG.PLATFORM + 1).setValue(platform);
          sheet.getRange(r, CFG.MULTIPLIER + 1).setValue(mult);
          sheet.getRange(r, CFG.START_DATE + 1).setValue(start || '');
          sheet.getRange(r, CFG.END_DATE + 1).setValue(end || '');
          sheet.getRange(r, CFG.NOTE + 1).setValue(note);
          return { status: 'ok', id: id, updated: true };
        }
      }
      return { status: 'error', code: 'notfound', message: 'ไม่พบแคมเปญนี้ (อาจถูกลบไปแล้ว)' };
    }
    // create ใหม่ — flatBonus=0 (flat bonus ไม่มี UI, ใช้เฉพาะ manual rule เดิมในชีต)
    const newId = 'CMP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const row = [];
    row[CFG.SKU_KEYWORD] = skus;
    row[CFG.PLATFORM]    = platform;
    row[CFG.MULTIPLIER]  = mult;
    row[CFG.FLAT_BONUS]  = 0;
    row[CFG.START_DATE]  = start || '';
    row[CFG.END_DATE]    = end || '';
    row[CFG.NOTE]        = note;
    row[CFG.CAMPAIGN_ID] = newId;
    sheet.appendRow(row);
    return { status: 'ok', id: newId, created: true };
  } catch (err) {
    Logger.log('actionAdminSaveCampaign error: ' + err);
    return { status: 'error', code: 'exception', message: err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// actionAdminDeleteCampaign — ลบโปรฯ ตาม CampaignId
function actionAdminDeleteCampaign(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const id = String((data && data.id) || '').trim();
  if (!id) return { status: 'error', code: 'noid' };
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
    const sheet = ensureCampaignSchema();
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][CFG.CAMPAIGN_ID] || '').trim() === id) {
        sheet.deleteRow(i + 1);
        return { status: 'ok' };
      }
    }
    return { status: 'error', code: 'notfound' };
  } catch (err) {
    Logger.log('actionAdminDeleteCampaign error: ' + err);
    return { status: 'error', code: 'exception', message: err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// Manual test — run in GAS editor. create → list → edit(ถาวร) → validate → delete
function testAdminCampaign() {
  const pwd = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'SET_ME';
  Logger.log('0) wrong pwd → '  + JSON.stringify(actionAdminListCampaigns({ password: 'WRONG' })));
  const save = actionAdminSaveCampaign({
    password: pwd, multiplier: 2, platform: 'ATIPASHOP,Tiktok', skus: 'ATP-00270',
    startDate: '2026-07-06T19:00', endDate: '2026-07-06T21:00', note: 'TEST ไลฟ์ LINE+TikTok',
  });
  Logger.log('1) create ×2 LINE+TikTok, SKU ATP-00270, 19:00-21:00 → ' + JSON.stringify(save));
  const id = save.id;
  Logger.log('2) list → ' + JSON.stringify(actionAdminListCampaigns({ password: pwd })));
  Logger.log('3) edit ×3 LINE-only, ไม่จำกัดรุ่น, ไม่มีวันหมด (ถาวร) → ' + JSON.stringify(actionAdminSaveCampaign({
    password: pwd, id: id, multiplier: 3, platform: 'ATIPASHOP', skus: '',
    startDate: '2026-07-06T19:00', endDate: '', note: 'TEST ถาวร LINE',
  })));
  Logger.log('4) bad multiplier 99 (cap=' + CAMPAIGN_MAX_MULTIPLIER + ') → ' + JSON.stringify(actionAdminSaveCampaign({
    password: pwd, multiplier: 99, startDate: '2026-07-06T19:00', endDate: '2026-07-06T21:00', note: 'x',
  })));
  Logger.log('5) bad date start>end → ' + JSON.stringify(actionAdminSaveCampaign({
    password: pwd, multiplier: 2, startDate: '2026-07-10T00:00', endDate: '2026-07-08T00:00', note: 'x',
  })));
  Logger.log('6) delete → ' + JSON.stringify(actionAdminDeleteCampaign({ password: pwd, id: id })));
  Logger.log('7) list after delete → ' + JSON.stringify(actionAdminListCampaigns({ password: pwd })));
  Logger.log('คาดหวัง: 0=auth, 1=ok+id, 2=มี 1 อัน status active/upcoming skus=[ATP-00270] platforms=[ATIPASHOP,Tiktok], 3=ok updated endDate=ไม่มีวันหมด, 4=badmultiplier, 5=baddate, 6=ok, 7=ไม่มี test row เหลือ');
}

// Manual test — run in GAS editor. Creates a test coupon, looks it up, uses it, re-looks-up.
function testAdminCoupon() {
  const TEST_USER = 'Uadmintest001';
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  // seed redeemable balance so actionRedeem succeeds
  const pm = ss.getSheetByName(SHEET_POINTS);
  let found = false;
  const pmData = pm.getDataRange().getValues();
  for (let i = 1; i < pmData.length; i++) {
    if (String(pmData[i][PM.USER_ID]) === TEST_USER) {
      pm.getRange(i + 1, PM.REDEEMABLE_POINTS + 1).setValue(100); found = true; break;
    }
  }
  if (!found) pm.appendRow([TEST_USER, 'Admin Test', 100, 100, 'เงิน', new Date()]);

  const pwd = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'SET_ME';
  const issued = actionRedeem({ userId: TEST_USER, displayName: 'Admin Test', units: 1, requestId: 'test-' + Date.now() });
  Logger.log('1) redeem → ' + JSON.stringify(issued));
  const code = issued.coupon && issued.coupon.code;

  Logger.log('2) lookup(valid) → ' + JSON.stringify(actionAdminLookup({ password: pwd, code: code })));
  Logger.log('3) lookup(wrong pwd) → ' + JSON.stringify(actionAdminLookup({ password: 'WRONG', code: code })));
  Logger.log('4) use → ' + JSON.stringify(actionAdminUseCoupon({ password: pwd, code: code, orderId: 'TEST-ORDER-99', adminName: 'ทดสอบ' })));
  Logger.log('5) lookup(after use) → ' + JSON.stringify(actionAdminLookup({ password: pwd, code: code })));
  Logger.log('6) use again (should be used) → ' + JSON.stringify(actionAdminUseCoupon({ password: pwd, code: code, orderId: 'TEST-ORDER-XX', adminName: 'ทดสอบ2' })));
}

// Manual test — run in GAS editor. Seeds a test member, then exercises adminMemberSearch.
function testAdminMemberSearch() {
  const TEST_USER = 'Umembersearch001';
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const pm = ss.getSheetByName(SHEET_POINTS);
  let found = false;
  const pmData = pm.getDataRange().getValues();
  for (let i = 1; i < pmData.length; i++) {
    if (String(pmData[i][PM.USER_ID]) === TEST_USER) { found = true; break; }
  }
  if (!found) pm.appendRow([TEST_USER, 'ทดสอบค้นหา Search-Tester', 650, 200, 'ทอง', new Date()]);

  const pwd = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'SET_ME';
  Logger.log('1) wrong pwd → '      + JSON.stringify(actionAdminMemberSearch({ password: 'WRONG', query: 'ทดสอบ' })));
  Logger.log('2) short query → '    + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'ท' })));
  Logger.log('3) thai partial → '   + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'ทดสอบค้น' })));
  Logger.log('4) latin any-case → ' + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'search-tester' })));
  Logger.log('5) not found → '      + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'zzz_no_such_name' })));
  Logger.log('คาดหวัง: 3) และ 4) เจอสมาชิก tierKey=gold, discountPct=10 · NOTE: test row uid=' + TEST_USER + ' ค้างใน Points_Master — ลบเองถ้าต้องการ');
}

// ─── PDPA Consent ──────────────────────────────────────────────────────────────
function actionGetConsent(userId) {
  if (!userId) return { consented: false, version: CONSENT_VERSION };
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_CONSENT);
  if (!sheet) return { consented: false, version: CONSENT_VERSION };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][CN.USER_ID]) === userId) {
      const v = String(data[i][CN.VERSION] || '');
      return { consented: v === CONSENT_VERSION, version: CONSENT_VERSION, consentedVersion: v };
    }
  }
  return { consented: false, version: CONSENT_VERSION };
}

function actionSetConsent(data) {
  const userId      = String((data && data.userId) || '').trim();
  const displayName = String((data && data.displayName) || '').trim();
  const version     = String((data && data.version) || CONSENT_VERSION);
  if (!userId || userId === 'GUEST') return { status: 'error', message: 'userId required' };

  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_CONSENT);
  if (!sheet) { sheet = ss.insertSheet(SHEET_CONSENT); sheet.appendRow(CN_HEADERS); }
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][CN.USER_ID]) === userId) {
      sheet.getRange(i + 1, CN.VERSION + 1).setValue(version);
      sheet.getRange(i + 1, CN.CONSENTED_AT + 1).setValue(new Date());
      if (displayName) sheet.getRange(i + 1, CN.DISPLAY_NAME + 1).setValue(displayName);
      return { status: 'success', consented: true };
    }
  }
  sheet.appendRow([userId, displayName, version, new Date()]);
  return { status: 'success', consented: true };
}

// ─── actionGetLookupKeys ──────────────────────────────────────────────────────
// ส่งรายการ key ที่ต้องค้นใน JSTERP สำหรับ targeted pull pipeline
// Query params:
//   token  — ต้องตรง Script Property "LOOKUP_TOKEN" (ถ้าไม่ set ไว้จะข้ามเช็ค)
// Response:
//   { orderIds: [...], trackingNos: [...], pendingCount: N, recheckCount: N }
//   orderIds    — Order IDs ทั้งหมดจากแถว pending + recheck
//   trackingNos — Tracking Nos จากแถวที่ไม่มี OrderID เท่านั้น (tracking-only submissions)
function actionGetLookupKeys(params) {
  // Token guard — ป้องกัน endpoint นี้ expose เลขออเดอร์ออกโดยไม่ตั้งใจ
  const expectedToken = PropertiesService.getScriptProperties().getProperty('LOOKUP_TOKEN');
  if (expectedToken) {
    if (!params || params.token !== expectedToken) {
      return { error: 'unauthorized' };
    }
  }

  const ss    = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_DATA_LOG);
  if (!sheet) return { orderIds: [], trackingNos: [], pendingCount: 0, recheckCount: 0 };

  const data = sheet.getDataRange().getValues();
  const now  = Date.now();
  const recheckWindowMs = RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const orderIdSet    = new Set();
  const trackingNoSet = new Set();
  let pendingCount = 0;
  let recheckCount = 0;

  for (let i = 1; i < data.length; i++) {
    const row       = data[i];
    const status    = String(row[COL.STATUS] || '').trim();
    const orderId   = String(row[COL.ORDER_ID]    || '').trim().toUpperCase();
    const tracking  = String(row[COL.TRACKING_NO] || '').trim().toUpperCase();

    let include = false;

    // pending: ยังรอตรวจ
    if (status === 'รอตรวจ' || status === 'Verifying') {
      include = true;
      pendingCount++;
    }

    // recheck: ได้แต้มแล้ว แต่ยังอยู่ในช่วง 10 วัน → เช็คซ้ำว่ามี refund/return ไหม
    if (status === 'ได้แต้ม') {
      const processedAt = row[COL.PROCESSED_AT];
      if (processedAt instanceof Date && (now - processedAt.getTime()) <= recheckWindowMs) {
        include = true;
        recheckCount++;
      }
    }

    if (!include) continue;

    if (orderId) {
      orderIdSet.add(orderId);
    } else if (tracking) {
      // tracking-only: ลูกค้ากรอกแค่เลขแทรค ไม่มี Order ID → ค้นรอบ 2
      trackingNoSet.add(tracking);
    }
  }

  return {
    orderIds:     Array.from(orderIdSet),
    trackingNos:  Array.from(trackingNoSet),
    pendingCount: pendingCount,
    recheckCount: recheckCount,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
// testTierConfig — เช็ค boundary ทุกจุดว่า computeTier ให้ผลเหมือนโค้ดเดิม + field ใหม่ครบ
function testTierConfig() {
  function chk(pts, tier, next, toNext) {
    const r = computeTier(pts);
    const ok = r.tier === tier && r.nextTier === next && r.pointsToNext === toNext &&
               typeof r.key === 'string' && typeof r.discountPct === 'number';
    Logger.log((ok ? '✓ ' : '✗ ') + pts + ' → ' + JSON.stringify(r));
  }
  chk(0,    'เงิน', 'ทอง',  500);
  chk(499,  'เงิน', 'ทอง',  1);
  chk(500,  'ทอง',  'เพชร', 500);
  chk(999,  'ทอง',  'เพชร', 1);
  chk(1000, 'เพชร', null,   0);
  chk(5000, 'เพชร', null,   0);
  chk(-5,   'เงิน', 'ทอง',  505); // negative input — พฤติกรรมเดิม
  Logger.log('tierTablePublic → ' + JSON.stringify(tierTablePublic()));
  Logger.log('fallback profile → ' + JSON.stringify(actionGetProfile('NON_EXISTENT_USER_XX')));
}

function testCalculatePoints() {
  // Helper: assert
  function assertEq(actual, expected, label) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) Logger.log('✓ ' + label);
    else Logger.log('✗ ' + label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
  const today = new Date(2026, 4, 14); // 2026-05-14 (month 0-indexed)

  // Cases
  const rules = [];
  assertEq(calculatePoints(99,   [], '', today, rules).points, 0,  '99฿ → 0');
  assertEq(calculatePoints(200,  [], '', today, rules).points, 1,  '200฿ → 1');
  assertEq(calculatePoints(399,  [], '', today, rules).points, 1,  '399฿ → 1 (floor)');
  assertEq(calculatePoints(400,  [], '', today, rules).points, 2,  '400฿ → 2');
  assertEq(calculatePoints(1000, [], '', today, rules).points, 5,  '1000฿ → 5');

  // SKU bonus (prefix)
  const rulesSku = [{ skuKeyword:'ATP-12345', platform:'', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'SKU promo' }];
  assertEq(calculatePoints(1000, ['ATP-12345-XX'], '', today, rulesSku).points, 10, '1000฿ + SKU×2 → 10');
  assertEq(calculatePoints(1000, ['ATP-99999-XX'], '', today, rulesSku).points, 5,  '1000฿ + non-match SKU → 5');

  // Campaign
  const rulesCamp = [{ skuKeyword:'', platform:'', multiplier:3, flatBonus:0, startDate:null, endDate:null, note:'Double Weekend' }];
  assertEq(calculatePoints(1000, [], '', today, rulesCamp).points, 15, '1000฿ + Campaign×3 → 15');

  // SKU×2 + Campaign×3 = max wins (×3)
  const rulesBoth = rulesSku.concat(rulesCamp);
  assertEq(calculatePoints(1000, ['ATP-12345-XX'], '', today, rulesBoth).points, 15, '1000฿ + SKU×2 + Camp×3 → 15 (max)');

  // Flat bonus
  const rulesFlat = [{ skuKeyword:'ATP-77777', platform:'', multiplier:1, flatBonus:5, startDate:null, endDate:null, note:'Flat +5' }];
  assertEq(calculatePoints(200, ['ATP-77777-AA'], '', today, rulesFlat).points, 6, '200฿ + flat +5 → 6');

  // Mix: ×2 SKU + flat +5 from another SKU
  const rulesMix = [
    { skuKeyword:'ATP-12345', platform:'', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'×2' },
    { skuKeyword:'ATP-77777', platform:'', multiplier:1, flatBonus:5, startDate:null, endDate:null, note:'+5' },
  ];
  assertEq(calculatePoints(1000, ['ATP-12345-XX','ATP-77777-AA'], '', today, rulesMix).points, 15, '1000฿ + ×2 + flat+5 → 15');

  // Platform LINE bonus
  const rulesLine = [{ skuKeyword:'', platform:'LINE', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'LINE x2' }];
  assertEq(calculatePoints(1000, [], 'LINE', today, rulesLine).points, 10, '1000฿ + LINE×2 → 10');
  assertEq(calculatePoints(1000, [], 'TikTok', today, rulesLine).points, 5, '1000฿ on TikTok (no LINE bonus) → 5');

  // Phase 3: datetime window (เจาะชั่วโมง)
  const liveStart = new Date(2026, 6, 6, 19, 0);
  const liveEnd   = new Date(2026, 6, 6, 21, 0);
  const rulesLive = [{ skuKeyword:'', platform:'', multiplier:3, flatBonus:0, startDate:liveStart, endDate:liveEnd, note:'Live 19-21' }];
  assertEq(calculatePoints(1000, [], '', new Date(2026, 6, 6, 20, 0), rulesLive).points, 15, 'live window 20:00 (in) → 15');
  assertEq(calculatePoints(1000, [], '', new Date(2026, 6, 6, 22, 0), rulesLive).points, 5,  'live window 22:00 (out, after end) → 5');
  assertEq(calculatePoints(1000, [], '', new Date(2026, 6, 6, 18, 0), rulesLive).points, 5,  'live window 18:00 (out, before start) → 5');

  // Phase 3: end ว่าง = ไม่มีวันหมด (โปรฯ ถาวร)
  const rulesForever = [{ skuKeyword:'', platform:'ATIPASHOP', multiplier:2, flatBonus:0, startDate:new Date(2026, 0, 1), endDate:null, note:'LINE forever' }];
  assertEq(calculatePoints(1000, [], 'ATIPASHOP', new Date(2030, 0, 1), rulesForever).points, 10, 'no-end campaign ยัง active ในอนาคตไกล → 10');

  // Phase 3: multi-family SKU (comma-separated, boundary-safe — กัน over-match)
  const rulesMultiSku = [{ skuKeyword:'ATP-00270,ATP-00350', platform:'', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'2 families' }];
  assertEq(calculatePoints(1000, ['ATP-00350-6'],   '', today, rulesMultiSku).points, 10, 'multi-family match รุ่นที่ 2 (ATP-00350-6) → 10');
  assertEq(calculatePoints(1000, ['ATP-002700-9'],  '', today, rulesMultiSku).points, 5,  'multi-family ไม่ over-match (ATP-002700-9 ≠ family ATP-00270) → 5');

  // Phase 3: multi-channel (comma-separated, membership test)
  const rulesMultiChannel = [{ skuKeyword:'', platform:'ATIPASHOP,TIKTOK', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'LINE+TikTok' }];
  assertEq(calculatePoints(1000, [], 'ATIPASHOP', today, rulesMultiChannel).points, 10, 'multi-channel match LINE → 10');
  assertEq(calculatePoints(1000, [], 'TIKTOK',    today, rulesMultiChannel).points, 10, 'multi-channel match TikTok → 10');
  assertEq(calculatePoints(1000, [], 'SHOPEE',    today, rulesMultiChannel).points, 5,  'multi-channel ไม่ match Shopee (ไม่อยู่ในลิสต์) → 5');

  Logger.log('testCalculatePoints done');
}

function testSave() {
  saveOrderData({
    userId:         'TEST_' + Date.now(),
    displayName:    'Manual Test',
    orderId:        'ord-test-001',  // will be uppercased
    trackingNumber: ' th9999 ',       // will be trimmed + uppercased
    pictureUrl:     '',
  });
  Logger.log('testSave done');
}

function testRedeem() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  setupSchemaPhase3();
  const uid = 'TEST_REDEEM_' + Date.now();
  const pm = ss.getSheetByName(SHEET_POINTS);
  // seed user: TierPoints=300, RedeemablePoints=120
  pm.appendRow([uid, 'Redeem Tester', 300, 120, computeTier(300).tier, new Date()]);

  function log(ok, label) { Logger.log((ok ? '✓ ' : '✗ ') + label); }

  // 1. insufficient — 3 units = 150 > 120
  let r = actionRedeem({ type: 'redeem', userId: uid, units: 3, requestId: '' });
  log(r.status === 'error', 'insufficient balance rejected');

  // 2. success — 2 units = 100 <= 120, code format ATIPA-XXXX-XXXX
  const req = 'REQ_' + Date.now();
  r = actionRedeem({ type: 'redeem', userId: uid, displayName: 'Redeem Tester', units: 2, requestId: req });
  log(r.status === 'success' && r.coupon && /^ATIPA-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.coupon.code), 'redeem success + code format (' + (r.coupon && r.coupon.code) + ')');
  log(r.redeemable === 20, 'redeemable 120 → 20 (got ' + r.redeemable + ')');

  // 3. idempotent — same requestId returns same coupon, no extra deduction
  const code1 = r.coupon.code;
  const r2 = actionRedeem({ type: 'redeem', userId: uid, units: 2, requestId: req });
  log(r2.status === 'success' && r2.duplicate === true && r2.coupon.code === code1, 'idempotent on requestId');

  // 4. TierPoints unchanged (still 300)
  const pmData = pm.getDataRange().getValues();
  let tierOk = false;
  for (let i = 1; i < pmData.length; i++) {
    if (String(pmData[i][PM.USER_ID]) === uid) tierOk = Number(pmData[i][PM.TIER_POINTS]) === 300;
  }
  log(tierOk, 'TierPoints unchanged (300)');

  // 5. getCoupons returns the 1 issued coupon
  const gc = actionGetCoupons(uid);
  log(gc.coupons.length === 1, 'getCoupons returns 1 coupon');

  // 6. consent lifecycle
  log(actionGetConsent(uid).consented === false, 'consent initially false');
  actionSetConsent({ userId: uid, displayName: 'Redeem Tester', version: CONSENT_VERSION });
  log(actionGetConsent(uid).consented === true, 'consent set true');

  Logger.log('testRedeem done — NOTE: leaves test rows (uid=' + uid + ') in Points_Master / Redemptions / Data_Log / Consent. ลบเองถ้าต้องการ.');
}
