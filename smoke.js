const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const root = '/home/claude/roomer';
const dbPath = path.join(os.tmpdir(), `roomer-smoke-${process.pid}.db`);
const secret = 'roomer-smoke-secret-at-least-thirty-two-characters';
const port = 4222;
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  // GEO_TEST_MODE=true: 실제 카카오 API를 호출하지 않는 결정론적 좌표→지역 스텁을 켠다(ALIGO_TEST_MODE와
  // 동일한 취지 — 이 값은 운영 환경에서는 절대 설정하지 않고, 여기서만 좌표변환 앞뒤 로직을 검증하기 위해 사용)
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: secret, NODE_ENV: 'test', ENABLE_DEV_TEST_ROUTES: 'false', GEO_TEST_MODE: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', d => process.stdout.write('[srv] ' + d));
server.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));

function token(sub, role) { return jwt.sign({ sub, role }, secret, { expiresIn: '10m' }); }
async function api(method, url, body, auth) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json; try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json };
}
// 신규(2026-09, 광고 예약형 재설계 스모크): PATCH /api/ads/reservations/:id/content는 multipart/form-data라
// tests/integration.js의 buildMultipart/apiMultipart 패턴을 그대로 이식(POST 전용이던 걸 method 인자로 일반화).
function buildMultipart(fields, fileField, filename, mime, data) {
  const boundary = '----smoke' + Date.now();
  let parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(data); parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
async function apiMultipart(method, url, multipart, auth) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { 'content-type': multipart.contentType, ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: multipart.body
  });
  let json; try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json };
}
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
function dateOnlyStr(d) { return d.toISOString().slice(0, 10); }
function addDaysStr(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return dateOnlyStr(d); }
async function waitReady() {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok || r.status === 404) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
}
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('OK  ', name); }
  else { fail++; console.log('FAIL', name, JSON.stringify(detail)); }
}

