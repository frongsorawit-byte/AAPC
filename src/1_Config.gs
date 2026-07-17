// 1_Config.gs — Configuration layer — sheet IDs, column-index maps, tier thresholds. No business logic here.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

/**
 * AAPC — Google Apps Script Backend v3 (Phase 2)
 *
 * doGet  → multi-action JSON API (getProfile, getHistory, checkDuplicate)
 * doPost → receive LIFF submission → save to Data_Log + upsert Points_Master
 *
 * Scheduled (via installTriggers):
 *   runDailyBatch()    — daily 17:00, match Data_Log ↔ Order_Verification
 *                        award/reject/clawback, send LINE push
 *   cleanOldOrders()   — Sunday 02:00, delete Order_Verification rows > 60 days
 *
 * One-time setup:
 *   setupSchemaPhase2() — migrate sheets to Phase 2 schema (idempotent)
 *   installTriggers()   — install time-based triggers
 *
 * Tests: testCalculatePoints(), testSave()
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const AAPC_SHEET_ID  = '1xDDMTsY8BkBCfxL1KpKB3y1KJ48_jLu39MVvhF7ud10';
const SHEET_DATA_LOG = 'Data_Log';
const SHEET_POINTS   = 'Points_Master';
const SHEET_ORDERS   = 'Order_Verification';
const SHEET_CONFIG   = 'Config_Points';
const SHEET_BATCH    = 'Batch_Log';
const LINE_PUSH_URL  = 'https://api.line.me/v2/bot/message/push';

// Data_Log column indices (0-based) — 14 columns
const COL = {
  TIMESTAMP:         0,
  USER_ID:           1,
  DISPLAY_NAME:      2,
  ORDER_ID:          3,
  TRACKING_NO:       4,
  PICTURE_URL:       5,
  STATUS:            6,  // รอตรวจ | Verifying | ได้แต้ม | ซ้ำ | ไม่ผ่าน | ดูดแต้มคืน
  REASON:            7,
  POINTS_AWARDED:    8,
  ORDER_VALUE:       9,
  BASE_POINTS:      10,
  BONUS_MULTIPLIER: 11,
  BONUS_REASON:     12,
  PROCESSED_AT:     13,
};
const DATA_LOG_HEADERS = [
  'Timestamp','UserID','DisplayName','OrderID','TrackingNo','PictureUrl',
  'Status','Reason','PointsAwarded','OrderValue','BasePoints','BonusMultiplier','BonusReason','ProcessedAt'
];

// Points_Master column indices (0-based) — 6 columns
const PM = {
  USER_ID:           0,
  DISPLAY_NAME:      1,
  TIER_POINTS:       2,
  REDEEMABLE_POINTS: 3,
  TIER:              4,
  LAST_UPDATED:      5,
};
const POINTS_HEADERS = ['UserID','DisplayName','TierPoints','RedeemablePoints','Tier','LastUpdated'];

// Order_Verification column indices (0-based) — 9 columns
const OV = {
  ORDER_ID:     0,
  TRACKING_NO:  1,
  JST_ID:       2,
  VALUE:        3,
  SKUS:         4,  // comma-separated
  PLATFORM:     5,
  ORDER_DATE:   6,
  STATUS:       7,
  PROCESSED_AT: 8,
};
const OV_HEADERS = ['OrderID','TrackingNo','JST_ID','Value','SKUs','Platform','OrderDate','Status','ProcessedAt'];

// Config_Points columns  (CampaignId = col ต่อท้าย, ไว้ให้ Admin Promotion Manager อ้างอิงแก้/ลบ — loadConfigPoints อ่าน 0-6 เท่าเดิม)
const CFG = { SKU_KEYWORD: 0, PLATFORM: 1, MULTIPLIER: 2, FLAT_BONUS: 3, START_DATE: 4, END_DATE: 5, NOTE: 6, CAMPAIGN_ID: 7 };
const CFG_HEADERS = ['SKU_Keyword','Platform','Multiplier','FlatBonus','StartDate','EndDate','Note','CampaignId'];

// Batch_Log columns
const BL = { RUN_AT: 0, TYPE: 1, ROWS_PROCESSED: 2, ROWS_AWARDED: 3, ROWS_FAILED: 4, ROWS_CLAWBACK: 5, STATUS: 6, ERROR: 7 };
const BL_HEADERS = ['RunAt','Type','RowsProcessed','RowsAwarded','RowsFailed','RowsClawback','Status','ErrorMessage'];

// Constants
const VERIFYING_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RECHECK_WINDOW_DAYS  = 10; // re-check awarded orders for clawback within 10 days
const ORDER_VERIFICATION_KEEP_DAYS = 60;
const TIME_BUDGET_MS = 5 * 60 * 1000; // 5 min — leave 1 min buffer before GAS 6-min cap
const LOCK_TIMEOUT_MS = 30 * 1000;    // 30 sec to acquire lock

// ─── Phase 3: Redeem + Consent ────────────────────────────────────────────────
const SHEET_REDEMPTIONS  = 'Redemptions';
const SHEET_CONSENT      = 'Consent';
const REDEEM_RATE        = 50;   // 50 points = ฿50 per coupon unit
const COUPON_EXPIRY_DAYS = 365;  // 1 year (was 30) — บอสขอ 2026-07-06
const POINTS_BASE_RATE   = 200;  // ทุก 200฿ = 1 คะแนน (base) — source of truth ให้ calculatePoints + Admin explainer
const CAMPAIGN_LIST_LIMIT     = 5;   // Admin โชว์โปรฯ ล่าสุดกี่รายการ
const CAMPAIGN_MAX_MULTIPLIER = 5;   // cap ตัวคูณ กัน fat-finger/abuse — บอสยืนยันสูงสุดไม่เกิน 5 (2026-07-06)
const CONSENT_VERSION    = '1.0';

// Redemptions columns (0-based) — 12 cols. GAS auto-fills A–H; admin page fills I–L.
const RD = {
  USER_ID: 0, DISPLAY_NAME: 1, CODE: 2, UNITS: 3, VALUE: 4, REQUEST_ID: 5,
  ISSUED_AT: 6, EXPIRY_AT: 7,
  USED_WITH_ORDER: 8,  // admin: เลขออเดอร์ที่เอาคูปองไปใช้
  USED: 9,             // admin: checkbox TRUE เมื่อใช้แล้ว
  USED_AT: 10,         // admin: วันที่ใช้
  USED_BY: 11,         // admin: ชื่อแอดมินที่กดยืนยันใช้คูปอง (admin.html)
};
const RD_HEADERS = ['UserID','DisplayName','Code','Units','Value','RequestId','IssuedAt','ExpiryAt','UsedWithOrder','Used','UsedAt','UsedBy'];

// Consent columns (0-based)
const CN = { USER_ID: 0, DISPLAY_NAME: 1, VERSION: 2, CONSENTED_AT: 3 };
const CN_HEADERS = ['UserID','DisplayName','ConsentVersion','ConsentedAt'];

// ─── Tier Config — SINGLE SOURCE OF TRUTH (thresholds + discount %) ──────────
// แก้ระดับ/เปอร์เซ็นต์ส่วนลดที่ array นี้ที่เดียว แล้ว redeploy — frontend ดึงผ่าน getProfile.tierTable
const TIER_CONFIG = [
  { key: 'silver',  name: 'เงิน', nameEn: 'Silver',  min: 0,    max: 499,  discountPct: 5  },
  { key: 'gold',    name: 'ทอง',  nameEn: 'Gold',    min: 500,  max: 999,  discountPct: 10 },
  { key: 'diamond', name: 'เพชร', nameEn: 'Diamond', min: 1000, max: 1999, discountPct: 15 }, // 20→15 ตามมติ CEO 2026-07-16
  { key: 'vvip',    name: 'VVIP', nameEn: 'VVIP',    min: 2000, max: null, discountPct: 21 }, // เกณฑ์ 2,000 บอสยืนยัน 2026-07-16
];
