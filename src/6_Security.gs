// 6_Security.gs — Access control. Phase 4b adds maskId() here for PII-safe logging.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

function isAdminOk(pwd) {
  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  return !!stored && String(pwd) === String(stored);
}
