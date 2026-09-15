// ============================================================================
// 마이그레이션: 기존 평문 PII를 암호화(1단계 — 강남언니 벤치마킹 검토 후속)
// ============================================================================
// 무엇을 하는가:
//   users.phone, partners.phone/business_reg_number/ceo_name/applicant_name,
//   partner_identity_verifications.phone/applicant_name 컬럼에 남아있는 "기존" 평문 값을
//   db.encryptPii()로 암호화해서 같은 컬럼에 다시 저장한다.
//
// 왜 필요한가:
//   db.js의 db.prepare() 패치는 "앞으로" 저장되는 값(server.js가 db.encryptPii()로 감싸서 쓰는
//   값)만 암호화한다. 이미 DB 파일에 평문으로 들어있던 기존 회원 데이터는 이 스크립트를 한 번
//   실행해야 실제로 암호화된다 — 서버 코드 배포만으로는 과거 데이터가 저절로 암호화되지 않는다.
//
// 데이터 보존 방법(안전장치):
//   1) 컬럼을 삭제/변경하지 않는다 — 같은 컬럼에 "같은 의미의 값"을 암호문으로 덮어쓸 뿐이다.
//   2) UPDATE 전 실행한 SELECT 결과를 콘솔에 몇 건 미리 보여주고(--dry-run), 실제 반영은
//      --apply 플래그를 줬을 때만 수행한다 — 실수로 바로 실행되는 걸 방지.
//   3) 이미 암호화된 값(encv1: 접두사)은 다시 암호화하지 않고 건너뛴다 — 여러 번 실행해도 안전(멱등).
//   4) 실행 전 반드시 DB 파일을 백업할 것을 강력히 권장한다(예: cp roomer.db roomer.db.bak-$(date +%Y%m%d)).
//
// 실행 방법:
//   1. 먼저 운영 환경에 PII_ENCRYPTION_KEY 환경변수를 설정한다(설정 안 하면 스크립트가 즉시 에러로 중단됨).
//   2. cp roomer.db roomer.db.bak-$(date +%Y%m%d)   ← 백업(필수)
//   3. DB_PATH=./roomer.db PII_ENCRYPTION_KEY=<실제키> node migrate-encrypt-pii.js            (미리보기만, DB 변경 없음)
//   4. DB_PATH=./roomer.db PII_ENCRYPTION_KEY=<실제키> node migrate-encrypt-pii.js --apply     (실제 반영)
// ============================================================================

const path = require('path');
const db = require(path.join(__dirname, 'db.js')); // db.encryptPii/decryptPii + 자동복호화 패치 포함

const APPLY = process.argv.includes('--apply');

function isAlreadyEncrypted(rawRow, field) {
  // db.prepare().get()이 이미 자동 복호화해서 넘겨주므로, "암호화가 필요한지" 여부는
  // 별도의 미패치 연결로 원본 컬럼 값을 직접 봐야 정확히 판단할 수 있다.
  return typeof rawRow[field] === 'string' && rawRow[field].startsWith('encv1:');
}

// db.js의 db.prepare()는 이미 패치되어 있어(자동복호화) 원본 저장값을 볼 수 없다.
// 그래서 이 스크립트 전용으로, 같은 DB 파일을 가리키는 "패치되지 않은" 별도 연결을 하나 더 연다.
const Database = require('better-sqlite3');
const rawDb = new Database(process.env.DB_PATH || 'roomer.db');

function migrateTable(table, fields, idField = 'id') {
  const rows = rawDb.prepare(`SELECT * FROM ${table}`).all(); // 원본(미복호화) 값 그대로
  let toMigrate = 0, skipped = 0;
  const updates = [];
  for (const row of rows) {
    const setClauses = [];
    const params = [];
    for (const f of fields) {
      if (row[f] === null || row[f] === undefined || row[f] === '') continue;
      if (isAlreadyEncrypted(row, f)) { skipped++; continue; }
      setClauses.push(`${f}=?`);
      params.push(db.encryptPii(row[f]));
    }
    if (setClauses.length) {
      toMigrate++;
      updates.push({ id: row[idField], sql: `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${idField}=?`, params: [...params, row[idField]] });
    }
  }
  console.log(`[${table}] 암호화 대상 ${toMigrate}행, 이미 암호화됨(건너뜀) ${skipped}건`);
  if (updates.length && !APPLY) {
    console.log(`  (미리보기) 예시 최대 3건의 대상 id: ${updates.slice(0, 3).map(u => u.id).join(', ')}`);
  }
  if (APPLY) {
    const runAll = rawDb.transaction((list) => { list.forEach(u => rawDb.prepare(u.sql).run(...u.params)); });
    runAll(updates);
    console.log(`  → ${updates.length}행 실제 반영 완료`);
  }
  return { toMigrate, skipped };
}

console.log(`===== PII 암호화 마이그레이션 (${APPLY ? '실제 반영 모드' : '미리보기 모드 — DB 변경 없음'}) =====`);
if (!APPLY) console.log('실제로 반영하려면 --apply 플래그를 붙여 다시 실행하세요.\n');

const r1 = migrateTable('users', ['phone']);
const r2 = migrateTable('partners', ['phone', 'business_reg_number', 'ceo_name', 'applicant_name']);
const r3 = migrateTable('partner_identity_verifications', ['phone', 'applicant_name']);

const total = r1.toMigrate + r2.toMigrate + r3.toMigrate;
console.log(`\n총 ${total}행 ${APPLY ? '암호화 완료' : '암호화 대상(미리보기)'}.`);
if (!APPLY && total > 0) console.log('문제 없어 보이면: node migrate-encrypt-pii.js --apply 로 다시 실행하세요.');

rawDb.close();
