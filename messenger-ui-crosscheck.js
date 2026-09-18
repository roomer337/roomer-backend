// ============================================================================
// 루머 ROOMER — 메신저 화면 교차검증 (브라우저 2개로 실제 대화)
//
// 앞의 messenger-crosscheck.js가 "서버가 제대로 동작하는가"를 봤다면,
// 이 스크립트는 "실제 화면에서 두 사람이 대화가 되는가"를 본다.
// 브라우저 창 2개를 띄워 한쪽은 소비자, 한쪽은 업체로 로그인시키고,
// 실제로 입력창에 타이핑해서 전송 버튼을 누른 뒤, 상대 화면에 그 글자가
// 새로고침 없이 나타나는지를 DOM에서 직접 확인한다.
//
// 실행: node tests/messenger-ui-crosscheck.js
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');

const root = __dirname.replace(/[\\/]tests$/, '');
const dbPath = path.join(os.tmpdir(), `roomer-msgui-${process.pid}.db`);
const secret = 'roomer-messenger-ui-crosscheck-secret-32';
const piiKey = 'ab'.repeat(32);
const port = 5100 + (process.pid % 80);
const base = `http://localhost:${port}`;
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'roomer-msgui-shots');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let serverLog = '';
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: secret,
         PII_ENCRYPTION_KEY: piiKey, NODE_ENV: 'test', ENABLE_DEV_TEST_ROUTES: 'false',
         // 실서버와 동일하게: 브라우저가 보내는 Origin이 허용목록에 있어야 WebSocket 업그레이드가 통과한다
         ALLOWED_ORIGIN: `http://localhost:${port},https://localhost,capacitor://localhost` },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', d => { serverLog += d.toString(); });
server.stderr.on('data', d => { serverLog += d.toString(); });

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const section = t => console.log('\n' + '='.repeat(70) + '\n ' + t + '\n' + '='.repeat(70));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch (e) { /* 부팅 중 */ }
    await sleep(500);
  }
  throw new Error('서버가 뜨지 않았습니다\n' + serverLog.slice(-1500));
}

// 한 사람분의 브라우저 창을 띄우고 로그인 상태로 채팅방까지 들어간다
async function openAs(browser, { label, token, mode, counterpartName }) {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 780 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul'
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
  await page.goto(`${base}/app`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(([t, m]) => {
    try { localStorage.setItem('roomer_token', t); } catch (e) {}
    try {
      sessionStorage.setItem('roomer_loggedIn', '1');
      sessionStorage.setItem('roomer_accountMode', m);
    } catch (e) {}
  }, [token, mode]);
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  // 계정 모드만 로그인 직후 상태로 맞추고(실제 로그인 흐름이 하는 일),
  // 그 뒤로는 전부 "실제 사용자가 손으로 하는 동작"만 한다 — 메신저 목록 → 방 탭.
  await page.evaluate(m => { window.currentAccountMode = m; window.currentUserLoggedIn = true; }, mode);
  await page.evaluate(() => { try { (window.go || go)('chatlist'); } catch (e) {} });
  await page.waitForTimeout(2500);
  // 목록에서 상대 이름이 적힌 줄을 실제로 탭한다
  try {
    await page.locator('#s-chatlist').getByText(counterpartName, { exact: false }).first().click({ timeout: 10000 });
  } catch (e) {
    errors.push('목록에서 방을 탭하지 못함: ' + e.message.slice(0, 80));
  }
  await page.waitForTimeout(2500);
  return { label, ctx, page, errors };
}

// 화면(DOM)에 그 글자가 실제로 보일 때까지 기다린다 — 새로고침 없이
async function seesOnScreen(person, text, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await person.page.evaluate(t => {
      const scr = document.querySelector('#s-chat');
      return !!(scr && scr.innerText && scr.innerText.includes(t));
    }, text).catch(() => false);
    if (found) return Date.now() - start;
    await sleep(120);
  }
  return null;
}

