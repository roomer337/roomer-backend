// ============================================================================
// 루머 ROOMER — 설치형 앱 소셜로그인 "화면" 검증 (실제 브라우저로)
//
// 앞의 app-social-login.js가 서버 쪽을 봤다면, 이 스크립트는 **앱 화면이 실제로 그 길로 가는지**를
// 본다. 설치된 앱과 똑같은 조건(window.Capacitor가 있는 상태)을 만들어 놓고, 사람이 하듯이
// 동의 체크박스를 누르고 네이버 버튼을 탭한 뒤,
//
//   ① 앱이 화면을 떠나지 않는가            ← 이게 깨져서 네이버 앱에 흐름을 빼앗겼던 것
//   ② 시스템 브라우저로 로그인 주소를 여는가
//   ③ 그 주소에 앱용 state가 붙어 있는가
//   ④ 브라우저에서 로그인이 끝난 뒤 앱이 스스로 인가코드를 회수해 로그인을 마무리하는가
//
// 를 DOM과 실제 네트워크 요청으로 확인한다.
//
// 실행: node tests/app-social-login-ui.js
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const root = __dirname.replace(/[\\/]tests$/, '');
const dbPath = path.join(os.tmpdir(), `roomer-appauthui-${process.pid}.db`);
const secret = 'roomer-app-social-ui-secret-32chars-long';
const piiKey = 'ab'.repeat(32);
const port = 5500 + (process.pid % 80);
const base = `http://localhost:${port}`;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let serverLog = '';
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: secret,
         PII_ENCRYPTION_KEY: piiKey, NODE_ENV: 'test', ENABLE_DEV_TEST_ROUTES: 'false',
         ALLOWED_ORIGIN: `http://localhost:${port},https://localhost,capacitor://localhost` },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', d => { serverLog += d.toString(); });
server.stderr.on('data', d => { serverLog += d.toString(); });

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : '')); }
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

// 설치된 앱과 같은 조건을 만든다 — Capacitor가 존재하고 Browser/App 플러그인이 붙어 있는 상태.
// 실제 시스템 브라우저를 띄울 수는 없으므로, 열라고 요청한 주소만 기록해 둔다.
const FAKE_CAPACITOR = `
window.__openedUrls = [];
window.__browserClosed = 0;
window.__appUrlHandlers = [];
window.Capacitor = {
  isNativePlatform: function(){ return true; },
  Plugins: {
    Browser: {
      open: function(o){ window.__openedUrls.push(o.url); return Promise.resolve(); },
      close: function(){ window.__browserClosed++; return Promise.resolve(); },
      addListener: function(){ return Promise.resolve({remove:function(){}}); }
    },
    App: {
      addListener: function(name, cb){ if(name==='appUrlOpen') window.__appUrlHandlers.push(cb); return Promise.resolve({remove:function(){}}); }
    }
  }
};
`;

