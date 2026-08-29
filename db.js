// 루머 ROOMER 백엔드 - DB 초기화 (SQLite, 실서비스에서는 PostgreSQL로 교체)
const Database = require('better-sqlite3');
const db = new Database('roomer.db');

db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  social_provider TEXT NOT NULL,
  social_id TEXT NOT NULL,
  nickname TEXT,
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
  approved_at TEXT
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
  sent_at TEXT DEFAULT (datetime('now'))
);

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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meas_jobs (
  room_id TEXT PRIMARY KEY REFERENCES chat_rooms(id),
  status TEXT DEFAULT 'none',
  slots TEXT DEFAULT '[]',
  chosen_slot_id TEXT,
  reschedule_count INTEGER DEFAULT 0,
  noshow_log TEXT DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now'))
);

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
`);

module.exports = db;
