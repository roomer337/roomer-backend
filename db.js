// 루머 ROOMER 백엔드 - DB 초기화 (SQLite, 실서비스에서는 PostgreSQL로 교체)
const Database = require('better-sqlite3');
// 신규(사용자요청 — DB 영속성 점검): Render에 Persistent Disk를 마운트하면 DB_PATH 환경변수로
// 그 마운트 경로(예: /data/roomer.db)를 지정만 하면 재배포시에도 데이터가 유지됨.
// 환경변수가 없으면 기존과 동일하게 상대경로 사용(로컬 개발 호환).
const db = new Database(process.env.DB_PATH || 'roomer.db');

db.pragma('foreign_keys = ON');
// 신규(2026-09-18 전수조사 — 치명): journal_mode가 SQLite 기본값 'delete'(롤백 저널)로 돌고 있었다.
// 롤백 저널은 커밋마다 저널파일 생성→쓰기→fsync→삭제→디렉터리 fsync를 반복하고, 읽기와 쓰기가
// 서로를 완전히 배타 잠금한다. 실측 결과 같은 스키마에서 INSERT 1건 비용이
//   delete 방식 0.644ms  vs  WAL 방식 0.024ms  — 약 27배 차이였다.
// 이 서버는 모든 요청마다 request_logs에 INSERT를 하므로 요청 1건당 최소 0.6ms를 디스크 대기로
// 버리고 있었고(Render의 네트워크 연결 디스크에서는 더 나쁨), 백업(VACUUM INTO)이나 긴 SELECT가
// 도는 동안에는 모든 쓰기가 통째로 막혔다.
// → WAL로 전환. synchronous=NORMAL은 WAL에서 권장되는 안전한 조합이다(전원 차단 시에도 DB가
//   깨지지 않고, 마지막 몇 건의 트랜잭션만 손실될 수 있는 수준).
// 주의: WAL은 DB 파일 옆에 -wal, -shm 파일을 만든다. DB_PATH가 영구 디스크(/var/data) 위에
//      있어야 이 파일들도 함께 보존된다(server.js 부팅 로그의 [DB위치] 항목으로 확인 가능).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('wal_autocheckpoint = 1000');

// ===== 신규(강남언니 벤치마킹 검토 후속 — 1단계: 민감정보 암호화) =====
// users.phone, partners.phone/business_reg_number/ceo_name/applicant_name,
// partner_identity_verifications.phone/applicant_name 처럼 실명·연락처·사업자번호에 해당하는
// 컬럼을 DB 파일에 평문으로 저장하지 않고 AES-256-GCM으로 암호화해서 저장한다.
// 주의(운영 배포 필수): PII_ENCRYPTION_KEY 환경변수(64자리 hex = 32바이트)가 반드시 필요하다.
// JWT_SECRET과 동일한 패턴으로, 없으면 개발용 고정키로 동작하되 운영환경(NODE_ENV=production)에서는
// 서버 시작 자체를 막는다 — 약한 키로 조용히 암호화하다가 나중에 키를 잃어버리는 사고를 방지하기 위함.
const crypto = require('crypto');
const PII_KEY_HEX = process.env.PII_ENCRYPTION_KEY || (process.env.NODE_ENV === 'production' ? null : '00'.repeat(32));
if (!PII_KEY_HEX) throw new Error('운영환경에서는 PII_ENCRYPTION_KEY 환경변수(64자리 hex, 32바이트)가 반드시 필요합니다.');
if (!process.env.PII_ENCRYPTION_KEY) {
  console.warn('⚠️  경고: PII_ENCRYPTION_KEY 환경변수가 설정되지 않아 개발용 기본키를 사용 중입니다. ' +
    '배포 전 반드시 강력한 랜덤 키로 설정하세요(생성 예: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))").');
}
const PII_KEY = Buffer.from(PII_KEY_HEX, 'hex');
if (PII_KEY.length !== 32) throw new Error('PII_ENCRYPTION_KEY는 32바이트(64자리 hex 문자열)여야 합니다.');

const PII_ENC_PREFIX = 'encv1:'; // 이 접두사가 없는 값은 "아직 암호화되지 않은 평문"으로 간주(마이그레이션 전 기존 데이터·테스트 시드와 호환)
function encryptPii(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const text = String(plaintext);
  if (text === '') return text; // 빈 문자열은 암호화 오버헤드 없이 그대로 저장
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PII_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PII_ENC_PREFIX + Buffer.concat([iv, authTag, encrypted]).toString('base64');
}
function decryptPii(value) {
  if (typeof value !== 'string' || !value.startsWith(PII_ENC_PREFIX)) return value; // 평문·null·undefined는 그대로 반환
  try {
    const raw = Buffer.from(value.slice(PII_ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12), authTag = raw.subarray(12, 28), ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', PII_KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[PII 복호화 실패] 키가 바뀌었거나 데이터가 손상되었을 수 있습니다:', e.message);
    return null; // 잘못된 값을 그대로 노출하지 않고 안전하게 null 반환
  }
}
// SELECT 결과 행(row)에 아래 컬럼명이 있으면 자동으로 복호화한다. 컬럼명 기준이라 어느 테이블의
// SELECT든(users/partners/partner_identity_verifications 등) 자동으로 적용되고, 값이 평문이면
// decryptPii()가 그대로 통과시키므로 아직 암호화 전인 기존 데이터도 안전하다.
const PII_FIELDS = ['phone', 'business_reg_number', 'ceo_name', 'applicant_name'];
function decryptPiiRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const f of PII_FIELDS) { if (f in row) row[f] = decryptPii(row[f]); }
  return row;
}
function decryptPiiRows(rows) { if (Array.isArray(rows)) rows.forEach(decryptPiiRow); return rows; }

