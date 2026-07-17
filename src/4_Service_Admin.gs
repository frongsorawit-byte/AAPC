// 4_Service_Admin.gs — Business logic — admin.html backend: coupon lookup/use, member search, promotion CRUD.
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

function actionAdminAuth(data) {
  if (!data || !isAdminOk(data.password)) return { status: 'error', code: 'auth' };
  return { status: 'ok' };
}

function _adminCouponState(row) {
  const usedFlag = row[RD.USED] === true || String(row[RD.USED]).toUpperCase() === 'TRUE';
  const expiry   = row[RD.EXPIRY_AT];
  const expired  = expiry instanceof Date && expiry < new Date();
  if (usedFlag) return 'used';
  if (expired)  return 'expired';
  return 'valid';
}

function _fmtDate(v) {
  return v instanceof Date ? Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : String(v || '');
}

// actionAdminLookup — read-only, no lock. Returns discount value + coupon state.
function actionAdminLookup(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const code = String((data && data.code) || '').trim().toUpperCase();
  if (!code) return { status: 'error', code: 'nocode' };

  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_REDEMPTIONS);
  if (!sheet) return { status: 'notfound' };
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][RD.CODE]).trim().toUpperCase() !== code) continue;
    const row = rows[i];
    return {
      status: 'ok',
      coupon: {
        code:          String(row[RD.CODE] || ''),
        value:         Number(row[RD.VALUE]) || 0,
        units:         Number(row[RD.UNITS]) || 0,
        expiry:        row[RD.EXPIRY_AT] instanceof Date ? Utilities.formatDate(row[RD.EXPIRY_AT], 'Asia/Bangkok', 'dd/MM/yyyy') : '',
        state:         _adminCouponState(row),
        usedWithOrder: String(row[RD.USED_WITH_ORDER] || ''),
        usedAt:        _fmtDate(row[RD.USED_AT]),
        usedBy:        String(row[RD.USED_BY] || ''),
      },
    };
  }
  return { status: 'notfound' };
}

