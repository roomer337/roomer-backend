-- ============================================================================
-- 루머 ROOMER — 설치형 앱 소셜로그인 복귀용 일회성 세션 테이블
-- 작성일: 2026-09-18
--
-- [무엇을 고치는 마이그레이션인가]
-- 설치한 앱에서 카카오·네이버·애플 로그인을 누르면 안드로이드가 그 주소를 외부 앱(주로 네이버 앱)으로
-- 넘겨버려, 로그인이 앱 바깥에서 끝나고 우리 앱은 영원히 로그인되지 않던 문제.
-- 로그인은 시스템 브라우저에서 하되, 그 결과를 "우리 앱에게만" 돌려주기 위한 중계 테이블이다.
--
-- [기존 데이터 보존]
-- 새 테이블을 만들기만 한다. 기존 테이블을 건드리지 않으므로 데이터 손실 위험이 없다.
-- 이미 테이블이 있으면 아무 일도 하지 않는다(IF NOT EXISTS).
-- server.js가 부팅할 때 db.js가 같은 내용을 자동으로 만들기 때문에, 이 파일은 "무엇이 추가되는지"를
-- 확인하고 싶을 때 보는 기록용이며 따로 실행하지 않아도 된다.
--
-- [실행 방법 — 직접 돌리고 싶을 때만]
--   sqlite3 /var/data/roomer.db < migrations/20260918_oauth_sessions.sql
--
-- [되돌리기]
--   DROP TABLE IF EXISTS oauth_sessions;
--   -- 이 테이블에는 10분 이내에 만료되는 일회성 로그인 중계 정보만 들어 있어,
--   -- 삭제해도 회원·계약·채팅 등 실제 데이터에는 아무 영향이 없다.
-- ============================================================================

CREATE TABLE IF NOT EXISTS oauth_sessions (
  id TEXT PRIMARY KEY,                       -- state로 실려나가는 공개 식별자
  claim_hash TEXT NOT NULL,                  -- 앱만 아는 비밀값의 해시(원문은 저장하지 않음)
  provider TEXT,                             -- kakao | naver | apple
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | ready | claimed | failed
  auth_code TEXT,                            -- 브라우저에서 받아온 인가코드(1회용)
  error_message TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  claimed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON oauth_sessions(expires_at);
