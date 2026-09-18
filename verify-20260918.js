// 루머 ROOMER — 2026-09-18 작업분 검증 스크립트
// 대표님 지시 4-1 ~ 4-7 수정사항이 "실제로 그렇게 동작하는지"를 서버를 띄워 직접 확인한다.
// 추측으로 통과시키지 않고, 모든 항목을 실제 HTTP 응답·DB 조회 결과로 판정한다.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const root = __dirname.replace(/[\\/]tests$/, '');
const dbPath = path.join(os.tmpdir(), `roomer-verify-${process.pid}.db`);
const secret = 'roomer-verify-secret-at-least-thirty-two-characters';
const piiKey = 'ab'.repeat(32);
const port = 4555;
const base = `http://localhost:${port}`;

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: secret,
         PII_ENCRYPTION_KEY: piiKey, NODE_ENV: 'test', ENABLE_DEV_TEST_ROUTES: 'false' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d.toString(); });
server.stderr.on('data', d => { serverLog += d.toString(); });

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  → ' + JSON.stringify(detail) : '')); }
}
async function req(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { /* CSV 등 JSON이 아닌 응답 */ }
  return { status: res.status, json };
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch (e) { /* 아직 부팅 중 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start\n' + serverLog);
}

(async () => {
  try {
    await waitReady();
    const db = new Database(dbPath);

    // ---------- 테스트 데이터 준비 ----------
    const partnerId = randomUUID();
    db.prepare(`INSERT INTO partners (id, business_name, business_reg_number, ceo_name, phone, tier, region,
      address, road_address, postal_code, verify_status, approved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'approved', datetime('now'))`)
      .run(partnerId, '루머테스트인테리어', 'encv1-test-bizno', '홍길동대표', 'encv1-test-phone',
           '면허 파트너', '서울 강남구', '서울시 강남구 테헤란로 1', '테헤란로 1', '06232');
    const consumerToken = jwt.sign({ sub: randomUUID(), role: 'consumer' }, secret, { expiresIn: '1h' });
    const tok = role => jwt.sign({ sub: 'admin-' + role, role }, secret, { expiresIn: '1h' });
    const csToken = tok('admin_cs'), opToken = tok('admin_operator'), superToken = tok('admin_super');

    console.log('\n===== 4-1 / 4-3  출금 기능 및 계좌번호 수집 경로 제거 =====');
    const w = await req('POST', '/api/withdrawals', { token: consumerToken, body: { amount: 10000, bankAccount: '국민 123-456' } });
    check('POST /api/withdrawals 라우트가 완전히 사라짐(404)', w.status === 404, w.status);
    const serverSrc = require('fs').readFileSync(path.join(root, 'server.js'), 'utf8');
    const codeOnly = serverSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    check('서버 코드에 계좌번호를 받는 실행 코드가 없음', !/bankAccount/.test(codeOnly));

    console.log('\n===== 4-2  관리자 권한 3등급 =====');
    const csCsv = await req('GET', '/api/admin/partners/export.csv', { token: csToken });
    check('고객센터 등급은 업체 CSV 대량 다운로드 불가(403)', csCsv.status === 403, csCsv.status);
    const opCsv = await req('GET', '/api/admin/partners/export.csv', { token: opToken });
    check('운영 등급도 CSV 대량 다운로드 불가(403)', opCsv.status === 403, opCsv.status);
    const superCsv = await req('GET', '/api/admin/partners/export.csv', { token: superToken });
    check('최고관리자만 CSV 다운로드 가능(200)', superCsv.status === 200, superCsv.status);
    const csDetail = await req('GET', `/api/admin/partners/${partnerId}/detail`, { token: csToken });
    check('고객센터 등급은 업체 상세(개인정보) 열람 불가(403)', csDetail.status === 403, csDetail.status);
    const opDetail = await req('GET', `/api/admin/partners/${partnerId}/detail`, { token: opToken });
    check('운영 등급은 업체 상세 열람 가능(200)', opDetail.status === 200, opDetail.status);
    const auditRows = db.prepare("SELECT * FROM admin_access_logs WHERE resource_type IN ('partner_detail','partner_export_csv')").all();
    check('개인정보 열람·대량반출이 감사로그에 기록됨', auditRows.length >= 2, auditRows.length);
    const csList = await req('GET', '/api/admin/partners', { token: csToken });
    const csRow = csList.json && csList.json.data && csList.json.data.list.find(p => p.id === partnerId);
    check('고객센터 목록에서 사업자번호가 마스킹됨', !!csRow && /^\*+/.test(String(csRow.businessRegNumber)), csRow && csRow.businessRegNumber);
    const opList = await req('GET', '/api/admin/partners', { token: opToken });
    const opRow = opList.json && opList.json.data && opList.json.data.list.find(p => p.id === partnerId);
    check('운영 등급 목록에는 사업자번호 원문이 보임', !!opRow && !/^\*+/.test(String(opRow.businessRegNumber)));

    console.log('\n===== 4-4  비회원 가리기(서버 마스킹) =====');
    const guest = await req('GET', `/api/partners/${partnerId}`);
    const member = await req('GET', `/api/partners/${partnerId}`, { token: consumerToken });
    const g = guest.json && guest.json.data, mm = member.json && member.json.data;
    check('비회원 응답의 상호명이 원문이 아님', !!g && g.business_name !== '루머테스트인테리어', g && g.business_name);
    check('비회원 응답 상호명은 첫 글자만 남음', !!g && g.business_name === '루' + '*'.repeat('루머테스트인테리어'.length - 1), g && g.business_name);
    check('비회원 응답 지역은 시/도까지만', !!g && g.region === '서울 ◼◼◼', g && g.region);
    check('비회원 응답에 주소가 아예 없음', !!g && !g.address && !g.road_address && !g.postal_code);
    check('회원 응답에는 상호명 원문이 보임', !!mm && mm.business_name === '루머테스트인테리어', mm && mm.business_name);
    check('회원 응답에는 지역 원문이 보임', !!mm && mm.region === '서울 강남구', mm && mm.region);
    const guestSearch = await req('GET', '/api/partners/search?region=서울');
    const gs = guestSearch.json && guestSearch.json.data && guestSearch.json.data.find(p => p.id === partnerId);
    check('검색 결과도 비회원에게 마스킹됨', !!gs && gs.business_name !== '루머테스트인테리어', gs && gs.business_name);
    check('비회원 응답에 대표자 실명이 포함되지 않음', !!g && g.ceo_name === undefined, g && g.ceo_name);

    console.log('\n===== 4-5  채팅 보관기간(하이브리드) =====');
    const roomA = randomUUID(), roomB = randomUUID();
    const cA = randomUUID(), cB = randomUUID();
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname) VALUES (?,?,?,?)').run(cA, 'test', 'ca', 'A');
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname) VALUES (?,?,?,?)').run(cB, 'test', 'cb', 'B');
    db.prepare('INSERT INTO chat_rooms (id, consumer_id, partner_id) VALUES (?,?,?)').run(roomA, cA, partnerId);
    db.prepare('INSERT INTO chat_rooms (id, consumer_id, partner_id) VALUES (?,?,?)').run(roomB, cB, partnerId);
    // roomA만 계약이 있는 방으로 만든다
    db.prepare('INSERT INTO contracts (id, consumer_id, partner_id, fee_rate_snapshot, deposit_amount) VALUES (?,?,?,?,?)')
      .run(randomUUID(), cA, partnerId, 0.05, 1000000);
    const oldDate = "datetime('now','-500 days')"; // 1년 초과, 3년 미만
    for (const [room, who] of [[roomA, cA], [roomB, cB]]) {
      db.prepare(`INSERT INTO chat_messages (id, room_id, sender_role, sender_id, text, created_at)
        VALUES (?,?,?,?,?, ${oldDate})`).run(randomUUID(), room, 'consumer', who, '오래된 메시지');
    }
    db.close();
    // 정리 작업을 태우기 위해 서버를 재시작한다(부팅 시 purge 실행)
    server.kill();
    await new Promise(r => setTimeout(r, 1200));
    const server2 = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(port + 1), DB_PATH: dbPath, JWT_SECRET: secret,
             PII_ENCRYPTION_KEY: piiKey, NODE_ENV: 'test', ENABLE_DEV_TEST_ROUTES: 'false' },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    await new Promise(r => setTimeout(r, 5000));
    server2.kill();
    const db2 = new Database(dbPath);
    const leftA = db2.prepare('SELECT COUNT(*) c FROM chat_messages WHERE room_id=?').get(roomA).c;
    const leftB = db2.prepare('SELECT COUNT(*) c FROM chat_messages WHERE room_id=?').get(roomB).c;
    check('계약이 있는 방의 500일 된 메시지는 보존됨(3년 정책)', leftA === 1, leftA);
    check('계약이 없는 문의 방의 500일 된 메시지는 삭제됨(1년 정책)', leftB === 0, leftB);

    console.log('\n===== 4-6  관리자 목록 SQL 페이징 + 블라인드 인덱스 =====');
    const idxCols = db2.prepare('PRAGMA table_info(partners)').all().map(c => c.name);
    check('검색용 해시 컬럼이 생성됨', idxCols.includes('phone_idx') && idxCols.includes('business_reg_number_idx'));
    const planList = db2.prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE phone_idx=? LIMIT 20 OFFSET 0').all('x');
    check('전화번호 검색이 인덱스를 사용함(전체 훑기 아님)', planList.some(r => /USING INDEX/.test(r.detail)), planList.map(r => r.detail));
    db2.close();

    console.log('\n===== 4-7  색상 토큰화 =====');
    const html = require('fs').readFileSync(path.join(root, '루머03.html'), 'utf8');
    check(':root에 신규 토큰(--star-gold)이 추가됨', /--star-gold\s*:\s*#D9A441/.test(html));
    check('별점 색상이 토큰을 참조함', /var\(--star-gold\)/.test(html));
    check('팔레트 배열에 유지 사유 주석이 남음', /알파값 두 자리를 붙여|투명도 두 자리를 붙여/.test(html));

    console.log(`\n결과: ${pass} 성공 / ${fail} 실패`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('검증 예외:', e);
    console.error(serverLog.slice(-2000));
    process.exit(1);
  } finally {
    try { server.kill(); } catch (e) { /* 이미 종료됨 */ }
  }
})();