// actionAdminUseCoupon — write, lock-guarded (serializes 2 admins on the same coupon).
function actionAdminUseCoupon(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const code      = String((data && data.code) || '').trim().toUpperCase();
  const orderId   = String((data && data.orderId) || '').trim().toUpperCase();
  const adminName = String((data && data.adminName) || '').trim();
  if (!code)      return { status: 'error', code: 'nocode' };
  if (!orderId)   return { status: 'error', code: 'noorder' };
  if (!adminName) return { status: 'error', code: 'noname' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { status: 'error', code: 'busy', message: 'ระบบกำลังประมวลผล กรุณาลองใหม่ใน 1-2 นาที' };
  }
  try {
    const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_REDEMPTIONS);
    if (!sheet) return { status: 'error', code: 'notfound' };
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][RD.CODE]).trim().toUpperCase() !== code) continue;
      const row = rows[i];
      const state = _adminCouponState(row);
      if (state === 'used') {
        return { status: 'error', code: 'used',
                 usedWithOrder: String(row[RD.USED_WITH_ORDER] || ''),
                 usedAt: _fmtDate(row[RD.USED_AT]),
                 usedBy: String(row[RD.USED_BY] || '') };
      }
      if (state === 'expired') return { status: 'error', code: 'expired' };

      const now = new Date();
      const r = i + 1;
      sheet.getRange(r, RD.USED_WITH_ORDER + 1).setValue(orderId);
      sheet.getRange(r, RD.USED + 1).setValue(true);
      sheet.getRange(r, RD.USED_AT + 1).setValue(now);
      sheet.getRange(r, RD.USED_BY + 1).setValue(adminName);
      return {
        status: 'success',
        coupon: {
          code:          code,
          value:         Number(row[RD.VALUE]) || 0,
          usedWithOrder: orderId,
          usedAt:        Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'),
        },
      };
    }
    return { status: 'error', code: 'notfound' };
  } catch (err) {
    Logger.log('actionAdminUseCoupon error: ' + err);
    return { status: 'error', code: 'exception', message: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// actionAdminMemberSearch — read-only, no lock. ค้นสมาชิกจากชื่อ LINE (partial, case-insensitive)
// สำหรับแอดมินเช็ค tier/ส่วนลดตอนเปิดบิล — ไม่คืน userId เต็ม (PDPA minimization)
const MEMBER_SEARCH_LIMIT = 20;

function actionAdminMemberSearch(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const qRaw = String((data && data.query) || '').trim();
  const q = qRaw.normalize('NFC').toLowerCase();
  if (q.length < 2) return { status: 'error', code: 'shortquery' };

  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const pm = ss.getSheetByName(SHEET_POINTS);
  if (!pm) return { status: 'ok', count: 0, truncated: false, members: [] };

  const rows = pm.getDataRange().getValues();
  const matches = [];
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][PM.DISPLAY_NAME] || '').trim();
    if (!name) continue;
    if (name.normalize('NFC').toLowerCase().indexOf(q) < 0) continue;
    matches.push(rows[i]);
  }
  // เรียงคนที่ active ล่าสุดขึ้นก่อน — มักเป็นคนที่กำลังคุยกับแอดมินอยู่
  matches.sort(function (a, b) {
    const da = a[PM.LAST_UPDATED], db = b[PM.LAST_UPDATED];
    return (db instanceof Date ? db.getTime() : 0) - (da instanceof Date ? da.getTime() : 0);
  });
  const truncated = matches.length > MEMBER_SEARCH_LIMIT;
  const top = matches.slice(0, MEMBER_SEARCH_LIMIT);

  // Enrich จาก Data_Log: รูปโปรไฟล์ + ออเดอร์ล่าสุด ต่อ userId ที่ match — ไว้แยกคนชื่อซ้ำ
  // Data_Log append ตามเวลา → แถวหลังสุดชนะ ไม่ต้อง sort
  const wanted = {};
  top.forEach(function (r) { wanted[String(r[PM.USER_ID])] = true; });
  const latest = {};
  const dl = ss.getSheetByName(SHEET_DATA_LOG);
  if (dl && top.length) {
    const d = dl.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      const uid = String(d[i][COL.USER_ID] || '');
      if (!wanted[uid]) continue;
      const cur = latest[uid] || {};
      const pic = String(d[i][COL.PICTURE_URL] || '');
      if (pic) cur.pictureUrl = pic;
      const oid = String(d[i][COL.ORDER_ID] || '');
      if (oid) { cur.lastOrderId = oid; cur.lastOrderAt = d[i][COL.TIMESTAMP]; }
      latest[uid] = cur;
    }
  }

  const members = top.map(function (r) {
    const uid   = String(r[PM.USER_ID] || '');
    const pts   = Number(r[PM.TIER_POINTS]) || 0;
    const t     = computeTier(pts);
    const extra = latest[uid] || {};
    return {
      displayName:  String(r[PM.DISPLAY_NAME] || ''),
      userIdMasked: uid.length > 10 ? uid.slice(0, 6) + '…' + uid.slice(-4) : uid,
      tier:         t.tier,
      tierKey:      t.key,
      discountPct:  t.discountPct,
      tierPoints:   pts,
      redeemable:   Number(r[PM.REDEEMABLE_POINTS]) || 0,
      lastUpdated:  _fmtDate(r[PM.LAST_UPDATED]),
      pictureUrl:   extra.pictureUrl  || '',
      lastOrderId:  extra.lastOrderId || '',
      lastOrderAt:  _fmtDate(extra.lastOrderAt),
    };
  });
  return { status: 'ok', count: members.length, truncated: truncated, members: members };
}

// ─── Admin Promotion Manager ──────────────────────────────────────────────────
// จัดการโปรโมชั่น point ×N ตามช่วงวันที่ + ช่องทาง (ไลฟ์/แคมเปญ) ผ่านหน้า admin
// ใช้ engine เดิม: 1 แคมเปญ = 1 row ใน Config_Points (skuKeyword='', flatBonus=0, มี CampaignId)
// calculatePoints/isRuleActive/loadConfigPoints รองรับอยู่แล้ว — ที่เพิ่มคือ CRUD + guard

// ensure คอลัมน์ CampaignId มีใน Config_Points (idempotent, backward-compatible)
function ensureCampaignSchema() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_CONFIG);
  if (!sheet) { sheet = ss.insertSheet(SHEET_CONFIG); sheet.appendRow(CFG_HEADERS); return sheet; }
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (String(header[CFG.CAMPAIGN_ID] || '') !== 'CampaignId') {
    sheet.getRange(1, CFG.CAMPAIGN_ID + 1).setValue('CampaignId');
  }
  return sheet;
}

