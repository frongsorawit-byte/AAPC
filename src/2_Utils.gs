// 2_Utils.gs — Pure helper functions — no SpreadsheetApp/external calls, no side effects.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

// ─── Tier Computation ─────────────────────────────────────────────────────────
function computeTier(points) {
  const p = Number(points) || 0;
  let idx = 0;
  for (let i = TIER_CONFIG.length - 1; i >= 0; i--) {
    if (p >= TIER_CONFIG[i].min) { idx = i; break; }
  }
  const cur  = TIER_CONFIG[idx];
  const next = TIER_CONFIG[idx + 1] || null;
  return {
    tier:         cur.name,
    nextTier:     next ? next.name : null,
    pointsToNext: next ? next.min - p : 0,
    key:          cur.key,
    nameEn:       cur.nameEn,
    discountPct:  cur.discountPct,
  };
}

function tierTablePublic() {
  return TIER_CONFIG.map(function (t) {
    return { key: t.key, name: t.name, nameEn: t.nameEn, min: t.min, max: t.max, discountPct: t.discountPct };
  });
}

// ─── ID Normalization ─────────────────────────────────────────────────────────
function normalizeId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function isCancelledStatus(s) {
  const x = String(s || '').toLowerCase();
  return x.indexOf('cancel') >= 0 || x.indexOf('refund') >= 0 ||
         x.indexOf('ยกเลิก') >= 0 || x.indexOf('คืนเงิน') >= 0 || x.indexOf('ลบ') >= 0;
}

function _toBangkok(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  const sheetTz = SpreadsheetApp.openById(AAPC_SHEET_ID).getSpreadsheetTimeZone();
  const iso = Utilities.formatDate(d, sheetTz, "yyyy-MM-dd'T'HH:mm:ss");
  const fixed = new Date(iso + '+07:00');
  return isNaN(fixed.getTime()) ? null : fixed;
}
