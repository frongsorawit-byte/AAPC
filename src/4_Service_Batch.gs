// 4_Service_Batch.gs — Business logic — points engine + the daily award/clawback batch.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

function isRuleActive(rule, orderDate) {
  if (!orderDate) return !rule.startDate && !rule.endDate; // no order date → only rules with no date constraint
  if (rule.startDate && orderDate < rule.startDate) return false;
  if (rule.endDate && orderDate > rule.endDate) return false; // datetime ตรงๆ — end ว่าง = ไม่มีวันหมด
  return true;
}

// Re-interpret a Date read from a spreadsheet cell (GAS แปลง serial→Date โดยใช้ spreadsheet's timezone,
// ไม่ใช่ script's timezone) ให้เป็น instant ที่ถูกต้องตาม Asia/Bangkok (ตรงกับที่ JSTerp export มาจริง).
// ดึง spreadsheet timezone แบบ dynamic กัน sheet timezone เปลี่ยนอนาคตแล้วโค้ดพังเงียบ.

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