// สถานะโปรฯ เทียบกับ "ตอนนี้": upcoming / active / expired (datetime ตรงๆ — end ว่าง = ไม่มีวันหมด)
function _campaignStatus(startDate, endDate, now) {
  now = now || new Date();
  if (startDate instanceof Date && now < startDate) return 'upcoming';
  if (endDate instanceof Date && now > endDate) return 'expired';
  return 'active';
}

// ช่องทางที่ร้านมีจริง = ชื่อร้านค้าใน JSTERP (canonical UPPERCASE — CHANNEL_LABELS ใน admin.html map เป็นชื่อโชว์)
// Order_Verification เก็บแค่ 60 วัน — ถ้าไม่ union ค่าคงที่ ช่องทางที่ไม่มีออเดอร์ช่วงนั้นจะหายจาก checkbox
const KNOWN_PLATFORMS = ['ATIPASHOP', 'TIKTOK', 'SHOPEE', 'ATIPASHOP.SG'];

// distinct Platform จาก Order_Verification ∪ KNOWN_PLATFORMS — matching เดิม case-insensitive อยู่แล้ว
function _distinctOrderPlatforms() {
  const seen = {};
  KNOWN_PLATFORMS.forEach(function (p) { seen[p] = true; });
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_ORDERS);
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      let p = String(data[i][OV.PLATFORM] || '').trim().toUpperCase();
      if (p === 'LINE') p = 'ATIPASHOP'; // ค่าเก่า/แถว TEST ใช้ 'LINE' — กัน checkbox "LINE" โผล่ซ้ำ
      if (p) seen[p] = true;
    }
  }
  return Object.keys(seen).sort();
}

// 'yyyy-MM-dd' → Date (script tz midnight) หรือ null
function _parseYMD(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// 'yyyy-MM-ddTHH:mm' (จาก <input type="datetime-local">) → Date (script tz = Asia/Bangkok, ตรงกับที่ admin กรอก)
// รองรับ 'yyyy-MM-dd' เก่า (เที่ยงคืน) ให้ backward-compat กับโปรฯ ก่อน Phase 3 ด้วย
function _parseDateTime(s) {
  const str = String(s || '').trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    return isNaN(d.getTime()) ? null : d;
  }
  return _parseYMD(str);
}

