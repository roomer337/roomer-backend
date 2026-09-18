-- ============================================================================
-- 루머 ROOMER — 누락 인덱스 보강 마이그레이션
-- 작성일: 2026-09-18
-- 근거: 전수조사에서 EXPLAIN QUERY PLAN으로 "SCAN"(테이블 전체 훑기)이 실제로 확인된
--       쿼리들만 대상으로 함. 추측으로 넣은 인덱스는 없음.
--
-- [기존 데이터 보존]
--   이 마이그레이션은 CREATE INDEX 만 수행합니다. 테이블 구조 변경·컬럼 삭제·데이터 이동이
--   전혀 없으므로 기존 데이터는 100% 그대로 유지됩니다. 인덱스는 조회를 빠르게 하기 위한
--   보조 자료구조일 뿐이라, 잘못되면 DROP INDEX 로 되돌려도 데이터에 아무 영향이 없습니다.
--
-- [적용 방법]
--   방법 A (권장, 자동): db.js에 동일한 CREATE INDEX IF NOT EXISTS 구문이 들어가 있으므로,
--     수정된 db.js를 GitHub에 올려 Render가 재배포하면 서버 부팅 시 자동으로 적용됩니다.
--     별도로 이 파일을 실행할 필요가 없습니다.
--   방법 B (수동): Render 대시보드 → roomer-backend → Shell 에서
--     sqlite3 /var/data/roomer.db < migrations/20260918_add_missing_indexes.sql
--
-- [되돌리기] 이 파일 맨 아래 롤백 구문 참고.
--
-- [소요 시간] 인덱스 생성은 테이블을 1회 훑으며 이루어집니다. 현재 데이터 규모(수천~수만 행)
--   에서는 전체 수 초 이내에 끝납니다. 행이 수백만 건이라면 서비스 한산한 시간에 하세요.
-- ============================================================================

-- 보관기간 정리 작업이 6시간마다 훑던 가장 큰 테이블 (WHERE created_at < ...)
CREATE INDEX IF NOT EXISTS idx_request_logs_created       ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_search_queries_created     ON search_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_access_logs_created  ON admin_access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created      ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_created     ON payment_events(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created      ON chat_messages(created_at);

-- 채팅 목록: 업체 방향 조회가 풀스캔이었음
-- (소비자 방향은 UNIQUE(consumer_id, partner_id)의 자동 인덱스로 이미 커버됨)
CREATE INDEX IF NOT EXISTS idx_chat_rooms_partner         ON chat_rooms(partner_id, created_at DESC);

-- 계약/정산: 로그인 사용자의 기본 화면(/api/contracts/mine, /api/settlements/mine)에서 매번 풀스캔
CREATE INDEX IF NOT EXISTS idx_contracts_partner          ON contracts(partner_id);
CREATE INDEX IF NOT EXISTS idx_contracts_consumer         ON contracts(consumer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_quote            ON contracts(quote_id);
CREATE INDEX IF NOT EXISTS idx_settlements_partner        ON settlements(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_contract       ON settlements(contract_id);

-- 견적
CREATE INDEX IF NOT EXISTS idx_quotes_request             ON quotes(request_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_quote_requests_user        ON quote_requests(user_id, partner_id, created_at DESC);

-- 포트폴리오
CREATE INDEX IF NOT EXISTS idx_portfolio_photos_project   ON portfolio_photos(project_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_projects_partner ON portfolio_projects(partner_id, created_at DESC);

-- 크레딧 원장 / 분쟁
CREATE INDEX IF NOT EXISTS idx_credit_ledger_partner      ON credit_ledger(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_contract          ON disputes(contract_id);

-- 통계 갱신(선택) — 옵티마이저가 새 인덱스를 잘 고르도록 도와줍니다.
ANALYZE;

-- ============================================================================
-- 롤백 (문제가 생겼을 때만 실행. 데이터에는 영향 없음)
-- ============================================================================
-- DROP INDEX IF EXISTS idx_request_logs_created;
-- DROP INDEX IF EXISTS idx_search_queries_created;
-- DROP INDEX IF EXISTS idx_admin_access_logs_created;
-- DROP INDEX IF EXISTS idx_notifications_created;
-- DROP INDEX IF EXISTS idx_payment_events_created;
-- DROP INDEX IF EXISTS idx_chat_messages_created;
-- DROP INDEX IF EXISTS idx_chat_rooms_partner;
-- DROP INDEX IF EXISTS idx_contracts_partner;
-- DROP INDEX IF EXISTS idx_contracts_consumer;
-- DROP INDEX IF EXISTS idx_contracts_quote;
-- DROP INDEX IF EXISTS idx_settlements_partner;
-- DROP INDEX IF EXISTS idx_settlements_contract;
-- DROP INDEX IF EXISTS idx_quotes_request;
-- DROP INDEX IF EXISTS idx_quote_requests_user;
-- DROP INDEX IF EXISTS idx_portfolio_photos_project;
-- DROP INDEX IF EXISTS idx_portfolio_projects_partner;
-- DROP INDEX IF EXISTS idx_credit_ledger_partner;
-- DROP INDEX IF EXISTS idx_disputes_contract;
