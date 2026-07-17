// 9_Tests.gs — In-GAS test functions (run manually from the Apps Script editor).
// Split from the former monolithic AAPC-code.gs (move-only, 2026-07-17). See ../README.md.

function testAdminCampaign() {
  const pwd = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'SET_ME';
  Logger.log('0) wrong pwd → '  + JSON.stringify(actionAdminListCampaigns({ password: 'WRONG' })));
  const save = actionAdminSaveCampaign({
    password: pwd, multiplier: 2, platform: 'ATIPASHOP,Tiktok', skus: 'ATP-00270',
    startDate: '2026-07-06T19:00', endDate: '2026-07-06T21:00', note: 'TEST ไลฟ์ LINE+TikTok',
  });
  Logger.log('1) create ×2 LINE+TikTok, SKU ATP-00270, 19:00-21:00 → ' + JSON.stringify(save));
  const id = save.id;
  Logger.log('2) list → ' + JSON.stringify(actionAdminListCampaigns({ password: pwd })));
  Logger.log('3) edit ×3 LINE-only, ไม่จำกัดรุ่น, ไม่มีวันหมด (ถาวร) → ' + JSON.stringify(actionAdminSaveCampaign({
    password: pwd, id: id, multiplier: 3, platform: 'ATIPASHOP', skus: '',
    startDate: '2026-07-06T19:00', endDate: '', note: 'TEST ถาวร LINE',
  })));
  Logger.log('4) bad multiplier 99 (cap=' + CAMPAIGN_MAX_MULTIPLIER + ') → ' + JSON.stringify(actionAdminSaveCampaign({
    password: pwd, multiplier: 99, startDate: '2026-07-06T19:00', endDate: '2026-07-06T21:00', note: 'x',
  })));
  Logger.log('5) bad date start>end → ' + JSON.stringify(actionAdminSaveCampaign({
    password: pwd, multiplier: 2, startDate: '2026-07-10T00:00', endDate: '2026-07-08T00:00', note: 'x',
  })));
  Logger.log('6) delete → ' + JSON.stringify(actionAdminDeleteCampaign({ password: pwd, id: id })));
  Logger.log('7) list after delete → ' + JSON.stringify(actionAdminListCampaigns({ password: pwd })));
  Logger.log('คาดหวัง: 0=auth, 1=ok+id, 2=มี 1 อัน status active/upcoming skus=[ATP-00270] platforms=[ATIPASHOP,Tiktok], 3=ok updated endDate=ไม่มีวันหมด, 4=badmultiplier, 5=baddate, 6=ok, 7=ไม่มี test row เหลือ');
}

// Manual test — run in GAS editor. Creates a test coupon, looks it up, uses it, re-looks-up.
function testAdminCoupon() {
  const TEST_USER = 'Uadmintest001';
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  // seed redeemable balance so actionRedeem succeeds
  const pm = ss.getSheetByName(SHEET_POINTS);
  let found = false;
  const pmData = pm.getDataRange().getValues();
  for (let i = 1; i < pmData.length; i++) {
    if (String(pmData[i][PM.USER_ID]) === TEST_USER) {
      pm.getRange(i + 1, PM.REDEEMABLE_POINTS + 1).setValue(100); found = true; break;
    }
  }
  if (!found) pm.appendRow([TEST_USER, 'Admin Test', 100, 100, 'เงิน', new Date()]);

  const pwd = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'SET_ME';
  const issued = actionRedeem({ userId: TEST_USER, displayName: 'Admin Test', units: 1, requestId: 'test-' + Date.now() });
  Logger.log('1) redeem → ' + JSON.stringify(issued));
  const code = issued.coupon && issued.coupon.code;

  Logger.log('2) lookup(valid) → ' + JSON.stringify(actionAdminLookup({ password: pwd, code: code })));
  Logger.log('3) lookup(wrong pwd) → ' + JSON.stringify(actionAdminLookup({ password: 'WRONG', code: code })));
  Logger.log('4) use → ' + JSON.stringify(actionAdminUseCoupon({ password: pwd, code: code, orderId: 'TEST-ORDER-99', adminName: 'ทดสอบ' })));
  Logger.log('5) lookup(after use) → ' + JSON.stringify(actionAdminLookup({ password: pwd, code: code })));
  Logger.log('6) use again (should be used) → ' + JSON.stringify(actionAdminUseCoupon({ password: pwd, code: code, orderId: 'TEST-ORDER-XX', adminName: 'ทดสอบ2' })));
}