// actionAdminListCampaigns — read-only. คืนโปรฯ ล่าสุด 5 รายการ + platformsSeen + baseRate
function actionAdminListCampaigns(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const sheet = ensureCampaignSchema();
  const rows = sheet.getDataRange().getValues();
  const now = new Date();
  const campaigns = [];
  for (let i = 1; i < rows.length; i++) {
    const id = String(rows[i][CFG.CAMPAIGN_ID] || '').trim();
    if (!id) continue; // แสดงเฉพาะแคมเปญที่สร้างผ่าน UI (rule เดิมที่กรอกมือไม่มี id → ไม่ยุ่ง)
    const start = rows[i][CFG.START_DATE] instanceof Date ? rows[i][CFG.START_DATE] : null;
    const end   = rows[i][CFG.END_DATE]   instanceof Date ? rows[i][CFG.END_DATE]   : null;
    const skuKeyword  = String(rows[i][CFG.SKU_KEYWORD] || '').trim();
    const platformRaw = String(rows[i][CFG.PLATFORM]    || '').trim();
    campaigns.push({
      id:                id,
      multiplier:        Number(rows[i][CFG.MULTIPLIER]) || 1,
      skus:              skuKeyword  ? skuKeyword.split(',').map(function (s) { return s.trim(); }).filter(Boolean)  : [],
      platforms:         platformRaw ? platformRaw.split(',').map(function (p) { return p.trim(); }).filter(Boolean) : [],
      startDateForInput: start ? Utilities.formatDate(start, 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm") : '',
      endDateForInput:   end   ? Utilities.formatDate(end,   'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm") : '',
      startDate:         start ? Utilities.formatDate(start, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : '',
      endDate:           end   ? Utilities.formatDate(end,   'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : 'ไม่มีวันหมด',
      note:              String(rows[i][CFG.NOTE] || ''),
      status:            _campaignStatus(start, end, now),
      _sort:             start ? start.getTime() : 0,
    });
  }
  campaigns.sort(function (a, b) { return b._sort - a._sort; });
  const top = campaigns.slice(0, CAMPAIGN_LIST_LIMIT);
  top.forEach(function (c) { delete c._sort; });
  return {
    status:        'ok',
    campaigns:     top,
    platformsSeen: _distinctOrderPlatforms(),
    baseRate:      POINTS_BASE_RATE,
    maxMultiplier: CAMPAIGN_MAX_MULTIPLIER,
  };
}

// actionAdminSaveCampaign — create (ไม่มี id) หรือ update (มี id) โปรฯ ×N ช่วงวัน-เวลา + หลายช่องทาง + หลายรุ่น SKU
function actionAdminSaveCampaign(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const mult = Math.round(Number(data && data.multiplier));
  if (!(mult >= 1 && mult <= CAMPAIGN_MAX_MULTIPLIER)) {
    return { status: 'error', code: 'badmultiplier', message: 'ตัวคูณต้องเป็น 1–' + CAMPAIGN_MAX_MULTIPLIER };
  }
  const startRaw = String((data && data.startDate) || '').trim();
  const endRaw   = String((data && data.endDate)   || '').trim();
  const start = startRaw ? _parseDateTime(startRaw) : null;
  const end   = endRaw   ? _parseDateTime(endRaw)   : null;
  if (startRaw && !start) return { status: 'error', code: 'baddate', message: 'รูปแบบวันเริ่มไม่ถูกต้อง' };
  if (endRaw   && !end)   return { status: 'error', code: 'baddate', message: 'รูปแบบวันจบไม่ถูกต้อง' };
  if (start && end && start > end) return { status: 'error', code: 'baddate', message: 'วันเริ่มต้องไม่เกินวันจบ' };
  // end ว่าง = ไม่มีวันหมด (โปรฯ ถาวร); start ว่าง = active ทันที
  const skus = String((data && data.skus) || '').split(',')
    .map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean).join(',');   // '' = ทุกสินค้า
  const platform = String((data && data.platform) || '').split(',')
    .map(function (p) { return p.trim(); }).filter(Boolean).join(',');                 // '' = ทุกช่องทาง
  const note     = String((data && data.note) || '').trim().slice(0, 120);
  const id       = String((data && data.id) || '').trim();

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
    const sheet = ensureCampaignSchema();
    if (id) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][CFG.CAMPAIGN_ID] || '').trim() === id) {
          const r = i + 1;
          sheet.getRange(r, CFG.SKU_KEYWORD + 1).setValue(skus);
          sheet.getRange(r, CFG.PLATFORM + 1).setValue(platform);
          sheet.getRange(r, CFG.MULTIPLIER + 1).setValue(mult);
          sheet.getRange(r, CFG.START_DATE + 1).setValue(start || '');
          sheet.getRange(r, CFG.END_DATE + 1).setValue(end || '');
          sheet.getRange(r, CFG.NOTE + 1).setValue(note);
          return { status: 'ok', id: id, updated: true };
        }
      }
      return { status: 'error', code: 'notfound', message: 'ไม่พบแคมเปญนี้ (อาจถูกลบไปแล้ว)' };
    }
    // create ใหม่ — flatBonus=0 (flat bonus ไม่มี UI, ใช้เฉพาะ manual rule เดิมในชีต)
    const newId = 'CMP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const row = [];
    row[CFG.SKU_KEYWORD] = skus;
    row[CFG.PLATFORM]    = platform;
    row[CFG.MULTIPLIER]  = mult;
    row[CFG.FLAT_BONUS]  = 0;
    row[CFG.START_DATE]  = start || '';
    row[CFG.END_DATE]    = end || '';
    row[CFG.NOTE]        = note;
    row[CFG.CAMPAIGN_ID] = newId;
    sheet.appendRow(row);
    return { status: 'ok', id: newId, created: true };
  } catch (err) {
    Logger.log('actionAdminSaveCampaign error: ' + err);
    return { status: 'error', code: 'exception', message: err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// actionAdminDeleteCampaign — ลบโปรฯ ตาม CampaignId
function actionAdminDeleteCampaign(data) {
  if (!isAdminOk(data && data.password)) return { status: 'error', code: 'auth' };
  const id = String((data && data.id) || '').trim();
  if (!id) return { status: 'error', code: 'noid' };
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
    const sheet = ensureCampaignSchema();
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][CFG.CAMPAIGN_ID] || '').trim() === id) {
        sheet.deleteRow(i + 1);
        return { status: 'ok' };
      }
    }
    return { status: 'error', code: 'notfound' };
  } catch (err) {
    Logger.log('actionAdminDeleteCampaign error: ' + err);
    return { status: 'error', code: 'exception', message: err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// Manual test — run in GAS editor. create → list → edit(ถาวร) → validate → delete
