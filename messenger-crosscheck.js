// ============================================================================
// 루머 ROOMER — 메신저 교차검증 (실제 두 사람이 대화하듯)
//
// [무엇을 하나]
// 소비자 1명과 업체 1명이 "동시에 접속해서 실제로 대화하는" 상황을 그대로 재현한다.
// 두 사람 모두 앱과 똑같이 WebSocket으로 실시간 연결을 맺고, REST로 메시지를 보내고,
// 상대가 그걸 몇 밀리초 만에 받는지까지 측정한다. 추측이나 목(mock)이 아니라 실제
// 서버·실제 DB·실제 WebSocket을 쓴다.
//
// [왜 필요한가]
// 비공개 테스트에 테스터 12명을 모아놓고 메신저가 안 되면 2주를 통째로 날린다.
// 테스터를 부르기 전에 "둘이 실제로 대화가 되는가"를 먼저 확인하는 것이 순서다.
//
// 실행: node tests/messenger-crosscheck.js
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const root = __dirname.replace(/[\\/]tests$/, '');
const dbPath = path.join(os.tmpdir(), `roomer-msg-${process.pid}.db`);
const secret = 'roomer-messenger-crosscheck-secret-32chars';
const piiKey = 'ab'.repeat(32);
const port = 4900 + (process.pid % 90);
const base = `http://localhost:${port}`;
const wsBase = `ws://localhost:${port}/api/realtime`;

let serverLog = '';
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: secret,
         PII_ENCRYPTION_KEY: piiKey, NODE_ENV: 'test', ENABLE_DEV_TEST_ROUTES: 'false' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', d => { serverLog += d.toString(); });
server.stderr.on('data', d => { serverLog += d.toString(); });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n' + '='.repeat(70) + '\n ' + t + '\n' + '='.repeat(70)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { /* JSON이 아닌 응답 */ }
  return { status: res.status, json };
}

