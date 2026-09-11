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
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: secret, NODE_ENV: 'test', ENABLE_DEV_TEST_ROUTES: 'false' },
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

    // ---- 광고 등록/조회 (p2는 credit_balance 500000 보유) ----
    r = await api('POST', '/api/ads', { slotType: 'hero-sub', region: '서울', tagline: '정직한 시공, 루머 인증업체' }, p2);
    check('광고 등록 성공(자동승인)', r.status === 200 && r.json.data.autoActivated === true, r);

    r = await api('GET', '/api/ads/mine', null, p2);
    check('내 광고 목록 조회', r.status === 200 && r.json.data.length === 1 && r.json.data[0].status === 'active', r);

    r = await api('GET', '/api/ads/active?slotType=hero-sub');
    check('활성광고 공개조회', r.status === 200 && r.json.data.length === 1, r);

    r = await api('GET', '/api/admin/ads', null, admin);
    check('관리자 전체광고 조회', r.status === 200 && r.json.data.length === 1 && r.json.data[0].partner_name.includes('광고주'), r);

    r = await api('GET', '/api/credit/ledger/mine', null, p2);
    check('내 크레딧 원장 조회(광고비 소진 1건)', r.status === 200 && r.json.data.length === 1 && r.json.data[0].type === 'ad_purchase', r);

    r = await api('GET', '/api/partners/me', null, p2);
    const balanceAfterAd = r.json.data.credit_balance;
    check('광고비 차감 확인(500000-29000)', balanceAfterAd === 500000 - 29000, { balanceAfterAd });

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

    // ---- 광고 정원·단가 오버라이드: 실제 광고구매(POST /api/ads)에 반영돼야 함 ----
    r = await api('PUT', '/api/admin/policy', { key: 'ad_capacity', value: { hero: 0 } }, admin);
    check('관리자 정책저장: 광고 정원 오버라이드 저장 성공', r.status === 200, r);
    r = await api('POST', '/api/ads', { slotType: 'hero', region: '서울 강남구', tagline: '스모크테스트 광고' }, p2);
    check('광고 정원을 0으로 낮추면 크레딧이 있어도 즉시 정원마감으로 차단됨(하드코딩 정원 무시하고 정책값 적용 확인)', r.status === 400 && r.json.error.code === 'CAPACITY_FULL', r);
    await api('PUT', '/api/admin/policy', { key: 'ad_capacity', value: { hero: 5 } }, admin);
    r = await api('PUT', '/api/admin/policy', { key: 'ad_pricing', value: { hero: { price: 1 } } }, admin);
    check('관리자 정책저장: 광고 단가 오버라이드 저장 성공', r.status === 200, r);
    r = await api('POST', '/api/ads', { slotType: 'hero', region: '서울 서초구', tagline: '스모크테스트 광고2' }, p2);
    check('광고 단가를 1크레딧으로 낮추면 실제로 1크레딧만 차감됨(기본 99000 아님)', r.status === 200 && r.json.data.price === 1, r);
    await api('PUT', '/api/admin/policy', { key: 'ad_pricing', value: { hero: { price: 99000 } } }, admin); // 원복

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

    console.log(`\n결과: ${pass} 성공 / ${fail} 실패`);
    server.kill();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('스모크테스트 예외:', e);
    server.kill();
    process.exit(1);
  }
})();
