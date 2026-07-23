# AAPC — ระบบสะสมแต้ม LINE (member.atipashop.com)

โปรแกรมสะสมแต้ม/ส่วนลดตามระดับสมาชิกของ atipashop บน LINE LIFF — ลูกค้ากรอกเลขออเดอร์/เลขพัสดุเพื่อสะสมแต้ม ระบบตรวจสอบกับ JSTERP (ERP หลัก) อัตโนมัติทุกคืน แล้วให้แต้ม/ส่วนลดตามระดับสมาชิก แอดมินจัดการโปรโมชั่นและคูปองผ่าน `admin.html`

## สถาปัตยกรรม

```
                 ┌─────────────────┐         ┌──────────────────┐
   ลูกค้า (LINE) │ AAPC-index.html │         │   admin.html      │  แอดมิน
                 │  (LIFF, Pages)  │         │   (Pages)         │
                 └────────┬────────┘         └─────────┬─────────┘
                          │  GAS_URL (doGet/doPost, action=...)  │
                          └───────────────┬───────────────────────┘
                                          ▼
                          ┌───────────────────────────────┐
                          │  Google Apps Script (src/*.gs) │
                          │  1 global namespace, 1 web app │
                          └───────┬───────────────┬────────┘
                                  │               │
                        Google Sheet          LINE Messaging API
                       (Data_Log, Points_      (push แจ้งเตือน)
                        Master, Order_
                        Verification, ...)
                                  ▲
                                  │ upsert คืนละครั้ง (23:30)
                     ┌────────────┴─────────────┐
                     │ Lenovo: aapc_targeted_    │
                     │ sync.py → JSTERP (Playwright) │
                     │ อยู่ใน repo Agent_team แยกต่างหาก│
                     └───────────────────────────┘
```

**บนเครื่อง (dev, repo นี้):**
```
AAPC/
  README.md            ← ไฟล์นี้
  .clasp.json           ← ผูก Script ID, rootDir=src (ใช้กับคำสั่ง clasp)
  src/                  ← โค้ด GAS ทั้งหมด แยกตาม layer (ดูตารางด้านล่าง)
  AAPC-index.html        ← หน้าลูกค้า (LIFF) — deploy ผ่าน GitHub Pages
  admin.html             ← หน้าแอดมิน — deploy ผ่าน GitHub Pages
  AAPC-tier-design-preview.html  ← mockup ออกแบบดีไซน์ tier (ไม่ผูก LIFF/GAS จริง)
```

โค้ด GAS เดิมเป็นไฟล์เดียว `AAPC-code.gs` (~1,900 บรรทัด) ถูกแยกเป็น `src/*.gs` เมื่อ 2026-07-17 (ย้ายเฉยๆ ไม่แก้ logic — ยืนยันด้วยสคริปต์ที่ diff กลับมาเท่าไฟล์เดิมทุกตัวอักษร + ฟังก์ชันครบ 56 ตัวไม่มีตกหล่น)

**สำคัญ — GAS ไม่มีระบบ import/module จริง:** ทุกไฟล์ใน `src/` ถูกรวมเป็น execution context เดียวตอนรัน (global namespace เดียวกันหมด) "layer" ที่เห็นด้านล่างคือ**ข้อตกลงการจัดระเบียบไฟล์** ไม่ใช่ boundary ทางเทคนิค — ห้ามตั้งชื่อฟังก์ชัน/ตัวแปร top-level ซ้ำกันข้ามไฟล์

## แก้เรื่องไหน → ไปไฟล์ไหน

