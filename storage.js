'use strict';

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const bucket = process.env.OBJECT_STORAGE_BUCKET || '';
const publicBaseUrl = String(process.env.OBJECT_STORAGE_PUBLIC_BASE_URL || '').replace(/\/$/, '');
const client = bucket ? new S3Client({
  region: process.env.OBJECT_STORAGE_REGION || 'auto',
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT || undefined,
  forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
  credentials: process.env.OBJECT_STORAGE_ACCESS_KEY_ID && process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  } : undefined
}) : null;

// 결함수정(사용자 지적 — 사업자등록증 등 첨부 시 "객체 저장소 환경변수가 설정되지 않았습니다"
// 오류가 계속 발생): OBJECT_STORAGE_* 환경변수가 없는 배포/개발 환경에서는 파일 업로드 기능 자체가
// 항상 503으로 막혀 있었음(가짜로 "성공"한 척하지 않고 정직하게 에러를 던진 것 자체는 맞는 설계였지만,
// 실제로 아무 환경에서도 이 기능이 동작하지 않는 건 문제) — OBJECT_STORAGE_BUCKET이 없을 때는
// 이 서버의 로컬 디스크(uploads/private-store)에 실제로 저장·조회·삭제하는 폴백을 추가해 항상
// 동작하도록 한다. OBJECT_STORAGE_BUCKET을 설정하면 지금까지처럼 실제 S3 호환 스토리지를 그대로
// 쓰고 이 폴백은 전혀 개입하지 않는다.
// 주의: 로컬 폴백은 이 서버 프로세스가 떠 있는 디스크에 저장되므로, 디스크가 배포마다 초기화되는
// 호스팅(예: Render의 기본 웹서비스)에서는 재배포 시 첨부파일이 사라질 수 있다 — 운영 환경에서는
// 반드시 OBJECT_STORAGE_*를 설정해 실제 영구 스토리지를 쓸 것.
// 신규(사용자요청 — DB 영속성 점검 후속): Render Persistent Disk를 마운트했다면 LOCAL_STORAGE_DIR
// 환경변수로 그 마운트 경로 하위 폴더(예: /var/data/uploads/private-store)를 지정해 로컬 폴백도
// 같은 디스크에 저장되게 할 수 있다. 미설정 시 기존과 동일하게 서버 코드 옆 폴더를 사용(재배포시 유실).
const LOCAL_STORE_DIR = process.env.LOCAL_STORAGE_DIR || path.join(__dirname, 'uploads', 'private-store');

function localKeyToPath(key) {
  // key는 서버 코드가 만든 값(예: private/partner-signup/.../uuid.pdf)이라 '..' 등 위험한
  // 세그먼트가 섞일 수 없지만, 방어적으로 한 번 더 정규화해 저장 루트 바깥으로 못 나가게 한다.
  const normalized = path.normalize(key).replace(/^([.][.][/\\])+/, '').replace(/^([/\\])+/, '');
  return path.join(LOCAL_STORE_DIR, normalized);
}

function localPublicUrl(key) {
  // public/ 로 시작하는 키만 실제로 브라우저가 바로 열 수 있는 URL을 돌려준다(server.js의
  // /storage-local/public 정적 서빙과 짝을 이룸). private/ 키는 지금까지처럼 URL을 만들지 않는다.
  if (!key.startsWith('public/')) return null;
  return '/storage-local/' + key.split('/').map(encodeURIComponent).join('/');
}

function assertConfigured() {
  // 로컬 디스크 폴백이 생기면서 "설정 안 됨" 상태 자체가 없어짐 — 항상 저장소를 쓸 수 있다.
}

async function putObject({ key, body, contentType, isPublic }) {
  if (client) {
    if (isPublic && !publicBaseUrl) {
      const error = new Error('공개 파일 URL 환경변수가 설정되지 않았습니다');
      error.code = 'OBJECT_STORAGE_PUBLIC_URL_NOT_CONFIGURED'; error.status = 503; throw error;
    }
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType,
      CacheControl: isPublic ? 'public,max-age=31536000,immutable' : 'private,no-store' }));
    return isPublic && publicBaseUrl ? `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}` : null;
  }
  const filePath = localKeyToPath(key);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, body);
  return isPublic ? localPublicUrl(key) : null;
}

async function getObject(key) {
  if (client) {
    return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  }
  const filePath = localKeyToPath(key);
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat) {
    const error = new Error('파일을 찾을 수 없습니다');
    error.code = 'NoSuchKey'; error.status = 404; throw error;
  }
  return { Body: fs.createReadStream(filePath), ContentLength: stat.size };
}

async function deleteObject(key) {
  if (client) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return;
  }
  await fs.promises.rm(localKeyToPath(key), { force: true });
}

module.exports = { assertConfigured, putObject, getObject, deleteObject };