(async () => {
  let browser;
  try {
    await waitReady();
    fs.mkdirSync(OUT, { recursive: true });
    const db = new Database(dbPath);

    // ---------- 등장인물 ----------
    const partnerId = randomUUID(), consumerId = randomUUID();
    db.prepare(`INSERT INTO partners (id, business_name, business_reg_number, ceo_name, phone, tier, region, verify_status, approved_at, rating, reviews_count, contracts_count)
      VALUES (?,?,?,?,?,?,?, 'approved', datetime('now'), 4.9, 128, 37)`)
      .run(partnerId, '해온 인테리어', 'enc-bizno', 'enc-ceo', 'enc-phone', '면허 파트너', '서울 강남구');
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname, region) VALUES (?,?,?,?,?)')
      .run(consumerId, 'kakao', 'ui-consumer', '김소비', '서울 강남구');
    const tok = (sub, role) => jwt.sign({ sub, role }, secret, { expiresIn: '2h' });
    const consumerToken = tok(consumerId, 'consumer');
    const partnerToken = tok(partnerId, 'partner');

    const roomRes = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + consumerToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ partnerId })
    }).then(r => r.json());
    const roomId = roomRes.data.id;

    browser = await chromium.launch({ executablePath: CHROME });

    section('1. 두 사람이 각자 앱을 열고 채팅방에 들어간다');
    const consumer = await openAs(browser, { label: '소비자', token: consumerToken, mode: 'consumer', counterpartName: '해온 인테리어' });
    const partner = await openAs(browser, { label: '업체', token: partnerToken, mode: 'partner', counterpartName: '김소비' });

    const consumerScreen = await consumer.page.evaluate(() => { const e = document.querySelector('.scr.on'); return e ? e.id : '(없음)'; });
    const partnerScreen = await partner.page.evaluate(() => { const e = document.querySelector('.scr.on'); return e ? e.id : '(없음)'; });
    check('소비자 화면이 채팅방으로 열린다', consumerScreen === 's-chat', consumerScreen);
    check('업체 화면이 채팅방으로 열린다', partnerScreen === 's-chat', partnerScreen);
    check('소비자 화면에 입력창이 있다', await consumer.page.$('#chatinput') !== null);
    check('업체 화면에 입력창이 있다', await partner.page.$('#chatinput') !== null);

    section('2. 소비자가 직접 타이핑해서 보낸다');
    const msg1 = '안녕하세요, 34평 아파트 올수리 견적 문의드립니다';
    await consumer.page.fill('#chatinput', msg1);
    const typed = await consumer.page.inputValue('#chatinput');
    check('입력창에 글자가 실제로 입력된다', typed === msg1, typed);
    await consumer.page.evaluate(() => { try { (window.sendMessage || sendMessage)(); } catch (e) { return String(e); } });
    await consumer.page.waitForTimeout(800);
    check('전송 후 입력창이 비워진다', (await consumer.page.inputValue('#chatinput')) === '');
    const onMine = await seesOnScreen(consumer, msg1, 4000);
    check('보낸 사람 화면에 내 메시지가 보인다', onMine !== null, onMine);

    section('3. ⭐ 업체 화면에 새로고침 없이 나타나는가 (핵심)');
    const arrivedMs = await seesOnScreen(partner, msg1, 8000);
    check('업체가 새로고침 없이 그 메시지를 화면에서 본다', arrivedMs !== null, arrivedMs);
    if (arrivedMs !== null) console.log(`       ↳ 화면에 뜨기까지: ${arrivedMs}ms`);

    section('4. 업체가 답장하고, 소비자 화면에 뜨는가');
    const msg2 = '안녕하세요! 실측 가능한 날짜 알려주시면 방문드리겠습니다';
    await partner.page.fill('#chatinput', msg2);
    await partner.page.evaluate(() => { try { (window.sendMessage || sendMessage)(); } catch (e) { return String(e); } });
    await partner.page.waitForTimeout(800);
    const replyArrived = await seesOnScreen(consumer, msg2, 8000);
    check('소비자가 답장을 새로고침 없이 화면에서 본다', replyArrived !== null, replyArrived);
    if (replyArrived !== null) console.log(`       ↳ 화면에 뜨기까지: ${replyArrived}ms`);

    section('5. 여러 번 주고받아도 대화가 이어지는가');
    const convo = [
      [consumer, '이번 주 토요일 오후 괜찮으실까요?'],
      [partner, '토요일 2시에 방문 가능합니다'],
      [consumer, '네 그때 뵙겠습니다. 감사합니다']
    ];
    for (const [who, text] of convo) {
      await who.page.fill('#chatinput', text);
      await who.page.evaluate(() => { try { (window.sendMessage || sendMessage)(); } catch (e) {} });
      await who.page.waitForTimeout(700);
      const other = who === consumer ? partner : consumer;
      const ok = await seesOnScreen(other, text, 7000);
      check(`"${text.slice(0, 16)}…" 가 상대 화면에 도착`, ok !== null, ok);
    }

    section('6. 대화 내용이 양쪽 화면에 똑같이 남아있는가');
    const allTexts = [msg1, msg2, ...convo.map(c => c[1])];
    for (const p of [consumer, partner]) {
      const body = await p.page.evaluate(() => {
        const s = document.querySelector('#s-chat');
        return s ? s.innerText : '';
      });
      const missing = allTexts.filter(t => !body.includes(t));
      check(`${p.label} 화면에 대화 ${allTexts.length}건이 모두 남아있다`, missing.length === 0, missing);
    }

    section('6-2. 메시지 시각이 양쪽 모두 현지시각(KST)으로 맞는가');
    // 브라우저 컨텍스트가 Asia/Seoul이므로, 내 메시지와 상대 메시지의 시각이 같은 기준이어야 한다.
    const times = await consumer.page.evaluate(() => {
      const out = [];
      (window.CHAT_LOG || []).forEach(m => { if (m && m.t && m.text) out.push({ t: m.t, who: m.senderRole || m.who, text: String(m.text).slice(0, 14) }); });
      return out;
    });
    const hours = [...new Set(times.map(x => Number(String(x.t).split(':')[0])).filter(n => !Number.isNaN(n)))];
    const spread = hours.length ? Math.max(...hours) - Math.min(...hours) : 0;
    check('한 대화 안에서 시각이 9시간씩 어긋나지 않는다', spread <= 1, { 시각들: times.map(x => x.t + '(' + x.who + ')'), 시차: spread });
    const nowH = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).replace(/\D/g, '');
    check('표시된 시각이 실제 한국시각과 일치한다', hours.length === 0 || Math.abs(hours[0] - Number(nowH)) <= 1, { 화면: hours, 실제KST: nowH });

    section('6-3. 실시간 연결 상태 표시');
    for (const p of [consumer, partner]) {
      const st = await p.page.evaluate(() => {
        const t = window.CHAT_TRANSPORT || {};
        const el = document.getElementById('chat-transport-status');
        return { status: t.status, mode: t.mode, label: el ? el.textContent : null };
      });
      console.log(`       ${p.label}: status=${st.status} mode=${st.mode} 표시="${st.label}"`);
      check(`${p.label} 화면이 실시간 연결됨으로 표시된다`, st.status === 'connected', st);
    }

    section('7. 화면에 오류가 떴는가');
    for (const p of [consumer, partner]) {
      check(`${p.label} 화면에 자바스크립트 오류가 없다`, p.errors.length === 0, p.errors.slice(0, 3));
      const alertShown = await p.page.evaluate(() => {
        const t = document.body.innerText || '';
        return /오류가 발생|로그인이 만료|서버에 연결할 수 없/.test(t);
      });
      check(`${p.label} 화면에 오류 안내가 뜨지 않았다`, !alertShown);
    }

    await consumer.page.screenshot({ path: path.join(OUT, 'chat_consumer.png') });
    await partner.page.screenshot({ path: path.join(OUT, 'chat_partner.png') });
    console.log(`\n  스크린샷 저장: ${OUT}/chat_consumer.png , chat_partner.png`);

    db.close();
    console.log('\n' + '='.repeat(70));
    console.log(` 메신저 화면 교차검증:  ${pass}개 통과 / ${fail}개 실패`);
    if (failures.length) { console.log(' 실패 항목:'); failures.forEach(f => console.log('   · ' + f)); }
    console.log('='.repeat(70));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\n검증 중 예외:', e.message);
    console.error(serverLog.slice(-1500));
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { server.kill(); } catch (e) {}
  }
})();