(async () => {
  let browser;
  try {
    await waitReady();
    browser = await chromium.launch({ executablePath: CHROME });
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 780 }, deviceScaleFactor: 2,
      isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul'
    });
    await ctx.addInitScript(FAKE_CAPACITOR);
    const page = await ctx.newPage();

    const pageErrors = [];
    const alerts = [];
    page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));
    // 안내 팝업이 뜨면 기록해 둔다 — 조용히 삼켜지면 실패 원인을 못 찾는다
    page.on('dialog', d => { alerts.push(d.message().slice(0, 200)); d.dismiss().catch(() => {}); });
    // 앱이 서버로 보내는 요청을 실제로 엿본다
    const posted = [];
    page.on('request', r => { if (r.method() === 'POST') posted.push({ url: r.url(), body: r.postData() }); });

    await page.goto(`${base}/app`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    // 운영에서는 소셜 콜백 주소와 API 서버 주소가 같은 도메인(roomer-backend.onrender.com)이다.
    // 이 테스트는 로컬 서버에서 도는 만큼 그 조건만 운영과 동일하게 맞춘다
    // (앱은 콜백 주소가 API 서버와 다르면 로그인을 시작하지 않도록 막아두었기 때문 — 올바른 동작).
    await page.evaluate(() => { window.NAVER_OAUTH.redirectUri = location.origin + '/oauth/naver/callback'; });

    // ------------------------------------------------------------------
    section('1. 앱으로 인식되는가');
    check('앱(설치형)으로 판정된다', await page.evaluate(() => window._isNativeApp === true));
    check('시스템 브라우저 경로를 쓸 수 있다', await page.evaluate(() => typeof nativeOauthAvailable === 'function' && nativeOauthAvailable() === true));
    check('딥링크 수신 리스너가 등록된다', await page.evaluate(() => window.__appUrlHandlers.length > 0), await page.evaluate(() => window.__appUrlHandlers.length));

    // ------------------------------------------------------------------
    section('2. 사람이 하듯 동의하고 네이버 버튼을 탭한다');
    await page.evaluate(() => { try { (window.go || go)('03'); } catch (e) {} });
    await page.waitForTimeout(1200);
    // 필수 동의 2개를 실제로 클릭한다
    const boxes = page.locator('#consent-03 input[type=checkbox][data-k]');
    await boxes.nth(0).click();
    await boxes.nth(1).click();
    const consentOk = await page.evaluate(() => window.consent03.tos === true && window.consent03.privacy === true);
    check('필수 동의 2개가 실제로 체크된다', consentOk);

    const urlBefore = page.url();
    await page.locator('#btn-naver-03').click();
    await page.waitForTimeout(1500);

    // ------------------------------------------------------------------
    section('3. ⭐ 앱이 화면을 떠나지 않는가 (원래 버그의 핵심)');
    check('앱 화면이 그대로 남아 있다(네이버로 튕기지 않음)', page.url() === urlBefore, { before: urlBefore, after: page.url() });

    section('4. 시스템 브라우저로 로그인 주소를 여는가');
    const opened = await page.evaluate(() => window.__openedUrls.slice());
    check('브라우저 열기 요청이 1건 있다', opened.length === 1, { count: opened.length, 안내팝업: alerts });
    const authUrl = opened[0] || '';
    check('네이버 인가 주소를 연다', authUrl.startsWith('https://nid.naver.com/oauth2.0/authorize'), authUrl.slice(0, 80));
    check('앱용 state가 붙어 있다', /[?&]state=app\./.test(authUrl), authUrl);
    check('콜백 주소가 우리 서버로 지정돼 있다', authUrl.includes(encodeURIComponent('/oauth/naver/callback')), authUrl);

    section('5. 세션 발급 요청이 실제로 나갔는가');
    const sessionReq = posted.find(p => p.url.endsWith('/api/auth/oauth-session'));
    check('앱이 일회용 세션을 먼저 만들었다', !!sessionReq, posted.map(p => p.url).slice(-3));
    check('어느 소셜인지 서버에 알렸다', !!sessionReq && /"provider"\s*:\s*"naver"/.test(sessionReq.body || ''), sessionReq && sessionReq.body);

    // ------------------------------------------------------------------
    section('6. ⭐ 브라우저에서 로그인이 끝나면 앱이 스스로 마무리하는가');
    // 실제 네이버 로그인을 대신해, 소셜이 콜백으로 돌아온 상황을 서버에 그대로 만든다.
    const state = decodeURIComponent((authUrl.match(/[?&]state=([^&]+)/) || [])[1] || '');
    const cbRes = await fetch(`${base}/oauth/naver/callback?code=UI-TEST-CODE-777&state=${encodeURIComponent(state)}`);
    check('콜백이 정상 처리된다', cbRes.status === 200, cbRes.status);

    // 딥링크로 앱이 앞으로 나오는 상황도 실제로 발생시킨다
    await page.evaluate(s => {
      window.__appUrlHandlers.forEach(function (cb) { cb({ url: 'roomer://oauth?s=' + s }); });
    }, state.replace('app.', ''));

    // 앱이 코드를 회수해 로그인 API까지 호출하는지 기다린다
    let finishReq = null;
    for (let i = 0; i < 40; i++) {
      finishReq = posted.find(p => p.url.includes('/api/auth/social/naver/callback'));
      if (finishReq) break;
      await sleep(300);
    }
    check('앱이 인가코드를 회수해 로그인을 마무리한다', !!finishReq, posted.map(p => p.url).slice(-4));
    check('회수한 코드가 브라우저에서 온 그 코드다', !!finishReq && (finishReq.body || '').includes('UI-TEST-CODE-777'), finishReq && (finishReq.body || '').slice(0, 160));
    check('동의 내용도 함께 전달된다', !!finishReq && /"consent"/.test(finishReq.body || ''));
    check('로그인 창을 닫는 처리까지 한다', await page.evaluate(() => window.__browserClosed > 0));

    section('7. 자바스크립트 오류 없이 끝나는가');
    check('화면에 자바스크립트 오류가 없다', pageErrors.length === 0, pageErrors.slice(0, 3));

    await ctx.close();
  } catch (e) {
    console.error('\n검증 예외:', e);
    console.error(serverLog.slice(-1500));
    fail++; failures.push('예외: ' + e.message);
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* 이미 종료 */ } }
    try { server.kill(); } catch (e) { /* 이미 종료 */ }
  }

  console.log('\n' + '='.repeat(70));
  console.log(` 앱 소셜로그인 화면 검증: ${pass}개 통과 / ${fail}개 실패`);
  if (failures.length) console.log(' 실패 항목:\n   - ' + failures.join('\n   - '));
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
})();
