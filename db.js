// 루머 ROOMER 백엔드 - DB 초기화 (SQLite, 실서비스에서는 PostgreSQL로 교체)
const Database = require('better-sqlite3');
// 신규(사용자요청 — DB 영속성 점검): Render에 Persistent Disk를 마운트하면 DB_PATH 환경변수로
// 그 마운트 경로(예: /data/roomer.db)를 지정만 하면 재배포시에도 데이터가 유지됨.
// 환경변수가 없으면 기존과 동일하게 상대경로 사용(로컬 개발 호환).
const db = new Database(process.env.DB_PATH || 'roomer.db');

db.pragma('foreign_keys = ON');

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

CREATE TABLE IF NOT EXISTS portfolio_projects (
  id TEXT PRIMARY KEY,
  partner_id TEXT REFERENCES partners(id),
  title TEXT NOT NULL,
  description TEXT,
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

CREATE TABLE IF NOT EXISTS ad_slots (
  id TEXT PRIMARY KEY,
  partner_id TEXT REFERENCES partners(id),
  slot_type TEXT,
  region TEXT,
  tagline TEXT,
  status TEXT DEFAULT 'pending',
  cost_type TEXT,
  cost_value INTEGER,
  spent_credits INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  ai_precheck_result TEXT,
  reject_reason TEXT
);

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
`);

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

module.exports = db;