| อยากแก้เรื่องนี้ | ไปที่ไฟล์ | หมายเหตุ |
|---|---|---|
| ระดับสมาชิก / ส่วนลด% / เกณฑ์แต้มแต่ละระดับ | `src/1_Config.gs` → `TIER_CONFIG` | จุดเดียวจบ ทั้ง LIFF/admin ดึงค่าจาก GAS สด (ไม่ hardcode) |
| อัตราแลกแต้ม (200฿=1 แต้ม) | `src/1_Config.gs` → `POINTS_BASE_RATE` | ใช้ใน `calculatePoints` + explainer ในหน้าแอดมิน |
| สูตรคิดแต้ม / ตัวคูณโปรโมชั่น / SKU bonus | `src/4_Service_Batch.gs` → `calculatePoints`, `isRuleActive` | |
| เวลาที่ตัวตรวจแต้มรันทุกวัน (ปัจจุบัน 17:00) | `src/7_Triggers.gs` → `installTriggers` | แก้แล้ว**ต้องรัน `installTriggers()` ใหม่ในตัว editor** — redeploy อย่างเดียวไม่พอ (ตัว trigger ผูกไว้ล่วงหน้าแล้ว) |
| ให้ออเดอร์ค้าง "Verifying" ได้กี่วันก่อนตัดเป็นไม่ผ่าน | `src/1_Config.gs` → `VERIFYING_TIMEOUT_MS` | ปัจจุบัน 7 วัน |
| เก็บ Order_Verification ย้อนหลังกี่วัน | `src/1_Config.gs` → `ORDER_VERIFICATION_KEEP_DAYS` | ใช้ใน `cleanOldOrders` (ทำงานทุกวันอาทิตย์ 02:00) |
| เก็บไฟล์ backup ชีตลูกค้าย้อนหลังกี่วัน | `src/1_Config.gs` → `BACKUP_KEEP_DAYS` | ใช้ใน `runDailyBackup` (ทำงานทุกวัน 02:00 → โฟลเดอร์ `AAPC_Backups` บน Drive) เก่ากว่านี้ย้ายลงถังขยะ |
| ช่องทางสั่งซื้อ (LINE/TikTok/Shopee/...) ที่โชว์ใน checkbox โปรฯ | `src/4_Service_Admin.gs` → `KNOWN_PLATFORMS`, `_distinctOrderPlatforms` | ชื่อ label ที่โชว์ในแอดมินแก้ที่ `admin.html` → `CHANNEL_LABELS` — ชื่อร้านต้อง**ตรงกับที่ JSTERP ส่งมาจริง** (คอลัมน์ `ชื่อร้านค้า`/shop_name) เช็คกับข้อมูลจริงก่อนเพิ่ม |
| โปรโมชั่น/แคมเปญ (สร้าง/แก้/ลบ) | `src/4_Service_Admin.gs` → `actionAdminSaveCampaign`/`actionAdminListCampaigns`/`actionAdminDeleteCampaign` + `admin.html` (ฟอร์ม) | |
| การแลกแต้มเป็นคูปอง / อายุคูปอง | `src/4_Service_Redeem.gs` + `src/1_Config.gs` → `REDEEM_RATE`, `COUPON_EXPIRY_DAYS` | |
| รหัสผ่านแอดมิน | Script Property `ADMIN_PASSWORD` (ไม่ใช่ในโค้ด) + `src/6_Security.gs` → `isAdminOk` | ตั้งค่าที่ Apps Script → Project Settings → Script Properties |
| ข้อความ LINE push แจ้งเตือนลูกค้า | `src/4_Service_Push.gs` → `sendPushNotifications`, `_linePush` | ต้องมี Script Property `LINE_CHANNEL_ACCESS_TOKEN` |
| เพิ่ม action/endpoint ใหม่ให้ LIFF หรือแอดมินเรียก | `src/5_Controller.gs` → `doGet`/`doPost` (routing) | ดูหัวข้อ "Wire contract" ด้านล่างก่อนเปลี่ยนชื่อ action เดิม |
| เพิ่ม/แก้คอลัมน์ในชีต (schema) | `src/3_Repository.gs` → ฟังก์ชัน `ensure*`/`setupSchema*` | เขียนให้ idempotent (เรียกซ้ำได้ไม่พัง) ตามแบบเดิม |
| Endpoint ที่ pipeline ฝั่ง Lenovo ใช้ดึง key ไปเช็ค JSTERP | `src/5_Controller.gs` → `actionGetLookupKeys` | คุมด้วย Script Property `LOOKUP_TOKEN`; ฝั่งที่เรียกอยู่ที่ repo `Agent_team` (`tools/aapc_targeted_sync.py`) คนละ repo |
| เทส | `src/9_Tests.gs` (in-GAS) + `Agent_team/test_campaign.js` (mocked, รันนอก GAS) | ดูหัวข้อ Testing |

## Layer ทั้งหมด (`src/`)

