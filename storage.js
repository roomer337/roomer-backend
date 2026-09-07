'use strict';

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

function assertConfigured() {
  if (!client || !bucket) {
    const error = new Error('객체 저장소 환경변수가 설정되지 않았습니다');
    error.code = 'OBJECT_STORAGE_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
}

async function putObject({ key, body, contentType, isPublic }) {
  assertConfigured();
  if (isPublic && !publicBaseUrl) {
    const error = new Error('공개 파일 URL 환경변수가 설정되지 않았습니다');
    error.code = 'OBJECT_STORAGE_PUBLIC_URL_NOT_CONFIGURED'; error.status = 503; throw error;
  }
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    CacheControl: isPublic ? 'public,max-age=31536000,immutable' : 'private,no-store' }));
  return isPublic && publicBaseUrl ? `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}` : null;
}

async function getObject(key) {
  assertConfigured();
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

async function deleteObject(key) {
  assertConfigured();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = { assertConfigured, putObject, getObject, deleteObject };
