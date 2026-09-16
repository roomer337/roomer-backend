// ============================================================================
// 정리 스크립트: request_logs에 남아있는 정밀 GPS 좌표 제거 (2026-09-16, 위치정보 감사 후속)
// ============================================================================
// 무엇을 하는가:
//   request_logs.path 컬럼 중 '/api/geo/reverse?lat=...&lng=...' 형태로 저장된 값에서
//   쿼리스트링(좌표)을 제거하고 '/api/geo/reverse'만 남긴다.
//
// 왜 필요한가:
//   기존 요청 로깅 미들웨어(server.js)가 req.originalUrl을 그대로 기록해서, 이용자가
//   "현재위치로 찾기"를 누를 때마다 전달된 정밀 GPS 좌표(lat, lng)가 request_logs 테이블에
//   평문으로, 삭제 로직 없이 영구 보관되고 있었다. 이는 위치정보 처리방침의 "좌표는 저장하지
//   않는다" 원칙과 맞지 않는다. server.js의 로깅 미들웨어는 이미 이 라우트에 한해 쿼리스트링을
//   기록하지 않도록 수정했고(2026-09-16), 이 스크립트는 그 수정 이전에 이미 쌓인 과거 로그를
//   정리하기 위한 것이다.
//
// 데이터 보존 방법(안전장치):
//   1) 행 자체를 삭제하지 않는다 — method/status_code/duration_ms/user_id/id(및 그에 따른 시간 순서)는
//      그대로 유지하고, path 값에서 좌표가 담긴 쿼리스트링만 제거한다(통계·트래픽 이력 보존).
//   2) 실제 반영 전 몇 건이 영향받는지 콘솔에 미리 보여주고(--dry-run, 기본값), --apply 플래그를
//      줬을 때만 UPDATE를 수행한다.
//   3. 이미 쿼리스트링이 없는 값(재실행 시)은 대상에서 자동 제외된다 — 여러 번 실행해도 안전(멱등).
//   4) 실행 전 DB 파일 백업을 권장한다: cp roomer.db roomer.db.bak-$(date +%Y%m%d)
//
// 실행 방법:
//   1. cp roomer.db roomer.db.bak-$(date +%Y%m%d)   ← 백업(권장)
//   2. DB_PATH=./roomer.db node cleanup-geo-log-coords.js            (미리보기만, DB 변경 없음)
//   3. DB_PATH=./roomer.db node cleanup-geo-log-coords.js --apply    (실제 반영)
// ============================================================================

const Database = require('better-sqlite3');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'roomer.db');

const raw = new Database(DB_PATH); // db.js의 자동복호화 패치를 거치지 않는 일반 연결(이 테이블엔 PII 암호화 대상 컬럼 없음)

const rows = raw.prepare(
  `SELECT id, path FROM request_logs WHERE path LIKE '/api/geo/reverse?%'`
).all();

console.log(`[cleanup-geo-log-coords] DB: ${DB_PATH}`);
console.log(`[cleanup-geo-log-coords] 좌표가 포함된 로그 ${rows.length}건 발견`);

if (rows.length > 0) {
  console.log('[cleanup-geo-log-coords] 예시(최대 5건):');
  rows.slice(0, 5).forEach(r => console.log(`  id=${r.id}  path=${r.path}`));
}

if (!APPLY) {
  console.log('\n[cleanup-geo-log-coords] --dry-run 모드입니다. DB는 변경되지 않았습니다.');
  console.log('[cleanup-geo-log-coords] 실제 반영하려면: node cleanup-geo-log-coords.js --apply');
  process.exit(0);
}

const update = raw.prepare(`UPDATE request_logs SET path = '/api/geo/reverse' WHERE id = ?`);
const tx = raw.transaction((ids) => { for (const id of ids) update.run(id); });
tx(rows.map(r => r.id));

console.log(`\n[cleanup-geo-log-coords] 완료: ${rows.length}건의 좌표를 제거했습니다.`);
raw.close();
