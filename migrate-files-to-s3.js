// ============================================================================
// 마이그레이션: 로컬 디스크(uploads/private-store)에 저장된 파일을 S3 호환
// 오브젝트 스토리지로 이전 (P0-1 후속 — 강남언니 벤치마킹 검토 2단계)
// ============================================================================
//
// ⚠️⚠️⚠️ 실행 순서가 매우 중요합니다 — 반드시 아래 순서를 지켜주세요 ⚠️⚠️⚠️
//
//   1) 이 스크립트로 먼저 기존 파일을 전부 S3(또는 R2/B2 등 호환 스토리지)로 복사한다.
//      이 단계에서는 Render에 배포된 실제 서버의 환경변수(OBJECT_STORAGE_BUCKET 등)는
//      절대 아직 설정하지 않는다 — 이 스크립트만 로컬 PC/이 서버 환경에서 별도로 실행한다.
//   2) 이 스크립트가 "전체 이전 완료, 검증 성공"을 출력하는 것을 확인한다.
//   3) 그 다음에야 비로소 Render 환경변수에 OBJECT_STORAGE_*를 설정하고 재배포한다.
//
//   왜 순서가 중요한가: storage.js의 getObject()는 OBJECT_STORAGE_BUCKET이 설정되어 있으면
//   "무조건" S3만 보고, 로컬 디스크는 아예 확인하지 않는다. 즉 환경변수부터 먼저 켜버리면,
//   아직 이 스크립트로 옮기지 않은 기존 파일(업체가 이미 제출한 사업자등록증 사본 등)에
//   그 순간부터 "파일을 찾을 수 없음" 오류가 발생한다 — 실제 서비스 중단 사고로 이어질 수 있다.
//
// 데이터 보존 방법(안전장치):
//   1) 기본값은 "복사"이지 "이동"이 아니다 — --delete-local을 명시적으로 주지 않으면 로컬
//      원본 파일은 그대로 남는다(이전 실패 시에도 데이터 유실이 없음).
//   2) 업로드 직후 다시 읽어와 바이트 크기를 대조하는 방식으로 검증한 파일만 "성공"으로 센다.
//   3) 이미 S3에 같은 크기로 존재하는 파일은 다시 올리지 않고 건너뛴다 — 여러 번 실행해도 안전(멱등).
//   4) --dry-run(기본값)으로 먼저 몇 개나 옮겨질지 확인한 뒤에만 --apply로 실제 이전한다.
//
// 실행 방법:
//   필요 환경변수(이전 "목적지"를 알려주는 값 — 이걸 설정한다고 운영 서버가 바로 S3를 쓰게 되는
//   것은 아니다. server.js가 아니라 이 스크립트 프로세스에서만 쓰는 값이다):
//     OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_REGION, OBJECT_STORAGE_ENDPOINT,
//     OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_SECRET_ACCESS_KEY,
//     OBJECT_STORAGE_FORCE_PATH_STYLE(선택), LOCAL_STORAGE_DIR(선택 — 안 주면 기존 기본 경로)
//
//   1. DB_PATH=./roomer.db OBJECT_STORAGE_BUCKET=... (위 값들 모두 설정) node migrate-files-to-s3.js
//      → 미리보기만(실제 업로드 없음)
//   2. 같은 환경변수로 ... node migrate-files-to-s3.js --apply
//      → 실제로 S3에 업로드(로컬 원본은 보존)
//   3. 완전히 확인 끝나고 로컬 디스크를 정리하고 싶을 때만(선택):
//      ... node migrate-files-to-s3.js --apply --delete-local
// ============================================================================

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const APPLY = process.argv.includes('--apply');
const DELETE_LOCAL = process.argv.includes('--delete-local');

const bucket = process.env.OBJECT_STORAGE_BUCKET || '';
if (!bucket) {
  console.error('OBJECT_STORAGE_BUCKET 환경변수가 없습니다. 이전 "목적지" S3 버킷 정보를 먼저 설정해주세요.');
  process.exit(1);
}
if (DELETE_LOCAL && !APPLY) {
  console.error('--delete-local은 --apply와 함께만 쓸 수 있습니다(미리보기 모드에서는 아무것도 지우지 않습니다).');
  process.exit(1);
}

const client = new S3Client({
  region: process.env.OBJECT_STORAGE_REGION || 'auto',
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT || undefined,
  forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
  credentials: process.env.OBJECT_STORAGE_ACCESS_KEY_ID && process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  } : undefined
});

const LOCAL_STORE_DIR = process.env.LOCAL_STORAGE_DIR || path.join(__dirname, 'uploads', 'private-store');

const db = require(path.join(__dirname, 'db.js'));

function localKeyToPath(key) {
  const normalized = path.normalize(key).replace(/^([.][.][/\\])+/, '').replace(/^([/\\])+/, '');
  return path.join(LOCAL_STORE_DIR, normalized);
}

async function alreadyUploaded(key, expectedSize) {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength === expectedSize;
  } catch (e) {
    return false; // 없으면(NotFound) 아직 이전 안 된 것
  }
}

async function main() {
  const files = db.prepare(`SELECT * FROM stored_files WHERE deleted_at IS NULL ORDER BY created_at ASC`).all();
  console.log(`===== 파일 이전 (${APPLY ? '실제 반영 모드' : '미리보기 모드 — 업로드 없음'}) =====`);
  console.log(`stored_files 총 ${files.length}건 검사 시작 (로컬 폴더: ${LOCAL_STORE_DIR})\n`);

  let found = 0, alreadyDone = 0, notFoundLocally = 0, migrated = 0, failed = 0;

  for (const file of files) {
    const localPath = localKeyToPath(file.storage_key);
    if (!fs.existsSync(localPath)) { notFoundLocally++; continue; } // 이미 S3 전용 환경이었거나, 이미 이전+삭제된 경우
    found++;
    const stat = fs.statSync(localPath);

    const done = await alreadyUploaded(file.storage_key, stat.size);
    if (done) {
      alreadyDone++;
      if (APPLY && DELETE_LOCAL) fs.unlinkSync(localPath);
      continue;
    }

    if (!APPLY) continue; // 미리보기: 개수만 센다

    try {
      const body = fs.readFileSync(localPath);
      const isPublic = file.visibility === 'public';
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: file.storage_key, Body: body, ContentType: file.mime_type,
        CacheControl: isPublic ? 'public,max-age=31536000,immutable' : 'private,no-store'
      }));
      const verified = await alreadyUploaded(file.storage_key, stat.size);
      if (!verified) throw new Error('업로드 후 크기 검증 실패');
      migrated++;
      if (DELETE_LOCAL) fs.unlinkSync(localPath);
    } catch (e) {
      failed++;
      console.error(`  실패: ${file.storage_key} — ${e.message}`);
    }
  }

  console.log(`\n로컬에 실제 파일 있음: ${found}건`);
  console.log(`이미 S3에 있음(건너뜀): ${alreadyDone}건`);
  console.log(`로컬에 파일 없음(이미 이전됐거나 원래 S3 전용): ${notFoundLocally}건`);
  if (APPLY) {
    console.log(`이번에 새로 업로드 성공: ${migrated}건`);
    if (failed) console.log(`실패: ${failed}건 — 위 로그를 확인하고 다시 실행해주세요(멱등이라 재실행 안전).`);
    console.log(DELETE_LOCAL ? '로컬 원본은 검증 성공한 파일에 한해 삭제했습니다.' : '로컬 원본은 그대로 남겨뒀습니다(--delete-local을 안 줬으므로).');
  } else {
    console.log(`\n실제로 이전하려면: --apply 플래그를 붙여 다시 실행하세요.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
