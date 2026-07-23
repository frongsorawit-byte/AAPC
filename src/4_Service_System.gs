// 4_Service_System.gs — Control-panel backend: feature flags + system status + dev tools.
// อ่าน/เขียน flag พัก-การทำงาน (Script Properties) ให้แผงควบคุมบน Task Dashboard เรียกใช้.
// Added 2026-07-23 (Control Panel project). See ../README.md.

// ─── isPaused — จุดเดียวที่ตีความ flag (ใช้ทั้ง batch/push/controller) ──────────
// property = '1' → พัก; ค่าอื่น/ไม่มี → ทำงานปกติ (fail-open).
function isPaused(key) {
  return PropertiesService.getScriptProperties().getProperty(key) === '1';
}

// ─── actionAdminGetSystemStatus — สถานะรวมสำหรับแผงควบคุม ──────────────────────
function actionAdminGetSystemStatus(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const props = PropertiesService.getScriptProperties();

  const flags = {};
  AAPC_SETTABLE_FLAGS.forEach(function (k) { flags[k] = isPaused(k); });

  let lastBackup = null;
  const rawBackup = props.getProperty('AAPC_LAST_BACKUP');
  if (rawBackup) { try { lastBackup = JSON.parse(rawBackup); } catch (e) { lastBackup = null; } }

  return {
    status:     'ok',
    flags:      flags,
    devUserIds: props.getProperty('DEV_USER_IDS') || '',
    lastBatch:  _lastBatchInfo(),
    lastBackup: lastBackup,
    serverTime: Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'),
  };
}

// อ่าน Batch_Log แถวล่างสุดที่ type = 'daily' → สรุปผล batch ล่าสุด
function _lastBatchInfo() {
  const sheet = SpreadsheetApp.openById(AAPC_SHEET_ID).getSheetByName(SHEET_BATCH);
  if (!sheet) return null;
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][BL.TYPE]) !== 'daily') continue;
    const runAt = rows[i][BL.RUN_AT];
    return {
      runAt:     runAt instanceof Date ? Utilities.formatDate(runAt, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : String(runAt || ''),
      status:    String(rows[i][BL.STATUS] || ''),
      processed: Number(rows[i][BL.ROWS_PROCESSED]) || 0,
      awarded:   Number(rows[i][BL.ROWS_AWARDED]) || 0,
      failed:    Number(rows[i][BL.ROWS_FAILED]) || 0,
      clawback:  Number(rows[i][BL.ROWS_CLAWBACK]) || 0,
      error:     String(rows[i][BL.ERROR] || ''),
    };
  }
  return null;
}

// ─── actionAdminSetFlag — เปิด/ปิด flag (allowlist เท่านั้น) ───────────────────
function actionAdminSetFlag(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const key = data && data.key;
  if (AAPC_SETTABLE_FLAGS.indexOf(key) === -1) return { status: 'error', code: 'badkey' };
  const props = PropertiesService.getScriptProperties();
  const on = String(data.value) === '1';
  if (on) props.setProperty(key, '1');
  else props.deleteProperty(key);   // ลบทิ้ง = กลับสู่ปกติ (store สะอาด ไม่มี key ค้าง)
  return { status: 'ok', key: key, paused: on };
}

// ─── actionAdminSetDevUserIds — ตั้ง DEV_USER_IDS (validate รูปแบบ userId) ─────
function actionAdminSetDevUserIds(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const ids = String((data && data.devUserIds) || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const bad = ids.filter(function (id) { return !/^U[0-9a-f]{32}$/.test(id); });
  if (bad.length) return { status: 'error', code: 'badids', bad: bad };
  PropertiesService.getScriptProperties().setProperty('DEV_USER_IDS', ids.join(','));
  return { status: 'ok', devUserIds: ids.join(','), count: ids.length };
}

// ─── actionAdminRunDevBatch — สั่งรัน batch แบบ dev-only ทันที ─────────────────
function actionAdminRunDevBatch(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const has = (PropertiesService.getScriptProperties().getProperty('DEV_USER_IDS') || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean).length;
  if (!has) return { status: 'error', code: 'no-dev-ids' };
  runBatchDevTest();
  return { status: 'ok', message: 'dev batch เสร็จ — ดูผลใน Batch_Log' };
}
