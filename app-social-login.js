// ============================================================================
// 루머 ROOMER — 설치형 앱 소셜로그인 복귀 검증
//
// [무엇을 하나]
// 대표님이 실기기에서 겪으신 "앱에서 로그인을 누르면 네이버 앱 안으로 넘어가고, 로그인을 끝내도
// 앱은 계속 로그아웃 상태" 문제를 고친 새 경로를, 실제 폰이 하는 순서 그대로 재현해서 검증한다.
//
//   ① 앱이 일회용 로그인 세션을 만든다            (POST /api/auth/oauth-session)
//   ② 시스템 브라우저에서 로그인 → 소셜이 콜백으로 돌아온다 (GET /oauth/naver/callback?code=..&state=app.xxx)
//   ③ 브라우저 화면이 roomer:// 딥링크로 앱을 다시 부른다   (콜백 응답 HTML 확인)
//   ④ 앱이 인가코드를 회수한다                    (POST /api/auth/oauth-session/claim)
//
// 그리고 "가로채기 시도"도 실제로 해본다 — 딥링크만 훔친 악성 앱이 코드를 가져갈 수 있는지.
//
// 실행: node tests/app-social-login.js
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const root = __dirname.replace(/[\\/]tests$/, '');
const dbPath = path.join(os.tmpdir(), `roomer-appauth-${process.pid}.db`);
const secret = 'roomer-app-social-login-secret-32chars';
const piiKey = 'ab'.repeat(32);
const port = 5400 + (process.pid % 80);
const base = `http://localhost:${port}`;

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
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : '')); }
};
const section = t => console.log('\n' + '='.repeat(70) + '\n ' + t + '\n' + '='.repeat(70));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* HTML 응답 */ }
  return { status: res.status, json };
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

    // ------------------------------------------------------------------
    section('1. 앱이 로그인을 시작한다 — 일회용 세션 발급');
    const start = await api('POST', '/api/auth/oauth-session', { provider: 'naver' });
    check('앱이 로그인 세션을 만들 수 있다', start.status === 200 && start.json.success, start.status);
    const sess = start.json.data;
    check('브라우저로 내보낼 state를 받는다', typeof sess.state === 'string' && sess.state.startsWith('app.'), sess.state);
    check('앱만 아는 비밀값(claimSecret)을 받는다', typeof sess.claimSecret === 'string' && sess.claimSecret.length >= 32);
    check('state에는 비밀값이 들어있지 않다', !sess.state.includes(sess.claimSecret));
    check('세션에 만료시간이 있다', sess.expiresInSec > 0 && sess.expiresInSec <= 900, sess.expiresInSec);

    section('2. 로그인 전에는 아직 가져갈 것이 없다');
    const early = await api('POST', '/api/auth/oauth-session/claim', { sessionId: sess.sessionId, claimSecret: sess.claimSecret });
    check('아직 진행 중(pending)으로 답한다', early.status === 200 && early.json.data.status === 'pending', early.json);
    check('진행 중일 때 코드를 흘리지 않는다', !early.json.data.code);

    // ------------------------------------------------------------------
    section('3. ⭐ 브라우저에서 로그인이 끝나 콜백이 돌아온다 (핵심)');
    const cbRes = await fetch(`${base}/oauth/naver/callback?code=REAL-AUTH-CODE-123&state=${encodeURIComponent(sess.state)}`);
    const cbHtml = await cbRes.text();
    check('콜백이 정상 응답한다', cbRes.status === 200, cbRes.status);
    check('앱으로 돌아가는 딥링크가 들어있다', cbHtml.includes('roomer://oauth'), cbHtml.slice(0, 200));
    check('안드로이드 크롬용 intent 형식도 함께 넣는다', cbHtml.includes('intent://oauth') && cbHtml.includes('package=com.roomer.app'));
    check('자동 복귀가 막혀도 누를 수 있는 버튼이 있다', cbHtml.includes('앱으로 돌아가기'));
    check('🔑 인가코드는 딥링크·화면에 실리지 않는다', !cbHtml.includes('REAL-AUTH-CODE-123'), '코드가 브라우저 화면에 노출됨');

    // ------------------------------------------------------------------
    section('4. 🔑 딥링크를 훔쳐도 코드를 가져갈 수 없는가');
    // 같은 scheme을 등록한 악성 앱이 딥링크(roomer://oauth?s=세션ID)를 가로챈 상황.
    // 세션ID는 알지만 claimSecret은 모른다.
    const thief = await api('POST', '/api/auth/oauth-session/claim', { sessionId: sess.sessionId, claimSecret: 'f'.repeat(64) });
    check('비밀값이 틀리면 거부한다', thief.status === 404, thief.status);
    check('거부 응답에 코드가 들어있지 않다', !JSON.stringify(thief.json).includes('REAL-AUTH-CODE-123'));
    const thief2 = await api('POST', '/api/auth/oauth-session/claim', { sessionId: sess.sessionId });
    check('비밀값 없이 요청하면 거부한다', thief2.status === 400, thief2.status);

    // ------------------------------------------------------------------
    section('5. 앱이 인가코드를 회수한다');
    const claim = await api('POST', '/api/auth/oauth-session/claim', { sessionId: sess.sessionId, claimSecret: sess.claimSecret });
    check('앱은 코드를 가져올 수 있다', claim.status === 200 && claim.json.data.status === 'ready', claim.json);
    check('받은 코드가 브라우저에서 온 그 코드다', claim.json.data.code === 'REAL-AUTH-CODE-123', claim.json.data.code);
    check('어느 소셜인지도 함께 알려준다', claim.json.data.provider === 'naver');
    check('소셜에 되돌려줄 state도 함께 준다', claim.json.data.state === sess.state);

    section('6. 같은 코드를 두 번 쓸 수 없는가 (재사용 차단)');
    const again = await api('POST', '/api/auth/oauth-session/claim', { sessionId: sess.sessionId, claimSecret: sess.claimSecret });
    check('두 번째 회수에는 코드를 주지 않는다', !(again.json.data && again.json.data.code), again.json);
    check('이미 가져갔음(claimed)으로 표시된다', again.json.data && again.json.data.status === 'claimed', again.json);

    // ------------------------------------------------------------------
    section('7. 웹 브라우저 로그인은 예전 그대로 동작하는가 (회귀 확인)');
    const webCb = await fetch(`${base}/oauth/naver/callback?code=WEB-CODE&state=plain-web-state-value`);
    const webHtml = await webCb.text();
    check('웹 콜백은 앱 화면을 그대로 내려준다', webCb.status === 200 && webHtml.includes('<html'), webCb.status);
    check('웹 콜백에는 딥링크 화면이 끼어들지 않는다', !webHtml.includes('앱으로 돌아가기'));

    // ------------------------------------------------------------------
    section('8. 잘못된 요청들을 제대로 막는가');
    const badProvider = await api('POST', '/api/auth/oauth-session', { provider: 'facebook' });
    check('지원하지 않는 소셜은 거부한다', badProvider.status === 400, badProvider.status);
    const noProvider = await api('POST', '/api/auth/oauth-session', {});
    check('provider 없이 요청하면 거부한다', noProvider.status === 400, noProvider.status);
    const unknown = await api('POST', '/api/auth/oauth-session/claim', { sessionId: 'no-such-session', claimSecret: 'x'.repeat(64) });
    check('없는 세션은 404로 답한다', unknown.status === 404, unknown.status);

    section('9. 사용자가 로그인을 취소했을 때');
    const s2 = (await api('POST', '/api/auth/oauth-session', { provider: 'kakao' })).json.data;
    const cancelRes = await fetch(`${base}/oauth/kakao/callback?error=access_denied&state=${encodeURIComponent(s2.state)}`);
    const cancelHtml = await cancelRes.text();
    check('취소해도 서버가 오류로 죽지 않는다', cancelRes.status === 200, cancelRes.status);
    check('취소 안내 화면을 보여준다', cancelHtml.includes('로그인이 완료되지 않았어요'));
    const afterCancel = await api('POST', '/api/auth/oauth-session/claim', { sessionId: s2.sessionId, claimSecret: s2.claimSecret });
    check('앱에도 실패로 알려준다(무한 대기 방지)', afterCancel.status === 400 && afterCancel.json.error.code === 'OAUTH_SESSION_FAILED', afterCancel.json);

    section('10. 다른 소셜의 콜백으로 세션을 건드릴 수 없는가');
    const s3 = (await api('POST', '/api/auth/oauth-session', { provider: 'naver' })).json.data;
    const crossRes = await fetch(`${base}/oauth/kakao/callback?code=CROSS-CODE&state=${encodeURIComponent(s3.state)}`);
    check('네이버 세션을 카카오 콜백으로 채울 수 없다', crossRes.status === 400, crossRes.status);
    const crossClaim = await api('POST', '/api/auth/oauth-session/claim', { sessionId: s3.sessionId, claimSecret: s3.claimSecret });
    check('그 세션은 여전히 비어 있다', crossClaim.json.data.status === 'pending', crossClaim.json);

  } catch (e) {
    console.error('\n검증 예외:', e);
    console.error(serverLog.slice(-2000));
    fail++; failures.push('예외: ' + e.message);
  } finally {
    try { server.kill(); } catch (e) { /* 이미 종료 */ }
  }

  console.log('\n' + '='.repeat(70));
  console.log(` 앱 소셜로그인 검증: ${pass}개 통과 / ${fail}개 실패`);
  if (failures.length) console.log(' 실패 항목:\n   - ' + failures.join('\n   - '));
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
})();
