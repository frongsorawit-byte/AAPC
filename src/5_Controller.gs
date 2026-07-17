// 5_Controller.gs — Routing layer — doGet/doPost + the public JSON API actions.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

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
    const data = JSON.parse(e.postData.contents);
    const type = String((data && data.type) || 'order');
    // ห้าม log ทั้ง body ดิบ — action ฝั่งแอดมินแนบ password มาด้วยทุกครั้ง (isAdminOk)
    // และ order/consent มี displayName/pictureUrl ของลูกค้า — log แค่ type + userId ที่ mask แล้วพอ
    Logger.log('doPost type=' + type + ' userId=' + maskId(data && data.userId));
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
