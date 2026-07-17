// 6_Security.gs — Access control. Phase 4b adds maskId() here for PII-safe logging.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

function isAdminOk(pwd) {
  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  return !!stored && String(pwd) === String(stored);
}

// ปิดบัง LINE userId ก่อน log (PDPA data minimization) — ใช้แทนการ log userId ดิบทุกจุด
function maskId(id) {
  const s = String(id == null ? '' : id);
  if (!s) return '(none)';
  return s.length <= 8 ? s : s.slice(0, 5) + '***' + s.slice(-5);
}
