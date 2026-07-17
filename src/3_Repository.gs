// 3_Repository.gs — Data access layer — the only file that reads/creates sheet schema directly.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

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