// 앱이 하는 것과 동일하게 WebSocket으로 접속하는 "가상의 사람"
class Person {
  constructor(label, token) {
    this.label = label;
    this.token = token;
    this.received = [];       // 실시간으로 받은 메시지들
    this.events = [];         // 그 외 이벤트
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${wsBase}?token=${encodeURIComponent(this.token)}`);
      this.ws.on('message', raw => {
        let d; try { d = JSON.parse(raw.toString()); } catch (e) { return; }
        if (d.type === 'message') this.received.push({ at: Date.now(), ...d.message });
        else this.events.push({ at: Date.now(), ...d });
      });
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', e => reject(new Error(`${this.label} WS 연결 실패: ${e.message}`)));
      setTimeout(() => reject(new Error(`${this.label} WS 연결 타임아웃`)), 8000);
    });
  }
  subscribe(roomId, sinceSeq = 0) {
    this.ws.send(JSON.stringify({ type: 'subscribe', roomId, sinceSeq }));
  }
  close() { try { this.ws.close(); } catch (e) {} }
  // 특정 문구가 담긴 메시지를 실제로 받을 때까지 기다린다(최대 timeout ms)
  async waitFor(textIncludes, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = this.received.find(m => String(m.text || '').includes(textIncludes));
      if (hit) return { ...hit, waitedMs: Date.now() - start };
      await sleep(25);
    }
    return null;
  }
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch (e) { /* 부팅 중 */ }
    await sleep(500);
  }
  throw new Error('서버가 뜨지 않았습니다\n' + serverLog.slice(-1500));
}

(async () => {
  try {
    await waitReady();
    const db = new Database(dbPath);

    // ---------- 등장인물 준비 ----------
    const partnerId = randomUUID();
    const consumerId = randomUUID();
    const strangerId = randomUUID();
    db.prepare(`INSERT INTO partners (id, business_name, business_reg_number, ceo_name, phone, tier, region, verify_status, approved_at)
      VALUES (?,?,?,?,?,?,?, 'approved', datetime('now'))`)
      .run(partnerId, '해온 인테리어', 'enc-bizno', 'enc-ceo', 'enc-phone', '면허 파트너', '서울 강남구');
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname) VALUES (?,?,?,?)')
      .run(consumerId, 'kakao', 'consumer-1', '김소비');
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname) VALUES (?,?,?,?)')
      .run(strangerId, 'kakao', 'stranger-1', '남의집');
    const tok = (sub, role) => jwt.sign({ sub, role }, secret, { expiresIn: '2h' });
    const consumerToken = tok(consumerId, 'consumer');
    const partnerToken = tok(partnerId, 'partner');
    const strangerToken = tok(strangerId, 'consumer');

    section('1. 채팅방 시작 — 소비자가 업체에게 말을 건다');
    const roomRes = await api('POST', '/api/rooms', { token: consumerToken, body: { partnerId } });
    check('소비자가 채팅방을 만들 수 있다', roomRes.status === 200 && roomRes.json && roomRes.json.data, roomRes.status);
    const roomId = roomRes.json && roomRes.json.data && roomRes.json.data.id;
    if (!roomId) throw new Error('채팅방 생성 실패로 이후 검증 불가');

    const again = await api('POST', '/api/rooms', { token: consumerToken, body: { partnerId } });
    check('같은 업체에 다시 시작해도 방이 새로 생기지 않는다(중복방 방지)', again.json && again.json.data && again.json.data.id === roomId);

    const byPartner = await api('POST', '/api/rooms', { token: partnerToken, body: { partnerId } });
    check('업체 계정은 방을 만들 수 없다(데이터 오염 방지)', byPartner.status === 403, byPartner.status);

    section('2. 두 사람이 동시에 접속 — 실시간 연결');
    const consumer = new Person('소비자', consumerToken);
    const partner = new Person('업체', partnerToken);
    await consumer.connect();
    await partner.connect();
    check('소비자 실시간 접속 성공', consumer.ws.readyState === WebSocket.OPEN);
    check('업체 실시간 접속 성공', partner.ws.readyState === WebSocket.OPEN);
    consumer.subscribe(roomId);
    partner.subscribe(roomId);
    await sleep(400);

    section('3. 실제 대화 — 소비자 → 업체');
    const t1 = Date.now();
    const m1 = await api('POST', `/api/rooms/${roomId}/messages`,
      { token: consumerToken, body: { text: '안녕하세요, 34평 아파트 올수리 문의드립니다.' } });
    check('소비자가 메시지를 보낼 수 있다', m1.status === 200 && m1.json.success, m1.status);
    const got1 = await partner.waitFor('34평 아파트 올수리');
    check('업체가 새로고침 없이 그 메시지를 실시간으로 받는다', !!got1);
    if (got1) {
      console.log(`       ↳ 전달까지 걸린 시간: ${got1.waitedMs}ms (서버 왕복 포함 ${Date.now() - t1}ms)`);
      check('전달이 1초 안에 이루어진다', got1.waitedMs < 1000, got1.waitedMs + 'ms');
      check('받은 메시지의 발신자가 소비자로 표시된다', got1.sender_role === 'consumer', got1.sender_role);
    }

    section('4. 실제 대화 — 업체 → 소비자 (반대 방향)');
    const m2 = await api('POST', `/api/rooms/${roomId}/messages`,
      { token: partnerToken, body: { text: '안녕하세요! 현장 실측 가능한 날짜 알려주시면 방문드리겠습니다.' } });
    check('업체가 답장을 보낼 수 있다', m2.status === 200 && m2.json.success, m2.status);
    const got2 = await consumer.waitFor('현장 실측 가능한 날짜');
    check('소비자가 답장을 실시간으로 받는다', !!got2);
    if (got2) console.log(`       ↳ 전달까지 걸린 시간: ${got2.waitedMs}ms`);
    check('보낸 사람 본인에게도 자기 메시지가 돌아온다(화면 동기화)', partner.received.some(m => m.text.includes('현장 실측')));

    section('5. 빠르게 주고받기 — 순서가 섞이지 않는가');
    consumer.received.length = 0; partner.received.length = 0;
    const rapid = [];
    for (let i = 1; i <= 10; i++) {
      rapid.push(api('POST', `/api/rooms/${roomId}/messages`,
        { token: i % 2 ? consumerToken : partnerToken, body: { text: `연속메시지-${String(i).padStart(2, '0')}` } }));
    }
    await Promise.all(rapid);
    await sleep(900);
    const seqOnConsumer = consumer.received.filter(m => m.text.startsWith('연속메시지-')).map(m => m.seq);
    const ordered = seqOnConsumer.every((v, i, a) => i === 0 || a[i - 1] < v);
    check('10개를 몰아 보내도 전부 도착한다', seqOnConsumer.length === 10, seqOnConsumer.length + '/10');
    check('도착 순서가 뒤섞이지 않는다(순번 오름차순)', ordered, seqOnConsumer);

    section('6. 같은 초에 여러 건 — 과거에 메시지가 누락되던 상황 재현');
    const beforeSeq = Math.max(...seqOnConsumer);
    await Promise.all([1, 2, 3].map(i => api('POST', `/api/rooms/${roomId}/messages`,
      { token: consumerToken, body: { text: `동시전송-${i}` } })));
    await sleep(600);
    const since = await api('GET', `/api/rooms/${roomId}/messages?sinceSeq=${beforeSeq}`, { token: partnerToken });
    const sinceTexts = (since.json.data || []).map(m => m.text);
    check('같은 초에 보낸 3건이 하나도 누락되지 않는다', [1, 2, 3].every(i => sinceTexts.includes(`동시전송-${i}`)), sinceTexts);

    section('7. 접속이 끊겼다 돌아오면 — 그 사이 온 메시지 복구');
    const lastSeqBefore = Math.max(...(since.json.data || []).map(m => m.seq), beforeSeq);
    partner.close();
    await sleep(500);
    await api('POST', `/api/rooms/${roomId}/messages`,
      { token: consumerToken, body: { text: '자리 비우신 동안 보낸 메시지입니다' } });
    await sleep(300);
    const partner2 = new Person('업체(재접속)', partnerToken);
    await partner2.connect();
    partner2.subscribe(roomId, lastSeqBefore);
    const recovered = await partner2.waitFor('자리 비우신 동안', 4000);
    check('재접속하면 못 받았던 메시지를 자동으로 받아온다', !!recovered);

    section('8. 상대가 안 보고 있을 때 — 알림이 생기는가');
    const notifBefore = db.prepare("SELECT COUNT(*) c FROM notifications WHERE recipient_id=? AND type='chat_message'").get(partnerId).c;
    partner2.close();
    await sleep(600);
    await api('POST', `/api/rooms/${roomId}/messages`,
      { token: consumerToken, body: { text: '알림 확인용 메시지' } });
    await sleep(500);
    const notifAfter = db.prepare("SELECT COUNT(*) c FROM notifications WHERE recipient_id=? AND type='chat_message'").get(partnerId).c;
    check('상대가 채팅을 안 보고 있으면 알림이 만들어진다', notifAfter > notifBefore, { 전: notifBefore, 후: notifAfter });

    const partner3 = new Person('업체(복귀)', partnerToken);
    await partner3.connect();
    partner3.subscribe(roomId);
    await sleep(400);
    const notifBefore2 = db.prepare("SELECT COUNT(*) c FROM notifications WHERE recipient_id=? AND type='chat_message'").get(partnerId).c;
    await api('POST', `/api/rooms/${roomId}/messages`, { token: consumerToken, body: { text: '보고 있을 때 보낸 메시지' } });
    await sleep(600);
    const notifAfter2 = db.prepare("SELECT COUNT(*) c FROM notifications WHERE recipient_id=? AND type='chat_message'").get(partnerId).c;
    check('반대로 상대가 보고 있으면 중복 알림을 보내지 않는다', notifAfter2 === notifBefore2, { 전: notifBefore2, 후: notifAfter2 });

    section('9. 안읽음 개수와 읽음 처리');
    const listBefore = await api('GET', '/api/rooms/mine', { token: partnerToken });
    const roomRowBefore = (listBefore.json.data || []).find(r => r.id === roomId);
    check('채팅 목록에 안읽음 개수가 표시된다', roomRowBefore && typeof roomRowBefore.unreadCount === 'number', roomRowBefore && roomRowBefore.unreadCount);
    check('안읽음이 실제로 쌓여 있다', roomRowBefore && roomRowBefore.unreadCount > 0, roomRowBefore && roomRowBefore.unreadCount);
    check('채팅 목록에 상대 이름이 보인다', !!(roomRowBefore && roomRowBefore.displayName), roomRowBefore && roomRowBefore.displayName);
    check('채팅 목록에 마지막 메시지가 보인다', !!(roomRowBefore && (roomRowBefore.lastMessage || roomRowBefore.lastMessageText)),
      roomRowBefore && Object.keys(roomRowBefore).filter(k => /last/i.test(k)));

    // 프론트(markRoomRead)와 동일하게 lastReadSeq를 실어 보낸다
    const maxSeq = db.prepare('SELECT coalesce(max(seq),0) s FROM chat_messages WHERE room_id=?').get(roomId).s;
    const readRes = await api('POST', `/api/rooms/${roomId}/read`, { token: partnerToken, body: { lastReadSeq: maxSeq } });
    check('읽음 처리 API가 동작한다', readRes.status === 200, readRes.status);
    // 회귀방지: 본문 없이 보내도 500이 아니라 400이어야 한다(2026-09-18 수정분)
    const noBody = await fetch(`${base}/api/rooms/${roomId}/read`, { method: 'POST', headers: { Authorization: 'Bearer ' + partnerToken } });
    check('본문 없이 호출해도 서버가 죽지 않고 400으로 안내한다', noBody.status === 400, noBody.status);
    const nullSeq = await api('POST', `/api/rooms/${roomId}/read`, { token: partnerToken, body: { lastReadSeq: null } });
    check('lastReadSeq가 null이면 성공으로 속이지 않고 거부한다', nullSeq.status === 400, nullSeq.status);
    const listAfter = await api('GET', '/api/rooms/mine', { token: partnerToken });
    const roomRowAfter = (listAfter.json.data || []).find(r => r.id === roomId);
    check('읽고 나면 안읽음이 0이 된다', roomRowAfter && roomRowAfter.unreadCount === 0, roomRowAfter && roomRowAfter.unreadCount);

    section('9-2. 사진 전송 (테스터가 반드시 해볼 기능)');
    // 실제 PNG 1x1 이미지를 multipart/form-data로 올린다 — 앱이 하는 것과 동일한 방식
    const pngBytes = Buffer.from(
      '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6360000002000100' +
      '05FE02FEA7B5C90B0000000049454E44AE426082', 'hex');
    const boundary = '----roomerTest' + Date.now();
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const multipart = Buffer.concat([pre, pngBytes, post]);
    const upRes = await fetch(`${base}/api/rooms/${roomId}/attachments`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + consumerToken, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipart
    });
    const upJson = await upRes.json().catch(() => null);
    const storageNotSet = upRes.status === 503 && upJson && upJson.error && upJson.error.code === 'OBJECT_STORAGE_NOT_CONFIGURED';
    if (storageNotSet) {
      console.log('       ↳ 파일 저장소 미설정 환경이라 업로드 자체는 건너뜁니다(운영에서는 로컬 디스크 폴백이 동작)');
      check('사진 업로드 경로가 살아있다(저장소 미설정은 정상 응답)', true);
    } else {
      check('사진을 업로드할 수 있다', upRes.status === 200 && upJson && upJson.success, { status: upRes.status, err: upJson && upJson.error });
      const attachmentId = upJson && upJson.data && upJson.data.attachment && upJson.data.attachment.id;
      if (attachmentId) {
        partner3.received.length = 0;
        const imgMsg = await api('POST', `/api/rooms/${roomId}/messages`,
          { token: consumerToken, body: { type: 'image', attachmentId } });
        check('사진 메시지를 보낼 수 있다', imgMsg.status === 200 && imgMsg.json.success, imgMsg.status);
        const gotImg = await partner3.waitFor('사진', 4000);
        check('상대가 사진 메시지를 실시간으로 받는다', !!gotImg);
        check('사진 메시지 종류가 image로 기록된다', gotImg && gotImg.msg_type === 'image', gotImg && gotImg.msg_type);
        const dl = await fetch(`${base}/api/rooms/${roomId}/attachments/${attachmentId}`, { headers: { Authorization: 'Bearer ' + partnerToken } });
        check('상대가 그 사진을 내려받을 수 있다', dl.status === 200, dl.status);
        const dlStranger = await fetch(`${base}/api/rooms/${roomId}/attachments/${attachmentId}`, { headers: { Authorization: 'Bearer ' + strangerToken } });
        check('제3자는 남의 채팅 사진을 내려받을 수 없다', dlStranger.status === 403, dlStranger.status);
        const fake = await api('POST', `/api/rooms/${roomId}/messages`,
          { token: consumerToken, body: { type: 'image', attachmentId: randomUUID() } });
        check('없는 첨부를 지어내서 보낼 수 없다', fake.status === 403, fake.status);
      }
    }

    section('10. 남의 대화를 훔쳐볼 수 있는가 (보안)');
    const peekRead = await api('GET', `/api/rooms/${roomId}/messages`, { token: strangerToken });
    check('제3자는 남의 채팅 내용을 읽을 수 없다(403)', peekRead.status === 403, peekRead.status);
    const peekWrite = await api('POST', `/api/rooms/${roomId}/messages`, { token: strangerToken, body: { text: '끼어들기' } });
    check('제3자는 남의 채팅에 글을 쓸 수 없다(403)', peekWrite.status === 403, peekWrite.status);
    const stranger = new Person('제3자', strangerToken);
    await stranger.connect();
    stranger.received.length = 0;
    stranger.subscribe(roomId);
    await sleep(400);
    await api('POST', `/api/rooms/${roomId}/messages`, { token: consumerToken, body: { text: '비밀 대화 내용' } });
    await sleep(900);
    check('제3자는 실시간으로도 남의 대화를 엿들을 수 없다', !stranger.received.some(m => String(m.text).includes('비밀 대화')), stranger.received.length);
    stranger.close();

    section('11. 같은 메시지 두 번 전송 (버튼 연타 / 재시도)');
    const cmid = 'client-' + randomUUID();
    const dup1 = await api('POST', `/api/rooms/${roomId}/messages`, { token: consumerToken, body: { text: '중복확인 메시지', clientMessageId: cmid } });
    const dup2 = await api('POST', `/api/rooms/${roomId}/messages`, { token: consumerToken, body: { text: '중복확인 메시지', clientMessageId: cmid } });
    const dupCount = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE room_id=? AND text='중복확인 메시지'").get(roomId).c;
    check('버튼을 두 번 눌러도 메시지가 한 번만 저장된다', dupCount === 1, dupCount);
    check('두 번째 요청도 오류 없이 같은 메시지를 돌려준다', dup2.status === 200 && dup2.json.data && dup2.json.data.id === dup1.json.data.id);

    section('12. 입력값 검증');
    const empty = await api('POST', `/api/rooms/${roomId}/messages`, { token: consumerToken, body: { text: '   ' } });
    check('빈 메시지는 거부된다', empty.status === 400, empty.status);
    const tooLong = await api('POST', `/api/rooms/${roomId}/messages`, { token: consumerToken, body: { text: 'ㅁ'.repeat(1001) } });
    check('1000자를 넘는 메시지는 거부된다', tooLong.status === 400, tooLong.status);
    const xss = await api('POST', `/api/rooms/${roomId}/messages`,
      { token: consumerToken, body: { text: '<img src=x onerror=alert(1)>' } });
    check('특수문자가 든 메시지도 저장은 된다(화면에서 textContent로 안전 처리)', xss.status === 200, xss.status);
    const savedXss = db.prepare("SELECT text FROM chat_messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomId);
    check('저장된 내용이 입력 그대로다(서버가 임의로 변형하지 않음)', savedXss.text === '<img src=x onerror=alert(1)>', savedXss.text);

    section('13. 전체 대화 이력 조회');
    const history = await api('GET', `/api/rooms/${roomId}/messages`, { token: consumerToken });
    const all = history.json.data || [];
    check('지금까지의 대화가 전부 남아있다', all.length >= 18, all.length + '건');
    const seqs = all.map(m => m.seq);
    check('이력이 순번 순서대로 정렬되어 있다', seqs.every((v, i, a) => i === 0 || a[i - 1] < v));
    check('양쪽 발신자가 모두 기록되어 있다',
      all.some(m => m.sender_role === 'consumer') && all.some(m => m.sender_role === 'partner'));

    section('14. 토큰 없이 / 잘못된 토큰으로 실시간 접속');
    const badWs = new WebSocket(`${wsBase}?token=invalid-token`);
    const badResult = await new Promise(r => {
      badWs.on('open', () => r('연결됨'));
      badWs.on('error', () => r('차단됨'));
      badWs.on('close', () => r('차단됨'));
      setTimeout(() => r('응답없음'), 3000);
    });
    check('잘못된 토큰으로는 실시간 접속이 차단된다', badResult === '차단됨', badResult);

    consumer.close(); partner3.close();
    db.close();

    console.log('\n' + '='.repeat(70));
    console.log(` 메신저 교차검증 결과:  ${pass}개 통과 / ${fail}개 실패`);
    if (failures.length) { console.log(' 실패 항목:'); failures.forEach(f => console.log('   · ' + f)); }
    console.log('='.repeat(70));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\n검증 중 예외 발생:', e.message);
    console.error(serverLog.slice(-2000));
    process.exit(1);
  } finally {
    try { server.kill(); } catch (e) {}
  }
})();
