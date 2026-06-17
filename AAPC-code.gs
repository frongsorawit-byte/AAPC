/**
 * AAPC — Google Apps Script Backend v3 (Phase 2)
 *
 * doGet  → multi-action JSON API (getProfile, getHistory, checkDuplicate)
 * doPost → receive LIFF submission → save to Data_Log + upsert Points_Master
 *
 * Scheduled (via installTriggers):
 *   runDailyBatch()    — daily 00:00, match Data_Log ↔ Order_Verification
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

// Config_Points columns
const CFG = { SKU_KEYWORD: 0, PLATFORM: 1, MULTIPLIER: 2, FLAT_BONUS: 3, START_DATE: 4, END_DATE: 5, NOTE: 6 };
const CFG_HEADERS = ['SKU_Keyword','Platform','Multiplier','FlatBonus','StartDate','EndDate','Note'];

// Batch_Log columns
const BL = { RUN_AT: 0, TYPE: 1, ROWS_PROCESSED: 2, ROWS_AWARDED: 3, ROWS_FAILED: 4, ROWS_CLAWBACK: 5, STATUS: 6, ERROR: 7 };
const BL_HEADERS = ['RunAt','Type','RowsProcessed','RowsAwarded','RowsFailed','RowsClawback','Status','ErrorMessage'];

// Constants
const VERIFYING_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ORDER_VERIFICATION_KEEP_DAYS = 60;
const TIME_BUDGET_MS = 5 * 60 * 1000; // 5 min — leave 1 min buffer before GAS 6-min cap
const LOCK_TIMEOUT_MS = 30 * 1000;    // 30 sec to acquire lock

// ─── Phase 3: Redeem + Consent ────────────────────────────────────────────────
const SHEET_REDEMPTIONS  = 'Redemptions';
const SHEET_CONSENT      = 'Consent';
const REDEEM_RATE        = 50;   // 50 points = ฿50 per coupon unit
const COUPON_EXPIRY_DAYS = 30;
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

// ─── Tier Computation ─────────────────────────────────────────────────────────
function computeTier(points) {
  if (points >= 1000) return { tier: 'เพชร', nextTier: null, pointsToNext: 0 };
  if (points >= 500)  return { tier: 'ทอง',  nextTier: 'เพชร', pointsToNext: 1000 - points };
  return                    { tier: 'เงิน',  nextTier: 'ทอง',  pointsToNext: 500 - points };
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
  if (rule.endDate) {
    // EndDate is inclusive — add 1 day
    const endExclusive = new Date(rule.endDate.getTime() + 24 * 60 * 60 * 1000);
    if (orderDate >= endExclusive) return false;
  }
  return true;
}

// ─── Points Formula (pure) ────────────────────────────────────────────────────
function calculatePoints(orderValue, skus, platform, orderDate, configRules) {
  const basePoints = Math.floor(Number(orderValue) / 200);
  if (basePoints === 0) {
    return { points: 0, basePoints: 0, multiplier: 1, flat: 0, reason: 'มูลค่า < 200 บาท' };
  }

  const skuUpper = (skus || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const platformUpper = String(platform || '').trim().toUpperCase();

  const matched = configRules.filter(r => {
    if (!isRuleActive(r, orderDate)) return false;
    if (r.skuKeyword && !skuUpper.some(s => s.startsWith(r.skuKeyword))) return false;
    if (r.platform && r.platform !== platformUpper) return false;
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
      orderDate:  row[OV.ORDER_DATE] instanceof Date ? row[OV.ORDER_DATE] : null,
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
  if (!sheet) return { points: 0, redeemable: 0, tier: 'เงิน', displayName: '', pointsToNext: 500, nextTierName: 'ทอง' };

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
      };
    }
  }
  return { userId: userId, displayName: '', points: 0, redeemable: 0, tier: 'เงิน', nextTierName: 'ทอง', pointsToNext: 500 };
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
  return rows.slice(0, 50);
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
    } else if (type === 'adminLookup') {
      resp = actionAdminLookup(data);
    } else if (type === 'adminUseCoupon') {
      resp = actionAdminUseCoupon(data);
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
  // Daily 00:00 → runDailyBatch
  ScriptApp.newTrigger('runDailyBatch').timeBased().atHour(0).everyDays(1).inTimezone('Asia/Bangkok').create();
  // Sunday 02:00 → cleanOldOrders
  ScriptApp.newTrigger('cleanOldOrders').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).inTimezone('Asia/Bangkok').create();
  Logger.log('Triggers installed: runDailyBatch (daily 00:00), cleanOldOrders (Sun 02:00) — Asia/Bangkok');
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

// ─── Tests ────────────────────────────────────────────────────────────────────
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
