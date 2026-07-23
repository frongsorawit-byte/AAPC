// 4_Service_Backup.gs — Daily snapshot of the customer spreadsheet to a Drive folder.
// makeCopy ทั้งไฟล์ กันเผลอลบ/แก้ชีตจริง — เก็บแบบ rolling BACKUP_KEEP_DAYS วัน.
// Added 2026-07-23 (Control Panel project). See ../README.md.
//
// หมายเหตุ scope: ไฟล์นี้เพิ่มการใช้ DriveApp → GAS จะขอ Drive OAuth scope ใหม่
// ครั้งแรกที่รัน runDailyBackup() ต้องกด Authorize ใน editor ก่อน trigger ถึงจะทำงานได้.

// ─── runDailyBackup — trigger target (daily 02:00) + manual entry point ────────
function runDailyBackup() {
  try {
    const folder = _getBackupFolder();
    const name   = BACKUP_NAME_PREFIX + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd_HHmm');
    DriveApp.getFileById(AAPC_SHEET_ID).makeCopy(name, folder);

    const kept = _pruneOldBackups(folder);
    const info = {
      at:   Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm'),
      name: name,
      kept: kept,
    };
    PropertiesService.getScriptProperties().setProperty('AAPC_LAST_BACKUP', JSON.stringify(info));
    logBatch('backup', 'success', { error: name + ' | kept=' + kept });
    Logger.log('runDailyBackup ok: ' + name + ' (kept=' + kept + ')');
    return info;
  } catch (e) {
    logBatch('backup', 'failed', { error: e.toString() });
    Logger.log('runDailyBackup FAILED: ' + e);
    throw e;
  }
}

// หา/สร้างโฟลเดอร์ backup — cache id ใน Script Property, สร้างใหม่ถ้าหาย/ถูกลบ
function _getBackupFolder() {
  const props  = PropertiesService.getScriptProperties();
  const cached = props.getProperty('AAPC_BACKUP_FOLDER_ID');
  if (cached) {
    try {
      const f = DriveApp.getFolderById(cached);
      if (!f.isTrashed()) return f;
    } catch (e) { /* หาย/เข้าไม่ได้ → สร้างใหม่ด้านล่าง */ }
  }
  const folder = DriveApp.createFolder(BACKUP_FOLDER_NAME);
  props.setProperty('AAPC_BACKUP_FOLDER_ID', folder.getId());
  return folder;
}

// ลบ (ย้ายลงถังขยะ 30 วัน) backup ที่เก่ากว่า BACKUP_KEEP_DAYS วัน → คืนจำนวนที่ยังเก็บไว้.
// ตัดสินอายุจากวันที่ในชื่อไฟล์ (parse ได้/เทสได้ ไม่พึ่ง getDateCreated ที่อาจเพี้ยนจาก copy-time skew).
// ไฟล์ชื่อไม่ตรง pattern (ของอื่นที่คนเผลอวางในโฟลเดอร์) จะไม่ถูกแตะ.
function _pruneOldBackups(folder) {
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const re     = new RegExp('^' + BACKUP_NAME_PREFIX + '(\\d{4})-(\\d{2})-(\\d{2})_');
  const files  = folder.getFiles();
  let kept = 0;
  while (files.hasNext()) {
    const file = files.next();
    const m = re.exec(file.getName());
    if (!m) continue;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (d < cutoff) file.setTrashed(true);
    else kept++;
  }
  return kept;
}

// admin endpoint — เรียก backup ทันทีจากแผงควบคุม (route ใน doPost ที่ Phase 2)
function actionAdminRunBackup(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  return { status: 'ok', backup: runDailyBackup() };
}