// Manual test — run in GAS editor. Seeds a test member, then exercises adminMemberSearch.
function testAdminMemberSearch() {
  const TEST_USER = 'Umembersearch001';
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  const pm = ss.getSheetByName(SHEET_POINTS);
  let found = false;
  const pmData = pm.getDataRange().getValues();
  for (let i = 1; i < pmData.length; i++) {
    if (String(pmData[i][PM.USER_ID]) === TEST_USER) { found = true; break; }
  }
  if (!found) pm.appendRow([TEST_USER, 'ทดสอบค้นหา Search-Tester', 650, 200, 'ทอง', new Date()]);

  const pwd = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'SET_ME';
  Logger.log('1) wrong pwd → '      + JSON.stringify(actionAdminMemberSearch({ password: 'WRONG', query: 'ทดสอบ' })));
  Logger.log('2) short query → '    + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'ท' })));
  Logger.log('3) thai partial → '   + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'ทดสอบค้น' })));
  Logger.log('4) latin any-case → ' + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'search-tester' })));
  Logger.log('5) not found → '      + JSON.stringify(actionAdminMemberSearch({ password: pwd, query: 'zzz_no_such_name' })));
  Logger.log('คาดหวัง: 3) และ 4) เจอสมาชิก tierKey=gold, discountPct=10 · NOTE: test row uid=' + TEST_USER + ' ค้างใน Points_Master — ลบเองถ้าต้องการ');
}

// ─── Tests ────────────────────────────────────────────────────────────────────
// testTierConfig — เช็ค boundary ทุกจุดว่า computeTier ให้ผลเหมือนโค้ดเดิม + field ใหม่ครบ
function testTierConfig() {
  function chk(pts, tier, next, toNext) {
    const r = computeTier(pts);
    const ok = r.tier === tier && r.nextTier === next && r.pointsToNext === toNext &&
               typeof r.key === 'string' && typeof r.discountPct === 'number';
    Logger.log((ok ? '✓ ' : '✗ ') + pts + ' → ' + JSON.stringify(r));
  }
  chk(0,    'เงิน', 'ทอง',  500);
  chk(499,  'เงิน', 'ทอง',  1);
  chk(500,  'ทอง',  'เพชร', 500);
  chk(999,  'ทอง',  'เพชร', 1);
  chk(1000, 'เพชร', 'VVIP', 1000);
  chk(1999, 'เพชร', 'VVIP', 1);
  chk(2000, 'VVIP', null,   0);
  chk(5000, 'VVIP', null,   0);
  chk(-5,   'เงิน', 'ทอง',  505); // negative input — พฤติกรรมเดิม
  Logger.log('tierTablePublic → ' + JSON.stringify(tierTablePublic()));
  Logger.log('fallback profile → ' + JSON.stringify(actionGetProfile('NON_EXISTENT_USER_XX')));
}

