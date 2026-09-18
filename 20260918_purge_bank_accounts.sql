-- ============================================================================
-- 루머 ROOMER — 기존에 저장된 은행 계좌번호 세척(파기)
-- 작성일: 2026-09-18
-- 사유: 삭제된 POST /api/withdrawals 라우트가 이용자가 입력한 은행 계좌정보를
--       credit_ledger.payment_method 컬럼에 "암호화 없이 평문으로" 저장하고 있었습니다.
--       라우트를 제거했으므로, 이미 저장된 값도 함께 파기해야 개인정보보호법상
--       "목적이 달성된 개인정보의 지체 없는 파기" 요건을 충족합니다.
--
-- [중요 — 실행 전에 반드시 읽어주세요]
--   이 마이그레이션은 데이터를 "지웁니다". 되돌릴 수 없습니다.
--   실행 전에 반드시 백업을 먼저 만드세요. 서버에 자동 백업 기능이 들어갔으므로
--   관리자 계정으로 POST /api/admin/db-backups 를 호출하거나, 서버를 한 번
--   재배포하면(부팅 시 자동 백업) 최신 백업이 /var/data/backups/ 에 생깁니다.
--
-- [지워지는 것 / 남는 것]
--   지움: payment_method 컬럼에 들어있던 "은행명+계좌번호" 문자열
--   남음: 출금 이력 자체(누가·언제·얼마)는 회계·정산 추적을 위해 그대로 보존합니다.
--         payment_method 값만 '[삭제됨-계좌정보파기]' 로 대체합니다.
--
-- [적용 방법]
--   Render 대시보드 → roomer-backend → Shell 에서:
--     sqlite3 /var/data/roomer.db < migrations/20260918_purge_bank_accounts.sql
--   (Shell 사용이 어려우시면 말씀 주세요 — 1회용 관리자 API로 만들어 드릴 수 있습니다)
-- ============================================================================

-- 1) 먼저 몇 건이 대상인지 확인합니다. (0건이면 아래 UPDATE는 아무 일도 하지 않습니다)
SELECT '세척 대상 건수' AS 항목, COUNT(*) AS 값
FROM credit_ledger
WHERE type = 'withdrawal'
  AND payment_method IS NOT NULL
  AND payment_method <> ''
  AND payment_method <> '[삭제됨-계좌정보파기]';

-- 2) 계좌정보만 파기합니다. (출금 이력·금액·일시는 보존)
UPDATE credit_ledger
SET payment_method = '[삭제됨-계좌정보파기]'
WHERE type = 'withdrawal'
  AND payment_method IS NOT NULL
  AND payment_method <> ''
  AND payment_method <> '[삭제됨-계좌정보파기]';

-- 3) 결과 확인 — 아래 조회 결과에 계좌번호처럼 보이는 값이 남아 있으면 안 됩니다.
SELECT '세척 후 잔존' AS 항목, COUNT(*) AS 값
FROM credit_ledger
WHERE type = 'withdrawal'
  AND payment_method IS NOT NULL
  AND payment_method <> ''
  AND payment_method <> '[삭제됨-계좌정보파기]';

-- 4) 삭제된 값이 파일 안에 흔적으로 남지 않도록 DB 파일을 재작성합니다.
--    (SQLite는 UPDATE 후에도 이전 값이 파일의 빈 공간에 남아 있을 수 있습니다)
VACUUM;