// db.prepare()가 반환하는 Statement의 .get()/.all()만 감싸서 자동 복호화한다. 이렇게 하면 기존에
// 흩어진 수십 곳의 SELECT 호출부를 하나하나 고치지 않아도 항상 복호화된 값을 받는다.
// (반대로 INSERT/UPDATE로 값을 "쓸" 때는 SQL 텍스트만으로 어떤 ? 파라미터가 어떤 컬럼인지 확실히
// 알 수 없어 자동화가 위험하므로, 각 저장 지점에서 db.encryptPii()를 직접 호출하도록 남겨둔다.)
const _originalPrepare = db.prepare.bind(db);
db.prepare = function (sql) {
  const stmt = _originalPrepare(sql);
  const originalGet = stmt.get.bind(stmt);
  const originalAll = stmt.all.bind(stmt);
  stmt.get = (...args) => decryptPiiRow(originalGet(...args));
  stmt.all = (...args) => decryptPiiRows(originalAll(...args));
  return stmt;
};
db.encryptPii = encryptPii;
db.decryptPii = decryptPii;

// ===== 신규(2026-09-18): 개인정보 검색용 블라인드 인덱스 =====
// [왜 필요한가] 전화번호·사업자번호는 AES-GCM으로 암호화해 저장하는데, 이 방식은 같은 값이라도
// 저장할 때마다 다른 암호문이 되므로 SQL의 WHERE로는 찾을 수 없다. 그래서 관리자 회원검색이
// "테이블 전체를 메모리에 올려 전원의 개인정보를 복호화한 뒤 JS에서 거르는" 구조였고, 회원이
// 10만 명이면 20건을 보려고 40만 번 복호화 + 약 100MB 힙을 쓰다가 512MB 서버가 죽을 수 있었다.
// [해결] 검색 전용 해시(블라인드 인덱스) 컬럼을 따로 둔다. 암호화 키로 HMAC-SHA256을 계산하므로
// 키를 모르면 해시에서 원문을 되돌리거나 사전공격으로 맞춰볼 수 없고(단순 SHA256과 다른 점),
// 같은 입력은 항상 같은 해시가 나와 SQL WHERE + 인덱스로 즉시 찾을 수 있다.
// [한계] 정확히 일치하는 값만 찾을 수 있다(부분검색 불가). 관리자 화면의 전화번호·사업자번호
// 검색은 전체 번호를 입력하는 용도라 실사용에 문제가 없다. 상호명·닉네임·이메일은 암호화
// 대상이 아니므로 종전처럼 부분검색이 된다.
const PII_INDEX_KEY = crypto.createHmac('sha256', PII_KEY).update('roomer-blind-index-v1').digest();
function piiIndex(value) {
  if (value === null || value === undefined) return null;
  // 전화번호/사업자번호는 하이픈·공백 표기가 제각각이라 숫자만 남겨 정규화한 뒤 해시한다.
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  return crypto.createHmac('sha256', PII_INDEX_KEY).update(digits).digest('hex');
}
db.piiIndex = piiIndex;


db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  social_provider TEXT NOT NULL,
  social_id TEXT NOT NULL,
  nickname TEXT,
  email TEXT,
  phone TEXT,
  region TEXT,
  cash_balance INTEGER DEFAULT 0,
  consent_marketing INTEGER DEFAULT 0,
  consent_location INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  withdrawn_at TEXT,
  UNIQUE(social_provider, social_id)
);

CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  login_provider TEXT,
  login_id TEXT,
  business_name TEXT NOT NULL,
  business_reg_number TEXT NOT NULL,
  license_number TEXT,
  ceo_name TEXT,
  address TEXT,
  tier TEXT NOT NULL,
  region TEXT,
  years_experience INTEGER DEFAULT 0,
  rating REAL,
  contracts_count INTEGER DEFAULT 0,
  reviews_count INTEGER DEFAULT 0,
  credit_balance INTEGER DEFAULT 0,
  doc_image_url TEXT,
  ext_image_url TEXT,
  int_image_url TEXT,
  verify_status TEXT DEFAULT 'pending',
  reject_reason TEXT,
  cert_license INTEGER DEFAULT 0,
  cert_business INTEGER DEFAULT 0,
  cert_location INTEGER DEFAULT 0,
  cert_contact INTEGER DEFAULT 0,
  cert_completed INTEGER DEFAULT 0,
  cert_recommended INTEGER DEFAULT 0,
  -- 신규(사용자요청 — 2단계: 가입폼 확장): 입력값이 곧 상세페이지 콘텐츠가 되도록 추가한 필드
  intro TEXT,
  strength_tags TEXT,
  portfolio_images TEXT,
  available_hours TEXT,
  space_categories TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT,
  UNIQUE(login_provider, login_id)
);