function testCalculatePoints() {
  // Helper: assert
  function assertEq(actual, expected, label) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) Logger.log('✓ ' + label);
    else Logger.log('✗ ' + label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
  const today = new Date(2026, 4, 14); // 2026-05-14 (month 0-indexed)

  // Cases
  const rules = [];
  assertEq(calculatePoints(99,   [], '', today, rules).points, 0,  '99฿ → 0');
  assertEq(calculatePoints(200,  [], '', today, rules).points, 1,  '200฿ → 1');
  assertEq(calculatePoints(399,  [], '', today, rules).points, 1,  '399฿ → 1 (floor)');
  assertEq(calculatePoints(400,  [], '', today, rules).points, 2,  '400฿ → 2');
  assertEq(calculatePoints(1000, [], '', today, rules).points, 5,  '1000฿ → 5');

  // SKU bonus (prefix)
  const rulesSku = [{ skuKeyword:'ATP-12345', platform:'', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'SKU promo' }];
  assertEq(calculatePoints(1000, ['ATP-12345-XX'], '', today, rulesSku).points, 10, '1000฿ + SKU×2 → 10');
  assertEq(calculatePoints(1000, ['ATP-99999-XX'], '', today, rulesSku).points, 5,  '1000฿ + non-match SKU → 5');

  // Campaign
  const rulesCamp = [{ skuKeyword:'', platform:'', multiplier:3, flatBonus:0, startDate:null, endDate:null, note:'Double Weekend' }];
  assertEq(calculatePoints(1000, [], '', today, rulesCamp).points, 15, '1000฿ + Campaign×3 → 15');

  // SKU×2 + Campaign×3 = max wins (×3)
  const rulesBoth = rulesSku.concat(rulesCamp);
  assertEq(calculatePoints(1000, ['ATP-12345-XX'], '', today, rulesBoth).points, 15, '1000฿ + SKU×2 + Camp×3 → 15 (max)');

  // Flat bonus
  const rulesFlat = [{ skuKeyword:'ATP-77777', platform:'', multiplier:1, flatBonus:5, startDate:null, endDate:null, note:'Flat +5' }];
  assertEq(calculatePoints(200, ['ATP-77777-AA'], '', today, rulesFlat).points, 6, '200฿ + flat +5 → 6');

  // Mix: ×2 SKU + flat +5 from another SKU
  const rulesMix = [
    { skuKeyword:'ATP-12345', platform:'', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'×2' },
    { skuKeyword:'ATP-77777', platform:'', multiplier:1, flatBonus:5, startDate:null, endDate:null, note:'+5' },
  ];
  assertEq(calculatePoints(1000, ['ATP-12345-XX','ATP-77777-AA'], '', today, rulesMix).points, 15, '1000฿ + ×2 + flat+5 → 15');

  // Platform LINE bonus
  const rulesLine = [{ skuKeyword:'', platform:'LINE', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'LINE x2' }];
  assertEq(calculatePoints(1000, [], 'LINE', today, rulesLine).points, 10, '1000฿ + LINE×2 → 10');
  assertEq(calculatePoints(1000, [], 'TikTok', today, rulesLine).points, 5, '1000฿ on TikTok (no LINE bonus) → 5');

  // Phase 3: datetime window (เจาะชั่วโมง)
  const liveStart = new Date(2026, 6, 6, 19, 0);
  const liveEnd   = new Date(2026, 6, 6, 21, 0);
  const rulesLive = [{ skuKeyword:'', platform:'', multiplier:3, flatBonus:0, startDate:liveStart, endDate:liveEnd, note:'Live 19-21' }];
  assertEq(calculatePoints(1000, [], '', new Date(2026, 6, 6, 20, 0), rulesLive).points, 15, 'live window 20:00 (in) → 15');
  assertEq(calculatePoints(1000, [], '', new Date(2026, 6, 6, 22, 0), rulesLive).points, 5,  'live window 22:00 (out, after end) → 5');
  assertEq(calculatePoints(1000, [], '', new Date(2026, 6, 6, 18, 0), rulesLive).points, 5,  'live window 18:00 (out, before start) → 5');

  // Phase 3: end ว่าง = ไม่มีวันหมด (โปรฯ ถาวร)
  const rulesForever = [{ skuKeyword:'', platform:'ATIPASHOP', multiplier:2, flatBonus:0, startDate:new Date(2026, 0, 1), endDate:null, note:'LINE forever' }];
  assertEq(calculatePoints(1000, [], 'ATIPASHOP', new Date(2030, 0, 1), rulesForever).points, 10, 'no-end campaign ยัง active ในอนาคตไกล → 10');

  // Phase 3: multi-family SKU (comma-separated, boundary-safe — กัน over-match)
  const rulesMultiSku = [{ skuKeyword:'ATP-00270,ATP-00350', platform:'', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'2 families' }];
  assertEq(calculatePoints(1000, ['ATP-00350-6'],   '', today, rulesMultiSku).points, 10, 'multi-family match รุ่นที่ 2 (ATP-00350-6) → 10');
  assertEq(calculatePoints(1000, ['ATP-002700-9'],  '', today, rulesMultiSku).points, 5,  'multi-family ไม่ over-match (ATP-002700-9 ≠ family ATP-00270) → 5');

  // Phase 3: multi-channel (comma-separated, membership test)
  const rulesMultiChannel = [{ skuKeyword:'', platform:'ATIPASHOP,TIKTOK', multiplier:2, flatBonus:0, startDate:null, endDate:null, note:'LINE+TikTok' }];
  assertEq(calculatePoints(1000, [], 'ATIPASHOP', today, rulesMultiChannel).points, 10, 'multi-channel match LINE → 10');
  assertEq(calculatePoints(1000, [], 'TIKTOK',    today, rulesMultiChannel).points, 10, 'multi-channel match TikTok → 10');
  assertEq(calculatePoints(1000, [], 'SHOPEE',    today, rulesMultiChannel).points, 5,  'multi-channel ไม่ match Shopee (ไม่อยู่ในลิสต์) → 5');

  Logger.log('testCalculatePoints done');
}

