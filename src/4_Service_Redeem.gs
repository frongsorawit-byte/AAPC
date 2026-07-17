// 4_Service_Redeem.gs — Business logic — point redemption into coupons.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

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