| ไฟล์ | บทบาท |
|---|---|
| `1_Config.gs` | Sheet ID, column-index map ของทุกแท็บ, ค่าคงที่ทั้งหมด (timeout, rate, cap), `TIER_CONFIG` — **ห้ามมี business logic ในไฟล์นี้** |
| `2_Utils.gs` | pure function ล้วน: `computeTier`, `tierTablePublic`, `normalizeId`, `isCancelledStatus`, `_toBangkok` — ไม่มีการเรียก `SpreadsheetApp`/API ภายนอก |
| `3_Repository.gs` | จุดเดียวที่อ่าน/สร้าง schema ของชีตโดยตรง: `setupSchemaPhase2/3`, `loadConfigPoints`, `loadOrderVerificationMap`, `ensurePointsMasterRow`, `ensureUsedByColumn` |
| `4_Service_Batch.gs` | เครื่องยนต์คิดแต้ม + batch หลัก: `isRuleActive`, `calculatePoints`, `logBatch`, `runDailyBatch`, `applyPointsDeltaAndRecomputeTiers`, `cleanOldOrders` |
| `4_Service_Redeem.gs` | แลกแต้มเป็นคูปอง: `genCouponCode`, `actionRedeem`, `actionGetCoupons` |
| `4_Service_Admin.gs` | หลังบ้านของ `admin.html`: auth, ค้นหาสมาชิก, ตรวจ/ใช้คูปอง, CRUD โปรโมชั่น, รายชื่อช่องทาง |
| `4_Service_Push.gs` | ส่ง LINE push หลัง batch รันเสร็จ |
| `4_Service_Backup.gs` | สำรองชีตลูกค้าทั้งไฟล์ลง Drive ทุกวัน: `runDailyBackup` (trigger 02:00), retention rolling `BACKUP_KEEP_DAYS` วัน, `actionAdminRunBackup` (ปุ่ม backup-now) — **ใช้ `DriveApp`** (scope ใหม่ ต้อง authorize ครั้งแรก) |
| `4_Service_System.gs` | หลังบ้านแผงควบคุม (Task Dashboard): `isPaused` (อ่าน flag), `actionAdminGetSystemStatus`, `actionAdminSetFlag` (allowlist `AAPC_SETTABLE_FLAGS` เท่านั้น), `actionAdminSetDevUserIds`, `actionAdminRunDevBatch` |
| `5_Controller.gs` | `doGet`/`doPost` routing + action สาธารณะ: getProfile, getHistory, checkDuplicate, saveOrderData, consent, getLookupKeys |
| `6_Security.gs` | ตรวจสิทธิ์แอดมิน (`isAdminOk`) — Phase 4b จะเพิ่ม `maskId()` ที่นี่สำหรับ mask PII ก่อน log |
| `7_Triggers.gs` | `installTriggers()` — ติดตั้ง time-based trigger (รันเองครั้งเดียวตอน setup หรือหลังแก้เวลา trigger) |
| `9_Tests.gs` | ฟังก์ชัน `test*()` รันจาก Apps Script editor โดยตรง (ดู Testing ด้านล่าง) |

## Deploy SOP

**ลำดับสำคัญ: แก้ GAS ก่อนเสมอ แล้วค่อย push HTML** — ถ้าสลับกัน หน้าเว็บที่เรียก action ใหม่จะเจอ `unknown action` เพราะ HTML ไปสดกว่า GAS

1. แก้โค้ดใน `src/*.gs` (ไฟล์ไหนดูตารางด้านบน)
2. รัน `node test_campaign.js` ใน repo `Agent_team` ให้ผ่านครบก่อน (ปัจจุบัน 80/80)
3. `clasp push` จากโฟลเดอร์นี้ (ต้องมี `.clasp.json` ผูก Script ID ไว้แล้ว) — **ใช้ `clasp push` เท่านั้น ห้ามใช้ `clasp deploy`** (คำสั่งนั้นจะรีเซ็ตสิทธิ์เข้าถึง web app ต้องตั้งค่าใหม่ทุกครั้ง)
4. เปิด Apps Script editor เช็คว่าไฟล์ครบตามที่ push ไป, รัน `test*()` ที่เกี่ยวข้องดู Logger
5. Deploy → Manage deployments → ปุ่มดินสอ ✏️ ที่ deployment เดิม → เลือก **New version** → Deploy (URL `/exec` เดิมไม่เปลี่ยน)
6. Smoke test: `curl -L "GAS_URL?action=getProfile&userId=NON_EXISTENT_USER_XX"` เช็ค response ตรงตามที่แก้
7. Commit + push `AAPC-index.html`/`admin.html` (ถ้าแก้) ขึ้น GitHub Pages (~90 วินาทีถึงจะขึ้นจริง) — เช็ค md5 `member.atipashop.com/...` ตรงกับไฟล์ที่ commit