(async () => {
  try {
    await waitReady();
    const db = new Database(dbPath);
    db.exec(`INSERT INTO users(id,social_provider,social_id,nickname,cash_balance) VALUES ('u1','qa','u1','소비자1',0);`);
    const insertPartner = db.prepare(`INSERT INTO partners(id,login_provider,login_id,business_name,business_reg_number,ceo_name,tier,region,doc_image_url,verify_status,credit_balance,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
    insertPartner.run('p1', 'email', 'p1@test.dev', '승인업체1(부분공사가능업체)', '111-11-11111', '대표1', '부분공사가능업체', '서울 강남구', 'file', 'approved', 0);
    insertPartner.run('p2', 'email', 'p2@test.dev', '승인업체2(광고주)', '222-22-22222', '대표2', '면허 파트너', '서울 송파구', 'file', 'approved', 500000);
    insertPartner.run('p3', 'email', 'p3@test.dev', '노쇼업체', '333-33-33333', '대표3', '면허 파트너', '서울 마포구', 'file', 'approved', 0);
    const { randomUUID } = require('crypto');
    const roomId = randomUUID();
    db.prepare(`INSERT INTO chat_rooms (id, consumer_id, partner_id) VALUES (?,?,?)`).run(roomId, 'u1', 'p3');
    const noshowLog = JSON.stringify([
      { reportedBy: 'consumer', reporterId: 'u1', reason: '연락두절', at: new Date(Date.now() - 200000).toISOString() },
      { reportedBy: 'consumer', reporterId: 'u1', reason: '재차 노쇼', at: new Date().toISOString() }
    ]);
    db.prepare(`INSERT INTO meas_jobs (room_id, noshow_log) VALUES (?,?)`).run(roomId, noshowLog);
    db.close();

    const p1 = token('p1', 'partner'), p2 = token('p2', 'partner'), admin = token('admin1', 'admin_super');
    let r;

    // ---- 등급 승급 심사 (부분공사가능업체 → 인증사업자: 면허번호 불필요) ----
    r = await api('POST', '/api/partners/me/tier-upgrade', { docName: '하자보증보험 가입증서' }, p1);
    check('승급신청 성공(인증사업자, 면허 불필요)', r.status === 200 && r.json.success && r.json.data.toTier === '인증사업자', r);
    const tierId = r.json.data.id;

    r = await api('POST', '/api/partners/me/tier-upgrade', { licenseNumber: 'x' }, p1);
    check('중복 승급신청 차단(409)', r.status === 409, r);

    r = await api('GET', '/api/partners/me/tier-upgrade', null, p1);
    check('본인 승급신청 조회', r.status === 200 && r.json.data.status === 'admin_review', r);

    r = await api('GET', '/api/admin/tier-upgrades', null, admin);
    check('관리자 승급 큐에 노출', r.status === 200 && r.json.data.some(x => x.id === tierId && x.partnerName.includes('승인업체1')), r);

    r = await api('GET', '/api/admin/dashboard/counts', null, admin);
    check('대시보드 tier 카운트=1', r.status === 200 && r.json.data.tier === 1, r);

    r = await api('PATCH', `/api/admin/tier-upgrades/${tierId}/approve`, {}, admin);
    check('승급 승인', r.status === 200 && r.json.data.status === 'approved', r);

    r = await api('GET', '/api/partners/me', null, p1);
    check('승인 후 partner.tier 갱신', r.status === 200 && r.json.data.tier === '인증사업자', r);

    r = await api('PATCH', `/api/admin/tier-upgrades/${tierId}/approve`, {}, admin);
    check('이미 심사완료 재승인 차단(409)', r.status === 409, r);

    // ---- 인증사업자 → 면허 파트너: 면허번호 필수 ----
    r = await api('POST', '/api/partners/me/tier-upgrade', {}, p1);
    check('면허번호 없이 면허파트너 승급신청 시 400', r.status === 400, r);
    r = await api('POST', '/api/partners/me/tier-upgrade', { licenseNumber: '실내건축 제1234호', issuer: '서울특별시청' }, p1);
    check('면허번호 포함 승급신청 성공', r.status === 200 && r.json.data.toTier === '면허 파트너', r);
    const tierId2 = r.json.data.id;
    r = await api('PATCH', `/api/admin/tier-upgrades/${tierId2}/reject`, { reason: '면허 진위 확인 불가' }, admin);
    check('승급 반려', r.status === 200 && r.json.data.status === 'rejected', r);
    r = await api('GET', '/api/partners/me', null, p1);
    check('반려시 tier 변경 없음(계속 인증사업자)', r.status === 200 && r.json.data.tier === '인증사업자', r);

    // ---- 광고 크레딧 충전 (TOSS_CLIENT_KEY 미설정 상태이므로 503만 확인) ----
    r = await api('POST', '/api/credit/topup', { amount: 100000 }, p2);
    check('크레딧 충전(결제키 미설정 → 503)', r.status === 503, r);

    // ---- 광고자리 예약(달력형, 지역당 6자리, 관리자 승인 없음) — p2는 credit_balance 500000, region 서울 송파구 ----
    r = await api('GET', '/api/ads/availability?region=서울 송파구&days=10', null, p2);
    check('광고 달력 조회(지역당 6자리, 오늘 제외 내일부터)', r.status === 200 && r.json.data.capacity === 6 && r.json.data.calendar.length === 10 && r.json.data.calendar[0].available === 6 && r.json.data.pricePerDay === 9900, r);

    const adTomorrow = addDaysStr(1);
    r = await api('POST', '/api/ads/reservations', { region: '서울 송파구', startDate: dateOnlyStr(new Date()), endDate: adTomorrow }, p2);
    check('오늘 날짜로 예약 시도는 거부(오늘 결제하면 내일부터)', r.status === 400, r);

    const adStart = addDaysStr(1), adEnd = addDaysStr(3); // 3일 예약
    r = await api('POST', '/api/ads/reservations', { region: '서울 송파구', startDate: adStart, endDate: adEnd }, p2);
    check('광고자리 예약 성공(3일, 관리자 승인 없이 즉시 확정)', r.status === 200 && r.json.data.days === 3 && r.json.data.cost === 29700 && r.json.data.pricePerDay === 9900, r);
    const adId = r.json.data.id;

    r = await api('GET', '/api/ads/mine', null, p2);
    check('내 광고 목록 조회(결제 직후 상태=pending_content)', r.status === 200 && r.json.data.length === 1 && r.json.data[0].status === 'pending_content', r);

    r = await api('GET', '/api/ads/active?region=서울 송파구');
    check('내용(사진·문구) 미등록 광고는 공개조회에 안 잡힘(허수 데이터 금지 원칙)', r.status === 200 && r.json.data.length === 0, r);

    // "정해진 틀" 등록: 사진(JPEG 매직바이트) + 24자 이내 문구 + 키워드 2개 — 관리자 승인 없이 이 요청만으로 자동노출 확정
    let mp = buildMultipart({ tagline: '정직한 시공, 루머 인증업체', keywords: JSON.stringify(['24시간상담', '무료견적']) }, 'photo', 'ad.jpg', 'image/jpeg', JPEG_HEADER);
    r = await apiMultipart('PATCH', `/api/ads/reservations/${adId}/content`, mp, p2);
    check('광고 내용 등록 성공(사진+문구+키워드, 관리자 승인 없이 자동완료)', r.status === 200 && r.json.data.tagline === '정직한 시공, 루머 인증업체' && r.json.data.keywords.length === 2 && !!r.json.data.imageUrl && r.json.data.heroSlideIndex === 0, r);

    mp = buildMultipart({ tagline: 'a'.repeat(25), keywords: '[]' }, 'photo', 'ad.jpg', 'image/jpeg', JPEG_HEADER);
    r = await apiMultipart('PATCH', `/api/ads/reservations/${adId}/content`, mp, p2);
    check('한 줄 문구 24자 초과는 "정해진 틀" 위반으로 거부', r.status === 400, r);

    r = await api('GET', '/api/ads/mine', null, p2);
    check('내용 등록 후 상태=scheduled(시작일 전)', r.status === 200 && r.json.data[0].status === 'scheduled' && r.json.data[0].remainingDays >= 0, r);

    r = await api('GET', '/api/admin/ads', null, admin);
    check('관리자 전체광고 조회(승인/반려 없이 현황만)', r.status === 200 && r.json.data.length === 1 && r.json.data[0].partnerName.includes('광고주') && r.json.data[0].status === 'scheduled', r);

    r = await api('GET', '/api/credit/ledger/mine', null, p2);
    check('내 크레딧 원장 조회(광고비 소진 1건)', r.status === 200 && r.json.data.length === 1 && r.json.data[0].type === 'ad_purchase', r);

    r = await api('GET', '/api/partners/me', null, p2);
    const balanceAfterAd = r.json.data.credit_balance;
    check('광고비 차감 확인(500000-29700, 9900원×3일)', balanceAfterAd === 500000 - 29700, { balanceAfterAd });

    // 지역당 6자리 정원 초과 방지: 같은 지역·같은 날짜에 6건 예약해서 정원을 정확히 채운 뒤, 7번째는 차단돼야 함
    const capStart = addDaysStr(10), capEnd = addDaysStr(10);
    for (let i = 0; i < 6; i++) {
      r = await api('POST', '/api/ads/reservations', { region: '서울 송파구', startDate: capStart, endDate: capEnd }, p2);
      check(`정원 채우기 예약 ${i + 1}/6 성공`, r.status === 200, r);
    }
    r = await api('POST', '/api/ads/reservations', { region: '서울 송파구', startDate: capStart, endDate: capEnd }, p2);
    check('지역당 6자리 정원이 다 찬 뒤 7번째 예약은 차단', r.status === 400 && r.json.error.code === 'CAPACITY_FULL', r);

    // ---- 어뷰징(반복 노쇼) ----
    r = await api('GET', '/api/admin/abuse/queue', null, admin);
    check('노쇼 2회 업체가 어뷰징 큐에 노출', r.status === 200 && r.json.data.some(x => x.roomId === roomId && x.partnerName.includes('노쇼업체') && x.noshowCount === 2), r);

    r = await api('GET', '/api/admin/dashboard/counts', null, admin);
    check('대시보드 abuse 카운트=1', r.status === 200 && r.json.data.abuse === 1, r);

    r = await api('POST', `/api/admin/abuse/${roomId}/action`, { action: 'suspend', note: '반복 노쇼 확인됨' }, admin);
    check('어뷰징 정지 조치', r.status === 200 && r.json.data.action === 'suspend', r);

    r = await api('GET', '/api/admin/abuse/queue', null, admin);
    check('조치 후 큐에서 제외', r.status === 200 && !r.json.data.some(x => x.roomId === roomId), r);

    r = await api('POST', '/api/otp/email/verify', { email: 'p3@test.dev', code: '000000', forPartner: true, partnerMode: 'login' });
    // 이 호출은 OTP 미발급이라 400이 나겠지만, 그보다 먼저 partner_not_found/suspended 체크가 오면 안됨(로그인 로직상 OTP 검증이 선행되므로 400 OTP_NOT_FOUND가 정상)
    check('정지업체 로그인 시도(OTP 라우트 정상 응답)', r.status === 400, r);

    r = await api('GET', '/api/partners/search?region=' + encodeURIComponent('서울 마포구'));
    check('정지된 업체는 검색에서 제외', r.status === 200 && !r.json.data.some(x => x.id === 'p3'), r);

    // authRequired 미들웨어 즉시차단 확인: p3로 서명한 토큰으로 인증필요 API 호출
    const p3 = token('p3', 'partner');
    r = await api('GET', '/api/partners/me', null, p3);
    check('정지된 업체 토큰 즉시 차단(403 PARTNER_SUSPENDED)', r.status === 403 && r.json.error.code === 'PARTNER_SUSPENDED', r);

    r = await api('PATCH', '/api/admin/partners/p3/unsuspend', {}, admin);
    check('정지 해제', r.status === 200, r);
    r = await api('GET', '/api/partners/me', null, p3);
    check('정지 해제 후 다시 정상 접근', r.status === 200, r);

    // ---- 포트폴리오 게시 승인(신규: "완공검수 승인" 화면 실연동) ----
    const db2 = new Database(dbPath);
    const projId = randomUUID();
    db2.prepare("INSERT INTO portfolio_projects (id, partner_id, title, description, status) VALUES (?,?,?,?,'pending')")
      .run(projId, 'p1', '거실 리모델링', '화이트톤 거실 시공 사례');
    db2.close();

    r = await api('GET', '/api/portfolio/feed', null);
    check('승인 전 포트폴리오는 피드에 노출 안됨', r.status === 200 && !r.json.data.some(x => x.id === projId), r);

    r = await api('GET', '/api/partners/p1/portfolio', null);
    check('승인 전 포트폴리오는 업체 상세에도 노출 안됨', r.status === 200 && !r.json.data.some(x => x.id === projId), r);

    r = await api('GET', '/api/admin/portfolio/pending', null, admin);
    check('관리자 포트폴리오 대기열에 노출', r.status === 200 && r.json.data.some(x => x.id === projId && x.business_name.includes('승인업체1')), r);

    r = await api('PUT', `/api/admin/portfolio/${projId}/approve`, {}, admin);
    check('포트폴리오 승인', r.status === 200, r);

    r = await api('GET', '/api/admin/portfolio/pending', null, admin);
    check('승인 후 대기열에서 제외', r.status === 200 && !r.json.data.some(x => x.id === projId), r);

    r = await api('GET', '/api/portfolio/feed', null);
    check('승인 후 피드에 노출', r.status === 200 && r.json.data.some(x => x.id === projId), r);

    r = await api('GET', '/api/partners/p1/portfolio', null);
    check('승인 후 업체 상세에도 노출', r.status === 200 && r.json.data.some(x => x.id === projId), r);

    const projId2 = randomUUID();
    const db3 = new Database(dbPath);
    db3.prepare("INSERT INTO portfolio_projects (id, partner_id, title, description, status) VALUES (?,?,?,?,'pending')")
      .run(projId2, 'p1', '주방 리모델링', '대면형 아일랜드 주방 시공');
    db3.close();
    r = await api('PUT', `/api/admin/portfolio/${projId2}/reject`, { reason: '사진 품질 미달' }, admin);
    check('포트폴리오 반려', r.status === 200, r);
    r = await api('GET', '/api/portfolio/feed', null);
    check('반려건은 피드에 노출 안됨', r.status === 200 && !r.json.data.some(x => x.id === projId2), r);
    r = await api('PUT', `/api/admin/portfolio/${projId2}/reject`, { reason: '' }, admin);
    check('빈 반려사유는 거부(400)', r.status === 400, r);

    // ===== 신규(2026-09, 결제기능 전수조사 후속): 소비자 포인트충전·결제수단등록·AI감리 결제 실연동 스모크 =====
    // TOSS_CLIENT_KEY/TOSS_SECRET_KEY가 없는 테스트 환경이라 실제 토스 승인까지는 검증할 수 없지만,
    // (1) 결제가 필요한 순간 정확히 503(PAYMENT_NOT_CONFIGURED)으로 막히는지 — 예전처럼 가짜로 성공처리되지 않는지,
    // (2) 크레딧만으로 전액결제가 되는 경로는 실제로 DB를 원자적으로 반영하는지,
    // (3) 권한(본인/역할) 검증이 정확한지를 확인한다.
    const db4 = new Database(dbPath);
    db4.prepare("UPDATE users SET cash_balance=45000 WHERE id='u1'").run();
    db4.prepare("INSERT INTO users(id,social_provider,social_id,nickname,cash_balance) VALUES ('u2x','qa','u2x','타인소비자',0)").run();
    const contractId = randomUUID();
    db4.prepare(`INSERT INTO contracts (id, consumer_id, partner_id, fee_rate_snapshot, status) VALUES (?,?,?,?,?)`)
      .run(contractId, 'u1', 'p1', 0.05, 'confirmed');
    db4.close();
    const u1 = token('u1', 'consumer'), u2x = token('u2x', 'consumer');

    // ---- 소비자 포인트 충전(결제키 미설정 → 503) / 권한 검증 ----
    r = await api('POST', '/api/points/topup', { amount: 100000 }, u1);
    check('포인트 충전(결제키 미설정 → 503)', r.status === 503, r);
    r = await api('POST', '/api/points/topup', { amount: 100000 }, p1);
    check('포인트 충전은 소비자 전용(파트너 403)', r.status === 403, r);
    r = await api('POST', '/api/points/topup', { amount: 1000 }, u1);
    check('포인트 충전 최소금액 미만 400', r.status === 400, r);

    // ---- 결제수단(카드) 등록(결제키 미설정 → 503) / 권한 검증 ----
    r = await api('POST', '/api/payment-methods/register', {}, u1);
    check('결제수단 등록(결제키 미설정 → 503)', r.status === 503, r);
    r = await api('POST', '/api/payment-methods/register', {}, p1);
    check('결제수단 등록은 소비자 전용(파트너 403)', r.status === 403, r);
    r = await api('GET', '/api/payment-methods', null, u1);
    check('결제수단 목록 조회(빈 배열)', r.status === 200 && Array.isArray(r.json.data) && r.json.data.length === 0, r);
    r = await api('DELETE', '/api/payment-methods/nope', null, u1);
    check('존재하지않는 결제수단 삭제 404', r.status === 404, r);

    // ---- AI 감리(사진감리) 결제: 보유크레딧(45000) >= 가격(40000) → 크레딧 전액결제(즉시, 실제 DB원자처리) ----
    r = await api('POST', '/api/inspections', { contractId, plan: 'photo', photoCount: 5 }, u1);
    check('사진감리 신청 성공(가격 40000)', r.status === 200 && r.json.data.price === 40000 && r.json.data.status === 'unpaid', r);
    const inspId1 = r.json.data.id;

    r = await api('POST', `/api/inspections/${inspId1}/pay`, {}, p1);
    check('감리결제는 계약 소비자 본인만(파트너 403)', r.status === 403, r);
    r = await api('POST', `/api/inspections/${inspId1}/pay`, {}, u2x);
    check('감리결제는 계약 소비자 본인만(타인 403)', r.status === 403, r);

    r = await api('POST', `/api/inspections/${inspId1}/pay`, { useCreditFull: true }, u1);
    check('크레딧 전액결제 성공(즉시 paid)', r.status === 200 && r.json.data.status === 'paid' && r.json.data.creditUsed === 40000 && r.json.data.remainderAmount === 0, r);

    r = await api('GET', '/api/users/me', null, u1);
    check('크레딧 전액결제 후 잔액 정확히 차감(45000-40000=5000)', r.status === 200 && r.json.data.cash_balance === 5000, r);

    r = await api('POST', `/api/inspections/${inspId1}/pay`, { useCreditFull: true }, u1);
    check('이미 결제완료된 감리 재결제 차단(400)', r.status === 400 && r.json.error.code === 'ALREADY_PAID', r);

    // ---- 두번째 감리: 보유크레딧(5000) < 가격(40000) → 크레딧 자동 일부사용 + 나머지는 토스 결제 필요(결제키 미설정 → 503) ----
    r = await api('POST', '/api/inspections', { contractId, plan: 'photo', photoCount: 5 }, u1);
    check('두번째 사진감리 신청 성공', r.status === 200, r);
    const inspId2 = r.json.data.id;

    r = await api('POST', `/api/inspections/${inspId2}/pay`, {}, u1);
    check('잔액 부족분 결제 시도(결제키 미설정 → 503, 가짜성공 아님)', r.status === 503 && r.json.error.code === 'PAYMENT_NOT_CONFIGURED', r);

    r = await api('GET', '/api/users/me', null, u1);
    check('결제키 미설정으로 실패했을 때 크레딧은 아직 차감되지 않음(여전히 5000)', r.status === 200 && r.json.data.cash_balance === 5000, r);

    r = await api('POST', `/api/inspections/${inspId2}/pay/confirm`, { paymentKey: 'fake-key' }, u1);
    check('토스 주문 생성 전(order_id 없음) 결제승인 시도 차단(400)', r.status === 400 && r.json.error.code === 'INVALID_STATE', r);

    // ===== 신규(2026-09, 운영콘솔 전수조사 후속): 관리자 "정책 설정"이 실제 계약·결제 계산에
    // 반영되는지, 그리고 새로 실연동한 분쟁/정산/이벤트 관리자 API가 정상 동작하는지 검증 =====
    const db5 = new Database(dbPath);
    const reqId1 = randomUUID(), quoteId1 = randomUUID();
    db5.prepare(`INSERT INTO quote_requests (id, user_id, partner_id, status) VALUES (?,?,?,?)`).run(reqId1, 'u1', 'p2', 'quoted');
    db5.prepare(`INSERT INTO quotes (id, request_id, partner_id, total_amount, status) VALUES (?,?,?,?,?)`).run(quoteId1, reqId1, 'p2', 1000000, 'accepted');
    db5.close();

    // ---- 정책 설정: 등급별 수수료율을 관리자가 바꾸면 "새로 확정되는 계약"에 실제로 반영돼야 함
    // (사용자 제보: "2%로 저장해도 파트너 가입시 자동되는 설정값이 변화가 없다") ----
    r = await api('PUT', '/api/admin/policy', { key: 'tier_fee_rates', value: { '면허 파트너': 0.05 } }, admin);
    check('관리자 정책저장: 등급별 수수료율 오버라이드 저장 성공', r.status === 200, r);
    r = await api('GET', '/api/admin/policy/tier_fee_rates', null, admin);
    check('저장한 수수료율 정책이 그대로 다시 조회됨', r.status === 200 && r.json.data.value['면허 파트너'] === 0.05, r);

    r = await api('POST', '/api/contracts', { quoteId: quoteId1, deposit: 100000, down: 300000, middle: 300000, final: 300000 }, u1);
    check('계약 확정 시 관리자가 바꾼 수수료율(5%)이 하드코딩 기본값(1.5%) 대신 실제로 적용됨', r.status === 200 && r.json.data.feeRateSnapshot === 0.05, r);
    const contractId1 = r.json.data.id;

    r = await api('GET', '/api/admin/settlements', null, admin);
    const settle1 = r.json.data && r.json.data.find(s => s.contractId === contractId1);
    check('신규: 관리자 정산목록 API — 업체명 조인 포함, 수수료율도 오버라이드값 그대로', r.status === 200 && !!settle1 && settle1.partnerName === '승인업체2(광고주)' && settle1.feeRate === 0.05, r);

    // ---- AI 공사감리 요금제 오버라이드: 사진감리 장당가를 바꾸면 실제 결제금액에 반영돼야 함 ----
    r = await api('PUT', '/api/admin/policy', { key: 'inspect_plan_pricing', value: { photo: { unitPrice: 10000 } } }, admin);
    check('관리자 정책저장: 사진감리 장당가 오버라이드 저장 성공', r.status === 200, r);
    r = await api('POST', '/api/inspections', { contractId: contractId1, plan: 'photo', photoCount: 5 }, u1);
    check('사진감리 가격이 관리자가 바꾼 장당가(5장×1만원=5만원)로 계산됨(기본 8천원 아님)', r.status === 200 && r.json.data.price === 50000, r);
    await api('PUT', '/api/admin/policy', { key: 'inspect_plan_pricing', value: { photo: { unitPrice: 8000 } } }, admin); // 원복

    // ---- 광고 정원·단가 오버라이드(재설계 2026-09): 실제 예약(POST /api/ads/reservations)에 반영돼야 함 ----
    // (0 이하는 "정책 미설정"으로 간주해 기본값 6으로 폴백하는 서버쪽 안전장치가 있어, 1로 낮춰서 검증)
    r = await api('PUT', '/api/admin/policy', { key: 'ad_capacity_per_region', value: 1 }, admin);
    check('관리자 정책저장: 지역당 정원 오버라이드 저장 성공', r.status === 200, r);
    const polStart = addDaysStr(20), polEnd = addDaysStr(20);
    r = await api('POST', '/api/ads/reservations', { region: '서울 강남구', startDate: polStart, endDate: polEnd }, p2);
    check('정원 1로 낮춘 뒤 첫 예약은 성공', r.status === 200, r);
    r = await api('POST', '/api/ads/reservations', { region: '서울 강남구', startDate: polStart, endDate: polEnd }, p2);
    check('지역당 정원을 1로 낮추면 크레딧이 있어도 두번째 예약은 즉시 정원마감으로 차단됨(서버 기본값 6 무시하고 정책값 적용 확인)', r.status === 400 && r.json.error.code === 'CAPACITY_FULL', r);
    await api('PUT', '/api/admin/policy', { key: 'ad_capacity_per_region', value: 6 }, admin);
    r = await api('PUT', '/api/admin/policy', { key: 'ad_price_per_day', value: 1 }, admin);
    check('관리자 정책저장: 1일 단가 오버라이드 저장 성공', r.status === 200, r);
    r = await api('POST', '/api/ads/reservations', { region: '서울 서초구', startDate: polStart, endDate: polEnd }, p2);
    check('1일 단가를 1크레딧으로 낮추면 실제로 1크레딧만 차감됨(기본 9,900원 아님)', r.status === 200 && r.json.data.cost === 1 && r.json.data.pricePerDay === 1, r);
    await api('PUT', '/api/admin/policy', { key: 'ad_price_per_day', value: 9900 }, admin); // 원복

    // ---- 분쟁 유형 '기타' 접수 차단 결함 수정 확인 (전수조사 발견) ----
    r = await api('POST', '/api/disputes', { contractId: contractId1, type: 'etc', reason: '스모크테스트 기타분쟁' }, u1);
    check('분쟁유형 "기타"가 더 이상 서버에서 거부되지 않음(예전엔 INVALID_TYPE 400)', r.status === 200, r);
    const disputeId1 = r.json.data.id;
    await api('POST', `/api/disputes/${disputeId1}/ai-judge`, {}, u1);

    // ---- 관리자 분쟁 큐 실연동: 목록에 실제 뜨는지, 조정 시 서버에 실제 반영되는지 ----
    r = await api('GET', '/api/admin/disputes', null, admin);
    const disputeRow = r.json.data && r.json.data.find(d => d.id === disputeId1);
    check('신규: 관리자 분쟁목록 API — 방금 접수한 분쟁이 실제로 조회됨(예전엔 세션로컬이라 항상 안 보임)', r.status === 200 && !!disputeRow && disputeRow.partnerName === '승인업체2(광고주)', r);

    // 정산을 분쟁으로 보류시킨 상태를 흉내내어 "기각" 조정 시 실제로 해제되는지 확인
    const db6 = new Database(dbPath);
    db6.prepare(`UPDATE settlements SET status='hold', hold_reason='분쟁 조정 중' WHERE contract_id=?`).run(contractId1);
    db6.close();
    r = await api('PUT', `/api/disputes/${disputeId1}/resolve`, { decision: 'reject' }, admin);
    check('분쟁 "기각" 조정 시 보류된 정산이 실제로 해제됨(서버가 로컬상태만 바꾸던 결함 수정)', r.status === 200, r);
    r = await api('GET', '/api/admin/settlements', null, admin);
    const settleAfterReject = r.json.data.find(s => s.contractId === contractId1);
    check('기각 조정 후 정산 status가 received로 복구되고 hold_reason도 지워짐', settleAfterReject && settleAfterReject.status === 'received' && !settleAfterReject.holdReason, settleAfterReject);
    r = await api('PUT', `/api/disputes/${disputeId1}/resolve`, { decision: 'reject' }, admin);
    check('이미 조정 완료된 분쟁은 재조정 차단(409)', r.status === 409, r);

    // ---- 업체책임 조정 + 정산조정액 반영(별도 계약으로 재현) ----
    const reqId2 = randomUUID(), quoteId2 = randomUUID();
    const db7 = new Database(dbPath);
    db7.prepare(`INSERT INTO quote_requests (id, user_id, partner_id, status) VALUES (?,?,?,?)`).run(reqId2, 'u1', 'p2', 'quoted');
    db7.prepare(`INSERT INTO quotes (id, request_id, partner_id, total_amount, status) VALUES (?,?,?,?,?)`).run(quoteId2, reqId2, 'p2', 500000, 'accepted');
    db7.close();
    r = await api('POST', '/api/contracts', { quoteId: quoteId2, deposit: 500000 }, u1);
    const contractId2 = r.json.data.id;
    r = await api('POST', '/api/disputes', { contractId: contractId2, type: 'payment', reason: '정산 조정 스모크테스트' }, u1);
    const disputeId2 = r.json.data.id;
    await api('POST', `/api/disputes/${disputeId2}/ai-judge`, {}, u1);
    r = await api('PUT', `/api/disputes/${disputeId2}/resolve`, { decision: 'partner', settlementAdjustment: 50000 }, admin);
    check('분쟁 "업체책임" 조정 성공', r.status === 200, r);
    r = await api('GET', '/api/admin/settlements', null, admin);
    const settle2 = r.json.data.find(s => s.contractId === contractId2);
    check('업체책임 조정 시 정산은 계속 보류 상태로 남고 조정액(5만원)만큼 정산금액이 차감됨(50만→45만)', settle2 && settle2.status === 'hold' && settle2.amount === 450000, settle2);

    // ---- 이벤트 관리 실연동: 생성한 이벤트가 실제로 저장·조회·상태변경되는지 ----
    r = await api('POST', '/api/admin/events', { name: '스모크테스트 이벤트', start: '2026-09-01', end: '2026-09-30', target: 'all', benefit: '테스트 혜택' }, admin);
    check('신규: 관리자 이벤트 생성 API 성공(예전엔 새로고침하면 사라지던 프로토타입)', r.status === 200, r);
    const eventId1 = r.json.data.id;
    r = await api('GET', '/api/admin/events', null, admin);
    const eventRow = r.json.data.find(e => e.id === eventId1);
    check('생성한 이벤트가 목록에서 실제로 조회됨(참여자·전환은 가짜숫자 없이 0)', !!eventRow && eventRow.participants === 0 && eventRow.conversions === 0, eventRow);
    r = await api('PATCH', `/api/admin/events/${eventId1}/status`, { status: 'ended' }, admin);
    check('이벤트 상태 변경(종료) API 성공', r.status === 200, r);

    // ---- 신규: 소비자 회원관리(전체 목록·검색·정지/해제) ----
    r = await api('GET', '/api/admin/consumers?status=all', null, admin);
    const consumerRow = r.json.data && r.json.data.list.find(u => u.id === 'u1');
    check('소비자 전체 목록에 u1이 정상 조회됨(status=active)', r.status === 200 && !!consumerRow && consumerRow.status === 'active', r);
    r = await api('GET', '/api/admin/consumers?q=소비자1', null, admin);
    check('소비자 검색(닉네임)이 실제로 동작함', r.status === 200 && r.json.data.list.some(u => u.id === 'u1'), r);
    r = await api('PUT', '/api/admin/consumers/u1/suspend', { reason: '' }, admin);
    check('정지 사유 미입력시 400 차단', r.status === 400, r);
    r = await api('PUT', '/api/admin/consumers/u1/suspend', { reason: '스모크테스트 정지사유' }, admin);
    check('소비자 정지 처리 성공', r.status === 200, r);
    r = await api('GET', '/api/admin/consumers/u1', null, admin);
    check('정지 후 소비자 상세에 status=suspended·정지사유·처리이력이 반영됨', r.status === 200 && r.json.data.status === 'suspended' && r.json.data.suspendReason === '스모크테스트 정지사유' && r.json.data.actionHistory.some(a => a.action === 'suspend'), r.json.data);
    r = await api('GET', '/api/users/me', null, u1);
    check('정지된 소비자는 토큰이 남아있어도 즉시 차단됨(ACCOUNT_SUSPENDED)', r.status === 403 && r.json.error.code === 'ACCOUNT_SUSPENDED', r);
    r = await api('PUT', '/api/admin/consumers/u1/unsuspend', {}, admin);
    check('소비자 정지 해제 성공', r.status === 200, r);
    r = await api('GET', '/api/users/me', null, u1);
    check('정지 해제 후 다시 정상 이용 가능', r.status === 200, r);

    // ---- 신규: 파트너 회원관리(전체 목록·검색·필터·정지/해제) ----
    r = await api('GET', '/api/admin/partners?status=approved', null, admin);
    check('파트너 전체 목록(승인됨 필터)에 p2가 조회됨', r.status === 200 && r.json.data.list.some(p => p.id === 'p2'), r);
    r = await api('GET', '/api/admin/partners?q=승인업체2', null, admin);
    check('파트너 검색(상호명)이 실제로 동작함', r.status === 200 && r.json.data.list.some(p => p.id === 'p2'), r);
    r = await api('GET', '/api/admin/partners?tier=' + encodeURIComponent('면허 파트너'), null, admin);
    check('파트너 등급 필터가 실제로 동작함(면허 파트너만)', r.status === 200 && r.json.data.list.every(p => p.tier === '면허 파트너') && r.json.data.list.some(p => p.id === 'p2'), r);
    r = await api('GET', '/api/admin/partners/p2/detail', null, admin);
    check('파트너 상세(연관활동 포함)가 정상 조회됨', r.status === 200 && r.json.data.businessName === '승인업체2(광고주)' && typeof r.json.data.activity.contracts === 'number', r.json.data);
    r = await api('PUT', '/api/admin/partners/p2/suspend', { reason: '스모크테스트 업체정지' }, admin);
    check('파트너 정지(회원관리 화면 경로) 성공', r.status === 200, r);
    r = await api('GET', '/api/admin/partners/p2/detail', null, admin);
    check('정지 후 파트너 상세에 status=suspended·처리이력이 반영됨', r.status === 200 && r.json.data.status === 'suspended' && r.json.data.actionHistory.some(a => a.action === 'suspend'), r.json.data);
    r = await api('GET', '/api/partners/me', null, p2);
    check('정지된 파트너는 토큰이 남아있어도 즉시 차단됨(PARTNER_SUSPENDED)', r.status === 403 && r.json.error.code === 'PARTNER_SUSPENDED', r);
    r = await api('PATCH', '/api/admin/partners/p2/unsuspend', {}, admin);
    check('파트너 정지 해제(기존 어뷰징 해제 API 재사용) 성공', r.status === 200, r);
    r = await api('GET', '/api/partners/me', null, p2);
    check('정지 해제 후 파트너 다시 정상 이용 가능', r.status === 200, r);

    // ---- CSV 다운로드(엑셀) ----
    r = await api('GET', '/api/admin/consumers/export.csv', null, admin);
    check('소비자 CSV 다운로드 200 + text/csv', r.status === 200, r);
    r = await api('GET', '/api/admin/partners/export.csv', null, admin);
    check('파트너 CSV 다운로드 200', r.status === 200, r);

    // ---- 신규: 지역기반 서비스 — GEO_TEST_MODE 스텁으로 좌표→지역 변환 전체 흐름 검증 ----
    // (실제 카카오 API 호출 자체는 tests/integration.js에서 "키 미설정시 정직하게 503" 경로로 별도 검증함)
    r = await api('GET', '/api/geo/reverse?lat=37.4979&lng=127.0276', null, null);
    check('좌표→지역 변환(강남 인근 좌표)이 실제로 서울 강남구를 반환함', r.status === 200 && r.json.data.regionCode === '서울 강남구' && r.json.data.source === 'test-stub', r);
    r = await api('GET', '/api/geo/reverse?lat=37.3595&lng=127.1052', null, null);
    check('좌표→지역 변환(성남 인근 좌표)이 실제로 경기 성남시를 반환함(다른 좌표엔 다른 지역이 나옴을 확인)', r.status === 200 && r.json.data.regionCode === '경기 성남시', r);
    r = await api('PUT', '/api/users/me/region', { region: '경기 성남시' }, u1);
    check('위치조회 결과를 실제로 소비자 프로필에 저장 가능', r.status === 200 && r.json.data.region === '경기 성남시', r);
    r = await api('GET', '/api/users/me', null, u1);
    check('저장된 활성지역이 재조회시에도 그대로 유지됨(세션 새로고침 시나리오)', r.status === 200 && r.json.data.region === '경기 성남시', r);

    console.log(`\n결과: ${pass} 성공 / ${fail} 실패`);
    server.kill();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('스모크테스트 예외:', e);
    server.kill();
    process.exit(1);
  }
})();