function testSave() {
  saveOrderData({
    userId:         'TEST_' + Date.now(),
    displayName:    'Manual Test',
    orderId:        'ord-test-001',  // will be uppercased
    trackingNumber: ' th9999 ',       // will be trimmed + uppercased
    pictureUrl:     '',
  });
  Logger.log('testSave done');
}

function testRedeem() {
  const ss = SpreadsheetApp.openById(AAPC_SHEET_ID);
  setupSchemaPhase3();
  const uid = 'TEST_REDEEM_' + Date.now();
  const pm = ss.getSheetByName(SHEET_POINTS);
  // seed user: TierPoints=300, RedeemablePoints=120
  pm.appendRow([uid, 'Redeem Tester', 300, 120, computeTier(300).tier, new Date()]);

  function log(ok, label) { Logger.log((ok ? '✓ ' : '✗ ') + label); }

  // 1. insufficient — 3 units = 150 > 120
  let r = actionRedeem({ type: 'redeem', userId: uid, units: 3, requestId: '' });
  log(r.status === 'error', 'insufficient balance rejected');

  // 2. success — 2 units = 100 <= 120, code format ATIPA-XXXX-XXXX
  const req = 'REQ_' + Date.now();
  r = actionRedeem({ type: 'redeem', userId: uid, displayName: 'Redeem Tester', units: 2, requestId: req });
  log(r.status === 'success' && r.coupon && /^ATIPA-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.coupon.code), 'redeem success + code format (' + (r.coupon && r.coupon.code) + ')');
  log(r.redeemable === 20, 'redeemable 120 → 20 (got ' + r.redeemable + ')');

  // 3. idempotent — same requestId returns same coupon, no extra deduction
  const code1 = r.coupon.code;
  const r2 = actionRedeem({ type: 'redeem', userId: uid, units: 2, requestId: req });
  log(r2.status === 'success' && r2.duplicate === true && r2.coupon.code === code1, 'idempotent on requestId');

  // 4. TierPoints unchanged (still 300)
  const pmData = pm.getDataRange().getValues();
  let tierOk = false;
  for (let i = 1; i < pmData.length; i++) {
    if (String(pmData[i][PM.USER_ID]) === uid) tierOk = Number(pmData[i][PM.TIER_POINTS]) === 300;
  }
  log(tierOk, 'TierPoints unchanged (300)');

  // 5. getCoupons returns the 1 issued coupon
  const gc = actionGetCoupons(uid);
  log(gc.coupons.length === 1, 'getCoupons returns 1 coupon');

  // 6. consent lifecycle
  log(actionGetConsent(uid).consented === false, 'consent initially false');
  actionSetConsent({ userId: uid, displayName: 'Redeem Tester', version: CONSENT_VERSION });
  log(actionGetConsent(uid).consented === true, 'consent set true');

  Logger.log('testRedeem done — NOTE: leaves test rows (uid=' + uid + ') in Points_Master / Redemptions / Data_Log / Consent. ลบเองถ้าต้องการ.');
}