**Rollback:** Deploy → Manage deployments → แก้ deployment เดิม → เปลี่ยน dropdown "Version" กลับไปเวอร์ชันก่อนหน้า → Deploy (ประวัติทุกเวอร์ชันเก็บไว้ให้เลือกอยู่แล้ว ไม่ต้องเขียนโค้ดย้อนกลับ)

## Dev / Staging environment (พัฒนา/เทสขณะ LIFF live — ADR-021)

เทส full flow ได้โดย push/แต้มเด้ง **เฉพาะ Dev** ไม่แตะลูกค้าจริง (ข้อมูลเทสเขียนชีต prod เดิม + allowlist)

- **Backend:** `runBatchDevTest()` (`4_Service_Batch.gs`) อ่าน Script Property `DEV_USER_IDS` → รัน batch แบบ dev-only. prod trigger เรียก `runDailyBatch()` เปล่าตามเดิม (opts undefined = prod). **ห้ามผูก trigger กับ `runBatchDevTest`**
- **Front-end:** `AAPC-index.html` มี `?env=dev` → ใช้ DEV LIFF + DEV GAS. ไม่มี param = prod เป๊ะ
- **DEV GAS deployment:** `AKfycby4Fpz...` (versioned, public เพราะ appsscript.json = ANYONE_ANONYMOUS) · **DEV LIFF** `2010758448-JNGHoJCZ` (provider `atipa`) endpoint = `member.atipashop.com/AAPC-index.html?env=dev`
- **รอบพัฒนา:** แก้ backend → `clasp push` (HEAD, prod `/exec` ไม่ขยับ) → รัน `runBatchDevTest()` ใน editor. แก้ front-end → branch `dev` → merge `main` (Pages เสิร์ฟ env-switch, inert สำหรับลูกค้า). ให้ DEV LIFF เห็น backend ใหม่ → `clasp deploy -i <DEV_deploymentId>` bump (prod นิ่ง)
- **ข้อยกเว้น clasp deploy:** กฎ "ห้าม `clasp deploy`" ด้านบนคุ้มครอง **prod** deployment (รีเซ็ต access) — dev deployment เป็นตัวแยก สร้าง/bump ด้วย clasp deploy ได้ (ANYONE_ANONYMOUS auto)

## Testing

- **`Agent_team/test_campaign.js`** — mocked-GAS harness รันนอก GAS จริง (`node test_campaign.js`) ไม่แตะชีต/เครือข่ายจริง โหลดโค้ดจาก `src/*.gs` เข้า vm sandbox แล้วจำลอง `SpreadsheetApp`/`PropertiesService`/`LockService` เอง ครอบ: engine คิดแต้ม, tier boundary, campaign CRUD, ช่องทาง — ก่อน push ทุกครั้งต้องผ่านครบ
- **`src/9_Tests.gs`** — ฟังก์ชัน `test*()` รันจาก Apps Script editor โดยตรง ใช้ทดสอบกับชีตจริง (ระวัง: บางตัวเช่น `testRedeem`/`testSave` จะทิ้งแถวทดสอบไว้ในชีตจริง ตามที่ log แจ้งไว้ในตัวฟังก์ชัน — ลบเองถ้าต้องการความสะอาด)

## ข้อจำกัดของ Google Apps Script ที่ต้องรู้ก่อนแก้โค้ด

- **จำกัดเวลารันต่อครั้ง 6 นาที** — `runDailyBatch` มี `TIME_BUDGET_MS` (เหลือ buffer 1 นาที) คอยตัดออกก่อนชนลิมิต ถ้าข้อมูลเยอะขึ้นเรื่อยๆ ให้ดูค่านี้
- **Trigger ผูกกับ "ชื่อฟังก์ชัน" เป็น string** — ห้ามเปลี่ยนชื่อ `runDailyBatch`/`cleanOldOrders` โดยไม่ไปแก้/รัน `installTriggers()` ใหม่ ไม่งั้น trigger เดิมจะหาไม่เจอเงียบๆ
- **`LockService.getScriptLock()` เป็น lock ระดับทั้งโปรเจกต์** ไม่ใช่ per-resource — งานเขียนพร้อมกัน (เช่น 2 แอดมินกดใช้คูปองพร้อมกัน) จะรอคิวกันเป็นระยะสั้นๆ ตามดีไซน์ ไม่ใช่บั๊ก
- **ไม่มี module/import จริง** — ทุกไฟล์ใน `src/` compile รวมเป็น context เดียว ชื่อ top-level (function/const) ต้องไม่ซ้ำกันข้ามไฟล์

