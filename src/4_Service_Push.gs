// 4_Service_Push.gs — Business logic — LINE push notifications after the daily batch.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

// ─── sendPushNotifications ────────────────────────────────────────────────────
// opts (optional): { devOnly: true, devIds: Set<userId> } — ส่ง push เฉพาะ dev.
//   undefined = prod behaviour (push หาทุกคนที่ processed วันนี้ ตามเดิม).
function sendPushNotifications(opts) {
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
    if (opts && opts.devOnly && !opts.devIds.has(userId)) continue; // dev-only: push เฉพาะ dev

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
    Logger.log('_linePush error for ' + maskId(userId) + ': ' + err);
  }
}