-- 사업장 주소와 별도로 파트너가 실제 공사 가능한 활동지역을 최대 5개까지 저장한다.
-- 기존 partners.region은 대표 활동지역 호환 필드로 계속 유지한다.
CREATE TABLE IF NOT EXISTS partner_service_regions (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  region_code TEXT NOT NULL,
  sido TEXT NOT NULL,
  sigungu TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(partner_id, region_code)
);

CREATE TABLE IF NOT EXISTS partner_identity_verifications (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_verification_id TEXT NOT NULL UNIQUE,
  applicant_name TEXT,
  phone TEXT,
  ci_hash TEXT,
  status TEXT NOT NULL DEFAULT 'prepared',
  verified_at TEXT,
  consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partner_verification_consents (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  agreed_at TEXT NOT NULL,
  UNIQUE(partner_id, consent_type, policy_version)
);

-- 신규(2026-09, 완공사례 피드 운영검수 게이트): 등록 즉시 소비자 피드에 노출되던 것을,
-- 운영자가 승인해야만 노출되도록 변경(관리자 콘솔 "완공검수 승인" 화면이 이 큐를 본다).
CREATE TABLE IF NOT EXISTS portfolio_projects (
  id TEXT PRIMARY KEY,
  partner_id TEXT REFERENCES partners(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_photos (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES portfolio_projects(id),
  image_url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stored_files (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  public_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  retention_until TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stored_files_owner ON stored_files(owner_type, owner_id, purpose);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  partner_id TEXT REFERENCES partners(id),
  category TEXT,
  region TEXT,
  image_url TEXT,
  ai_inspection_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  partner_id TEXT REFERENCES partners(id),
  address TEXT,
  pyeong INTEGER,
  space_type TEXT,
  status TEXT DEFAULT 'requested',
  estimated_amount INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES quote_requests(id),
  partner_id TEXT REFERENCES partners(id),
  type TEXT DEFAULT 'initial',
  pyeong INTEGER,
  total_amount INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  parent_quote_id TEXT REFERENCES quotes(id),
  status TEXT NOT NULL DEFAULT 'sent',
  viewed_at TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  revision_requested_at TEXT,
  expires_at TEXT,
  sent_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_decisions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  actor_role TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quote_decisions_quote ON quote_decisions(quote_id,created_at,id);

CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT REFERENCES quotes(id),
  phase_label TEXT,
  item_name TEXT NOT NULL,
  price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  quote_id TEXT REFERENCES quotes(id),
  consumer_id TEXT REFERENCES users(id),
  partner_id TEXT REFERENCES partners(id),
  fee_rate_snapshot REAL NOT NULL,
  deposit_amount INTEGER DEFAULT 0,
  down_amount INTEGER DEFAULT 0,
  middle_amount INTEGER DEFAULT 0,
  final_amount INTEGER DEFAULT 0,
  status TEXT DEFAULT 'confirmed',
  quote_version INTEGER,
  quote_snapshot TEXT,
  confirmed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  contract_id TEXT REFERENCES contracts(id),
  partner_id TEXT REFERENCES partners(id),
  amount INTEGER NOT NULL,
  fee_rate REAL NOT NULL,
  status TEXT DEFAULT 'received',
  hold_reason TEXT,
  payout_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  consumer_id TEXT NOT NULL REFERENCES users(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  installment_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KRW',
  status TEXT NOT NULL DEFAULT 'ready',
  provider TEXT NOT NULL DEFAULT 'portone_v2',
  provider_transaction_id TEXT,
  paid_at TEXT,
  cancelled_at TEXT,
  failure_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(contract_id, installment_type)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_status TEXT,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(payment_id, event_type, provider_status)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_role TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  target_type TEXT,
  target_id TEXT,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_role, recipient_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  contract_id TEXT REFERENCES contracts(id),
  type TEXT NOT NULL,
  filed_by TEXT NOT NULL,
  reason TEXT,
  ai_verdict TEXT,
  status TEXT DEFAULT 'filed',
  resolution TEXT,
  settlement_adjustment INTEGER,
  filed_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS defects (
  id TEXT PRIMARY KEY,
  contract_id TEXT REFERENCES contracts(id),
  photos TEXT,
  description TEXT,
  urgency TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  contract_id TEXT REFERENCES contracts(id),
  plan TEXT NOT NULL,
  status TEXT DEFAULT 'unpaid',
  grade TEXT,
  score INTEGER,
  report TEXT,
  applied_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER,
  duration_ms INTEGER,
  user_id TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  consumer_id TEXT REFERENCES users(id),
  partner_id TEXT REFERENCES partners(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(consumer_id, partner_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE,
  room_id TEXT REFERENCES chat_rooms(id),
  sender_role TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  msg_type TEXT DEFAULT 'text',
  client_message_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_read_states (
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  reader_role TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(room_id, reader_role, reader_id)
);

CREATE TABLE IF NOT EXISTS meas_jobs (
  room_id TEXT PRIMARY KEY REFERENCES chat_rooms(id),
  status TEXT DEFAULT 'none',
  slots TEXT DEFAULT '[]',
  chosen_slot_id TEXT,
  site_notes TEXT DEFAULT '[]',
  meetings TEXT DEFAULT '{"site":false,"design":false,"material":false}',
  confirm_checks TEXT DEFAULT '{"photo":false,"adjust":false}',
  reschedule_count INTEGER DEFAULT 0,
  noshow_log TEXT DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS measurement_events (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  actor_role TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_measurement_events_room ON measurement_events(room_id, created_at, id);

-- 재설계(사용자요청 — 파트너 광고를 "관리자 승인" 방식에서 "지역당 6자리 달력 예약 + 정해진 틀
-- 자동검증" 방식으로 전면 개편): 기존 ad_slots는 슬롯종류(히어로/히어로하단/지역상위노출)별로
-- 따로 사고 따로 심사받는 구조였다. 이제는 폼 하나 = 예약 1건이며, 승인되면(=정해진 틀을 통과하면)
-- 3곳에 동시노출된다. 슬롯종류 구분 자체가 없어졌고, 대신 "지역"이 공유자원이 되어 하루에 최대
-- 6건까지만 동시에 예약될 수 있다(달력 예약제).
CREATE TABLE IF NOT EXISTS ad_reservations (
  id TEXT PRIMARY KEY,
  partner_id TEXT REFERENCES partners(id),
  region TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL,
  cost_credits INTEGER NOT NULL,
  -- 아래 4개는 결제(예약) 직후 이어지는 "정해진 틀" 화면에서 채워짐. 다 채워지기 전(content_completed_at
  -- IS NULL)에는 예약만 된 상태(pending_content)이며 3곳 어디에도 노출되지 않는다 — 관리자 검수가
  -- 아니라 "필수 항목을 다 채웠는가"가 유일한 게이트(허수 데이터 금지 원칙: 채워지지 않은 광고를
  -- 노출시키지 않는다).
  image_url TEXT,
  tagline TEXT,
  keywords TEXT,
  content_completed_at TEXT,
  -- 히어로자리(우리동네 추천디자인업체) 전용: 영상 슬라이드 6개 중 몇 번째에 배정됐는지(0~5).
  -- 같은 지역에서 겹치는 기간의 예약끼리는 절대 같은 인덱스를 배정받지 않는다.
  hero_slide_index INTEGER,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ad_reservations_region ON ad_reservations(region, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_ad_reservations_partner ON ad_reservations(partner_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  partner_id TEXT REFERENCES partners(id),
  type TEXT,
  amount INTEGER NOT NULL,
  related_ad_id TEXT,
  payment_method TEXT,
  order_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 신규(사용자요청 — 루머칼럼 Notion 연동): Notion 데이터베이스와 동기화되는 칼럼 저장소.
-- notion_page_id가 있으면 Notion에서 가져온 글, 없으면 관리자가 직접 등록한 기본(폴백) 글.
CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY,
  notion_page_id TEXT UNIQUE,
  tag TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  thumb_emoji TEXT,
  thumb_color TEXT,
  source_name TEXT,
  source_url TEXT,
  published_at TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT 'consumer',
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 신규(2026-09, 관리자 콘솔 실연동 — 허수업체 전수조사 후속): 등급 승급 심사 큐.
-- from_tier는 스냅샷 고정 원칙(다른 테이블과 동일)에 따라 신청 시점의 등급을 값으로 복사해 저장한다.
CREATE TABLE IF NOT EXISTS tier_upgrades (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  from_tier TEXT NOT NULL,
  to_tier TEXT NOT NULL,
  license_number TEXT,
  issuer TEXT,
  doc_name TEXT,
  status TEXT NOT NULL DEFAULT 'admin_review',
  admin_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT
);

-- 신규(2026-09, 관리자 콘솔 실연동): 어뷰징(반복 노쇼) 조치 이력.
-- meas_jobs.noshow_log 자체는 별도 큐 테이블이 아니라 실측 진행상황에 묻어있는 로그라서,
-- "이 방은 이미 조치했다"를 기억하기 위한 이력 테이블을 둔다(노쇼가 그 뒤로 더 쌓이면 다시 대기열에 뜬다).
CREATE TABLE IF NOT EXISTS abuse_actions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES chat_rooms(id),
  partner_id TEXT REFERENCES partners(id),
  action TEXT NOT NULL,
  note TEXT,
  noshow_count_at_action INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 신규(2026-09, 광고 크레딧 실충전 연동): 계약대금 결제(payments 테이블)와 동일한 토스페이먼츠
-- 승인구조를 그대로 재사용하되, payments는 contract_id가 필수라 크레딧충전에는 맞지 않아 별도 테이블로 둔다.
CREATE TABLE IF NOT EXISTS credit_topups (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  payment_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT
);

-- 신규(2026-09, 소비자 포인트 실충전 연동 — 결제기능 전수조사에서 "포인트 충전"이 서버 없이
-- setTimeout으로 성공을 흉내내던 가짜결제였음이 발견되어 수정): 위 credit_topups(업체 광고크레딧)와
-- 완전히 동일한 구조를 소비자 포인트(cash_balance)용으로 그대로 재사용한다.
CREATE TABLE IF NOT EXISTS point_topups (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  payment_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT
);

-- 신규(2026-09, 결제수단 실등록 연동 — "카드 등록"이 화면에서 카드번호를 직접 입력받아 처리하는
-- PCI-DSS 위반 방식이었음이 발견되어 토스페이먼츠 빌링키 발급 방식으로 교체): 카드번호 전체는
-- 토스 서버에만 존재하며 우리 DB에는 절대 저장하지 않는다. billing_key(자동결제용 키)만 보관.
CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  billing_key TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  card_last4 TEXT,
  card_brand TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  removed_at TEXT
);

-- 신규(사용자요청 — "추천 검색어"가 실제 통계 없이 하드코딩값이었던 문제 발견 후 수정): 검색은
-- 지금까지 브라우저 안에서만 처리되고 서버에 남는 기록이 전혀 없어, "가장 많이 검색된 단어"라는
-- 게 애초에 존재하지 않았다. 실제 검색어를 쌓아서 진짜 인기 검색어를 계산할 수 있게 로그 테이블 추가.
CREATE TABLE IF NOT EXISTS search_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 신규(사용자요청 — 푸시알림 인프라 완성): 지금까지 클라이언트 구독 코드만 있고 저장할 곳이
-- 없어 /api/push/subscriptions가 404였던 문제. 한 사용자가 여러 기기에서 구독할 수 있으므로
-- endpoint(구독 고유 식별자) 단위로 저장하고, recipient_role+recipient_id로 createNotification()이
-- 실제 발송 대상을 찾는다.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  recipient_role TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_recipient ON push_subscriptions(recipient_role, recipient_id);

-- 신규(2026-09, 전수조사 발견 — 운영콘솔 "이벤트 관리"): 지금까지 이벤트를 만들어도 브라우저 메모리
-- (window.ADMIN_EVENTS)에만 있어서 새로고침하면 사라졌던 문제. 실제로 저장되도록 테이블 추가.
-- 참여자·전환 수는 아직 실제 추적 로직이 없어 0으로 시작하며(가짜 숫자를 지어내지 않음), 화면에는
-- 그 사실을 정직하게 안내한다.
CREATE TABLE IF NOT EXISTS admin_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  target TEXT DEFAULT 'all',
  benefit TEXT,
  copy TEXT,
  status TEXT DEFAULT 'active',
  participants INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
-- 신규(강남언니 벤치마킹 검토 후속 — 0단계): 실제로는 아무 데도 접수되지 않던 "1:1 문의하기"
-- 프로토타입 alert()를 실제 문의 접수·답변 기능으로 교체하기 위한 테이블.
CREATE TABLE IF NOT EXISTS support_inquiries (
  id TEXT PRIMARY KEY,
  user_role TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  admin_reply TEXT,
  replied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
-- 신규(사용자요청 — 고객센터 FAQ를 검색 가능한 방대한 자료로 확장): 기존에 코드에 3개씩
-- 하드코딩돼있던 FAQ를 DB로 옮겨서 (a) 관리자가 나중에 직접 추가·수정하고 (b) 검색이 가능하게 한다.
CREATE TABLE IF NOT EXISTS faqs (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL DEFAULT 'common', -- consumer / partner / common
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT,
  sort_order INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published', -- published / draft
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_search_queries_query_created ON search_queries(query, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_inquiries_user ON support_inquiries(user_role, user_id, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_inquiries_status ON support_inquiries(status, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_faqs_audience_status ON faqs(audience, status, sort_order)');

// 루머27 무중단 마이그레이션: CREATE TABLE IF NOT EXISTS만으로는 기존 SQLite에 새 열이 생기지 않는다.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('partners', 'login_provider', 'TEXT');
ensureColumn('partners', 'login_id', 'TEXT');
ensureColumn('partners', 'phone', 'TEXT');
ensureColumn('partners', 'applicant_name', 'TEXT');
ensureColumn('partners', 'applicant_role', "TEXT NOT NULL DEFAULT 'representative'");
ensureColumn('partners', 'identity_verified_at', 'TEXT');
ensureColumn('partners', 'ci_hash', 'TEXT');
ensureColumn('partners', 'authorization_doc_url', 'TEXT');
ensureColumn('partners', 'business_verified_at', 'TEXT');
ensureColumn('partners', 'business_status', 'TEXT');
ensureColumn('partners', 'business_tax_type', 'TEXT');
ensureColumn('partners', 'postal_code', 'TEXT');
ensureColumn('partners', 'road_address', 'TEXT');
ensureColumn('partners', 'address_detail', 'TEXT');
ensureColumn('otp_codes', 'purpose', "TEXT NOT NULL DEFAULT 'consumer'");
ensureColumn('otp_codes', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('otp_codes', 'consumed_at', 'TEXT');
ensureColumn('meas_jobs', 'site_notes', "TEXT DEFAULT '[]'");
ensureColumn('meas_jobs', 'meetings', "TEXT DEFAULT '{\"site\":false,\"design\":false,\"material\":false}'");
ensureColumn('meas_jobs', 'confirm_checks', "TEXT DEFAULT '{\"photo\":false,\"adjust\":false}'");
ensureColumn('meas_jobs', 'revision', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('chat_messages', 'client_message_id', 'TEXT');
ensureColumn('quotes', 'version', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('quotes', 'parent_quote_id', 'TEXT');
ensureColumn('quotes', 'status', "TEXT NOT NULL DEFAULT 'sent'");
ensureColumn('quotes', 'viewed_at', 'TEXT');
ensureColumn('quotes', 'accepted_at', 'TEXT');
ensureColumn('quotes', 'rejected_at', 'TEXT');
ensureColumn('quotes', 'revision_requested_at', 'TEXT');
ensureColumn('quotes', 'expires_at', 'TEXT');
ensureColumn('contracts', 'quote_version', 'INTEGER');
ensureColumn('contracts', 'quote_snapshot', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_client_id ON chat_messages(room_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_room_seq ON chat_messages(room_id, seq)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_login ON partners(login_provider, login_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_otp_target_purpose ON otp_codes(target, purpose, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_partner_service_region_code ON partner_service_regions(region_code, partner_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_partner_identity_login ON partner_identity_verifications(login_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_partner_verification_consents ON partner_verification_consents(partner_id, agreed_at DESC)');

// 기존 단일 region 데이터가 있는 파트너는 최초 실행 때 대표 활동지역 한 건으로 안전하게 이관한다.
const legacyPartners = db.prepare(`SELECT id, region FROM partners p
  WHERE region IS NOT NULL AND trim(region)<>''
  AND NOT EXISTS (SELECT 1 FROM partner_service_regions r WHERE r.partner_id=p.id)`).all();
const insertLegacyRegion = db.prepare(`INSERT OR IGNORE INTO partner_service_regions
  (id, partner_id, region_code, sido, sigungu, is_primary) VALUES (?,?,?,?,?,1)`);
const migrateLegacyRegions = db.transaction(rows => {
  rows.forEach(row => {
    const regionCode = String(row.region).trim();
    const parts = regionCode.split(/\s+/);
    insertLegacyRegion.run(require('crypto').randomUUID(), row.id, regionCode, parts[0] || regionCode, parts.slice(1).join(' ') || parts[0] || regionCode);
  });
});
migrateLegacyRegions(legacyPartners);

// 신규(사용자요청 — 메신저 사진·파일 전송 API 실제 구현): 첨부메시지가 참조하는 stored_files.id를
// 저장. Base64 원본은 여기 저장하지 않고 오직 ID(참조)만 저장한다.
ensureColumn('chat_messages', 'attachment_id', 'TEXT');

// 신규(사용자요청 — PG사를 포트원 경유가 아닌 토스페이먼츠 자체 API로 직접 연동하기로 확정):
// 토스페이먼츠는 orderId(가맹점 주문번호, 기존 payment_id 컬럼을 그대로 재사용)와
// paymentKey(토스가 발급하는 고유 결제식별자, 결제 승인 성공 후에만 확정됨) 두 값을 함께 관리해야 함.
ensureColumn('payments', 'payment_key', 'TEXT');


ensureColumn('inspections', 'price', 'INTEGER DEFAULT 0');
ensureColumn('inspections', 'photo_count', 'INTEGER');
ensureColumn('inspections', 'trip_key', 'TEXT');
// 신규(사용자요청 — 관리자 전문인력 검토 워크플로): 사람이 직접 작성하는 답변 저장용
ensureColumn('inspections', 'expert_answer', 'TEXT');
ensureColumn('inspections', 'answered_at', 'TEXT');
ensureColumn('inspections', 'answered_by', 'TEXT');
// 신규(2026-09, AI 감리 결제 실연동): 보유크레딧으로 부족한 잔액만 토스페이먼츠로 결제하기 위해
// 감리 1건당 진행 중인 토스 주문번호(order_id)와, 그 주문에 실제로 사용될 크레딧 계획값(credit_used)을 저장.
ensureColumn('inspections', 'order_id', 'TEXT');
ensureColumn('inspections', 'credit_used', 'INTEGER DEFAULT 0');
// 신규(2026-09, 완공사례 피드 운영검수 게이트): 이미 배포된 DB에도 안전하게 컬럼 추가
// (기존 행은 전부 status='pending'이 되어 재검수 필요 — 지금은 실제 등록건이 0개라 영향 없음)
ensureColumn('portfolio_projects', 'status', "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn('portfolio_projects', 'reject_reason', 'TEXT');
ensureColumn('portfolio_projects', 'reviewed_at', 'TEXT');
db.exec("CREATE INDEX IF NOT EXISTS idx_portfolio_projects_status ON portfolio_projects(status, created_at)");
// 신규(사용자요청 — 포트폴리오→상세페이지 반영): 포트폴리오 사진 업로드 시 사진마다 "상세페이지
// 대표사진으로도 쓰기"를 선택할 수 있게 하고, 그 프로젝트가 관리자 승인되는 순간에만(미승인 사진이
// 공개 상세페이지로 새어나가지 않도록) partners.portfolio_images에 자동 반영한다.
ensureColumn('portfolio_photos', 'use_as_profile_photo', 'INTEGER NOT NULL DEFAULT 0');

db.exec('CREATE INDEX IF NOT EXISTS idx_tier_upgrades_partner ON tier_upgrades(partner_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tier_upgrades_status ON tier_upgrades(status, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_abuse_actions_room ON abuse_actions(room_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_credit_topups_partner ON credit_topups(partner_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_point_topups_user ON point_topups(user_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id, removed_at)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inspections_order_id ON inspections(order_id) WHERE order_id IS NOT NULL');

// 신규(2026-09, 사용자요청 — 소비자 회원관리): 지금까지 소비자는 "자진 탈퇴(withdrawn_at)"만 가능하고
// 파트너처럼 관리자가 직접 정지시키는 기능이 없었음. partners.verify_status='suspended'와 동일한 개념을
// users 테이블에도 추가(정지시각+사유). suspended_at이 있으면 정지 상태, withdrawn_at이 있으면 탈퇴 상태로 구분.
ensureColumn('users', 'suspended_at', 'TEXT');
ensureColumn('users', 'suspend_reason', 'TEXT');
// 결함수정(사용자 실제 발견 — "실측 진행 이력" 팝업이 "undefined undefined undefined"만 표시):
// measurement_events가 actor_role/event_type/from_status/to_status만 갖고 있어서, 화면에
// 보여줄 사람이 읽을 수 있는 문장이 DB에 저장돼있지 않았다(같은 순간 chat_messages에는 저장됐지만
// 그건 채팅용이라 이 팝업은 조회할 방법이 없었음). 이벤트 발생 시점에 이미 만들어져 있는 요약문을
// 같이 저장해서, 이 팝업이 그걸 그대로 재사용할 수 있게 한다.
ensureColumn('measurement_events', 'summary', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_partners_approved_at ON partners(approved_at DESC)');

// 신규(2026-09, 사용자요청 — 소비자/파트너 회원관리): 정지·정지해제 등 관리자의 회원 상태변경 조치를
// 누가·언제·왜 했는지 남기는 감사로그. abuse_actions는 room_id가 필수라 재사용 불가(어뷰징 큐 전용) →
// 회원관리 화면 전용으로 target_type(consumer/partner)+target_id 기반의 범용 테이블을 별도로 둔다.
db.exec(`
CREATE TABLE IF NOT EXISTS admin_member_actions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  admin_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_admin_member_actions_target ON admin_member_actions(target_type, target_id, created_at DESC)');

// 신규(강남언니 벤치마킹 검토 후속 — 1단계: 관리자 접근 감사로그): 관리자가 업체의 증빙서류
// (사업자등록증 사본, 사무실 사진 등 stored_files의 private 파일)를 열람할 때마다 남기는 로그.
// 누가·언제·무엇을 열람했는지 기록해서, 민감정보 오남용을 사후에 추적할 수 있게 한다.
db.exec(`
CREATE TABLE IF NOT EXISTS admin_access_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  purpose TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_admin_access_logs_resource ON admin_access_logs(resource_type, resource_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_admin_access_logs_admin ON admin_access_logs(admin_id, created_at DESC)');

// 신규(강남언니 벤치마킹 검토 후속 — 2단계: 계약인증 리뷰 시스템): 실제 계약(contract_id)에
// 묶여서만 작성 가능한 리뷰. 예전에 있던 "자기신고형 리뷰+캐시적립" 기능은 증빙 없이 어뷰징이
// 가능해 완전히 삭제된 이력이 있어(아래 UNIQUE 제약으로 계약당 리뷰 1개만 허용), 이번엔 실제
// contracts 테이블의 존재 자체를 증빙으로 삼는다.
// 참고: 이 서비스는 아직 "공사 완료" 단계를 별도로 추적하지 않는다(계약 확정 이후 상태를 바꾸는
// 로직이 없음) — 그래서 "완료된 계약만" 대신 "실제 계약이 존재하는 건"을 작성 자격으로 삼았다.
db.exec(`
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL UNIQUE REFERENCES contracts(id),
  consumer_id TEXT NOT NULL REFERENCES users(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  rating_overall INTEGER NOT NULL,
  rating_quote_accuracy INTEGER NOT NULL,
  rating_quality INTEGER NOT NULL,
  rating_schedule INTEGER NOT NULL,
  rating_communication INTEGER NOT NULL,
  comment TEXT,
  partner_reply TEXT,
  partner_replied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_partner ON reviews(partner_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_consumer ON reviews(consumer_id)');

// ===== 신규(2026-09-18 전수조사): 누락 인덱스 일괄 보강 =====
// 아래 인덱스들은 EXPLAIN QUERY PLAN으로 "SCAN"(=테이블 전체 훑기)이 실제로 확인된 쿼리들만
// 골라 추가한 것이다. 추측으로 넣은 것은 없다. 특히 idx_request_logs_created는 6시간마다 도는
// 보관기간 정리(server.js)가 가장 큰 테이블을 통째로 훑던 것을 막아준다.
// 같은 내용의 마이그레이션 SQL을 migrations/20260918_add_missing_indexes.sql 로 따로 두었다
// (공통 규칙 5번 — 스키마 변경은 마이그레이션 SQL을 별도 파일로 제시). 아래는 신규 배포 및
// 기존 DB 양쪽에서 동일하게 적용되도록 IF NOT EXISTS로 선언한 것이라, 기존 데이터는 그대로 보존된다.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_request_logs_created      ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_search_queries_created    ON search_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_partner        ON chat_rooms(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_partner         ON contracts(partner_id);
CREATE INDEX IF NOT EXISTS idx_contracts_consumer        ON contracts(consumer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_quote           ON contracts(quote_id);
CREATE INDEX IF NOT EXISTS idx_settlements_partner       ON settlements(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_contract      ON settlements(contract_id);
CREATE INDEX IF NOT EXISTS idx_quotes_request            ON quotes(request_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_quote_requests_user       ON quote_requests(user_id, partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_photos_project  ON portfolio_photos(project_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_projects_partner ON portfolio_projects(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_partner     ON credit_ledger(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_contract         ON disputes(contract_id);
CREATE INDEX IF NOT EXISTS idx_admin_access_logs_created ON admin_access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created     ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_created    ON payment_events(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created     ON chat_messages(created_at);
`);

// 신규(사용자요청 — 고객센터 FAQ 확장): faqs 테이블이 완전히 비어있을 때만 초기 콘텐츠(100개)를
// 채워 넣는다. 이미 데이터가 있다면(관리자가 추가·수정했을 수 있으므로) 절대 건드리지 않는다.
(function seedFaqsIfEmpty() {
  const { randomUUID } = require('crypto');
  const count = db.prepare('SELECT COUNT(*) c FROM faqs').get().c;
  if (count > 0) return;
  const seed = require('./faq-seed.js');
  const insert = db.prepare(`INSERT INTO faqs (id, audience, category, question, answer, keywords, sort_order, status)
    VALUES (?,?,?,?,?,?,?,'published')`);
  const insertAll = db.transaction((rows) => {
    rows.forEach((f) => insert.run(randomUUID(), f.audience, f.category, f.question, f.answer, f.keywords || '', f.sort_order || 0));
  });
  insertAll(seed);
  console.log(`[FAQ 시드] faqs 테이블이 비어있어 초기 콘텐츠 ${seed.length}건을 채웠습니다.`);
})();

// ===== 신규(2026-09-18): 검색용 블라인드 인덱스 컬럼 준비 (테이블 생성 이후에 실행되어야 함) =====
// 검색용 해시 컬럼을 준비한다. SQLite는 ADD COLUMN에 IF NOT EXISTS가 없어서 직접 확인한다.
// 기존 데이터에는 영향이 없다(값이 NULL인 컬럼이 하나 늘어날 뿐).
const PII_INDEX_COLUMNS = [
  ['users', 'phone_idx', 'phone'],
  ['partners', 'phone_idx', 'phone'],
  ['partners', 'business_reg_number_idx', 'business_reg_number']
];
for (const [table, col] of PII_INDEX_COLUMNS) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${col} ON ${table}(${col})`);
}

// 한 행의 검색용 해시를 현재 저장값 기준으로 다시 계산해 넣는다.
// (개인정보를 새로 저장하거나 바꾼 직후에 호출한다 — server.js의 저장 지점들)
db.syncPiiIndexes = function syncPiiIndexes(table, id) {
  try {
    const cols = PII_INDEX_COLUMNS.filter(c => c[0] === table);
    if (!cols.length || !id) return;
    // .get()은 자동 복호화되므로 여기서 얻는 값은 평문이다.
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) return;
    for (const [, idxCol, srcCol] of cols) {
      db.prepare(`UPDATE ${table} SET ${idxCol}=? WHERE id=?`).run(piiIndex(row[srcCol]), id);
    }
  } catch (e) { console.error('[검색인덱스] 갱신 실패:', table, id, e.message); }
};

// 서버 부팅 시 1회: 아직 해시가 비어 있는 기존 행을 채운다. 이미 채워진 행은 건드리지 않으므로
// 두 번째 부팅부터는 거의 즉시 끝난다. 저장 지점을 하나 빠뜨려도 다음 부팅에 복구되는 안전망이다.
db.backfillPiiIndexes = function backfillPiiIndexes() {
  let filled = 0;
  for (const [table, idxCol, srcCol] of PII_INDEX_COLUMNS) {
    try {
      const rows = db.prepare(`SELECT id, ${srcCol} FROM ${table} WHERE ${idxCol} IS NULL AND ${srcCol} IS NOT NULL`).all();
      if (!rows.length) continue;
      const upd = db.prepare(`UPDATE ${table} SET ${idxCol}=? WHERE id=?`);
      db.transaction(() => { rows.forEach(r => { upd.run(piiIndex(r[srcCol]), r.id); filled++; }); })();
    } catch (e) { console.error('[검색인덱스] 백필 실패:', table, e.message); }
  }
  if (filled > 0) console.log(`[검색인덱스] 기존 데이터 ${filled}건에 검색용 해시를 채웠습니다.`);
  return filled;
};

module.exports = db;