## Wire contract — สิ่งที่ห้ามเปลี่ยนโดยไม่เช็คก่อน

ชื่อ `action` และ shape ของ JSON response มีผู้ใช้งานอยู่ **นอก repo นี้ 3 จุด** ถ้าจะเปลี่ยนชื่อ field หรือชื่อ action ต้องไล่เช็ค/แก้ทั้ง 3 จุดพร้อมกัน:

1. **`AAPC-index.html`** (LIFF, repo นี้) — เรียกผ่าน `GAS_URL`; รับ `{status:'error', code:'maintenance', message}` เมื่อ intake/redeem ถูกพัก (แสดง `message` ให้ลูกค้า)
2. **`admin.html`** (repo นี้) — เรียกผ่าน `GAS_URL` เดียวกัน
3. **`Agent_team/tools/aapc_targeted_sync.py`** (คนละ repo, รันบนเครื่อง Lenovo) — เรียก `action=getLookupKeys` ทุกคืน 23:30 ด้วย `LOOKUP_TOKEN`
4. **Task Dashboard** (`Agent_team/tools/task_dashboard/`, เครื่อง Lenovo) — proxy ไป doPost `type` ใหม่: `adminGetSystemStatus`, `adminSetFlag`, `adminSetDevUserIds`, `adminRunDevBatch`, `adminRunBackup` (ทุกตัวแนบ `password` = Script Property `ADMIN_PASSWORD`)

## Script Properties ที่ต้องตั้งไว้ (Apps Script → Project Settings → Script Properties)

| ชื่อ | ใช้ทำอะไร |
|---|---|
| `ADMIN_PASSWORD` | รหัสผ่านเข้า `admin.html` |
| `LINE_CHANNEL_ACCESS_TOKEN` | ส่ง LINE push แจ้งเตือนลูกค้า |
| `LOOKUP_TOKEN` | คุม endpoint `getLookupKeys` ที่ pipeline ฝั่ง Lenovo เรียก |
| `DEV_USER_IDS` | userId (คั่น comma) ที่ `runBatchDevTest()` จะ process+push เฉพาะกลุ่มนี้ — ใช้เทส dev บนชีต prod โดยไม่แตะลูกค้า (ดู Dev/Staging ด้านล่าง) |
| `AAPC_BACKUP_FOLDER_ID` | **ตั้งอัตโนมัติ** โดย `runDailyBackup` (id โฟลเดอร์ `AAPC_Backups` บน Drive) — ไม่ต้องตั้งเอง; ลบทิ้งได้ถ้าอยากให้สร้างโฟลเดอร์ใหม่ |
| `AAPC_LAST_BACKUP` | **ตั้งอัตโนมัติ** — JSON `{at,name,kept}` ของ backup ล่าสุด (แผงควบคุมอ่านไปโชว์สถานะ) |
| `AAPC_PAUSE_BATCH` / `AAPC_PAUSE_PUSH` / `AAPC_PAUSE_INTAKE` / `AAPC_PAUSE_REDEEM` | **คุมผ่านแผงควบคุม** (`actionAdminSetFlag`) — ค่า `'1'` = พักส่วนนั้น, ไม่มี key = ทำงานปกติ (fail-open). อย่าตั้งมือถ้าไม่จำเป็น; เปิด/ปิดจาก Task Dashboard สะดวกกว่า |

## Sheet ที่ใช้ (Google Sheet ID: ดู `AAPC_SHEET_ID` ใน `src/1_Config.gs`)

`Data_Log`, `Points_Master`, `Order_Verification`, `Config_Points`, `Batch_Log`, `Redemptions`, `Consent` — คอลัมน์แต่ละแท็บดูที่ column-index map ใน `1_Config.gs` (เช่น `COL`, `PM`, `OV`, `CFG`, `BL`, `RD`, `CN`)
