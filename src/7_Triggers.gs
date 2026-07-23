// 7_Triggers.gs — One-time setup — installs the time-based triggers.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

// ─── installTriggers (run once) ───────────────────────────────────────────────
function installTriggers() {
  // Remove existing AAPC triggers
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    const fn = existing[i].getHandlerFunction();
    if (fn === 'runDailyBatch' || fn === 'cleanOldOrders' || fn === 'runDailyBackup') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  // Daily 17:00 → runDailyBatch (ย้ายจาก 00:00 → 17:00, บอสขอ 2026-07-06: ลูกค้าโดน LINE push กวนตอนนอน)
  ScriptApp.newTrigger('runDailyBatch').timeBased().atHour(17).everyDays(1).inTimezone('Asia/Bangkok').create();
  // Sunday 02:00 → cleanOldOrders
  ScriptApp.newTrigger('cleanOldOrders').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).inTimezone('Asia/Bangkok').create();
  // Daily 02:00 → runDailyBackup (สำรองชีตลูกค้า — เลี่ยงเวลาเขียน: batch 17:00, sync JSTERP 23:30)
  ScriptApp.newTrigger('runDailyBackup').timeBased().atHour(2).everyDays(1).inTimezone('Asia/Bangkok').create();
  Logger.log('Triggers installed: runDailyBatch (daily 17:00), cleanOldOrders (Sun 02:00), runDailyBackup (daily 02:00) — Asia/Bangkok');
}
