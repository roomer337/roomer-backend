// ============================================================================
// 루머 ROOMER — 환경변수 자가진단 검증
//
// [무엇을 하나]
// 서버를 일부러 "잘못된 설정"으로 한 번, "올바른 설정"으로 한 번 띄워서
//   ① 잘못된 설정을 서버가 스스로 찾아내 로그에 🚨로 남기는가
//   ② 올바른 설정이면 조용히 ✅만 남기는가
//   ③ 비밀키 "값"이 로그에 새어나가지 않는가   ← 가장 중요
//   ④ 공개 /healthz가 서버 내부 경로·디스크 용량을 더 이상 노출하지 않는가
//   ⑤ 상세 진단이 관리자 인증 없이는 열리지 않는가
// 를 실제로 확인한다.
//
// [왜 필요한가]
// DB 경로·첨부 경로·앱 origin·문자 실발송 네 가지는 잘못 설정해도 서버가 아무 말 없이
// 잘 뜬다. 그리고 그 대가는 전부 며칠 뒤에 "데이터 소멸 / 메신저 먹통 / 가입 불가"로
// 돌아온다. 그래서 서버가 부팅할 때 스스로 판정하게 만들었고, 이 스크립트는 그 판정이
// 실제로 동작하는지를 검사한다.
//
// 실행: node tests/env-selfcheck.js
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const root = __dirname.replace(/[\\/]tests$/, '');
const SECRET = 'roomer-env-selfcheck-secret-32-chars-long';
const PII_KEY = 'ab'.repeat(32);

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : '')); }
};
const section = t => console.log('\n' + '='.repeat(70) + '\n ' + t + '\n' + '='.repeat(70));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 서버를 주어진 환경으로 띄우고, 부팅 로그를 모은 뒤 필요하면 살려둔다
async function boot(label, env, { keepAlive = false } = {}) {
  let log = '';
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JWT_SECRET: SECRET, PII_ENCRYPTION_KEY: PII_KEY, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', d => { log += d.toString(); });
  proc.stderr.on('data', d => { log += d.toString(); });
  // 부팅 진단은 listen 콜백에서 찍히므로 그 줄이 보일 때까지 기다린다
  for (let i = 0; i < 60; i++) {
    if (/백엔드 실행중/.test(log)) break;
    await sleep(500);
  }
  if (!keepAlive) { try { proc.kill(); } catch (e) { /* 이미 종료 */ } }
  return { label, log, proc, get: () => log };
}

(async () => {
  const badDb = path.join(os.tmpdir(), `roomer-envchk-bad-${process.pid}.db`);
  const disk = path.join(os.tmpdir(), `roomer-envchk-disk-${process.pid}`);
  fs.mkdirSync(path.join(disk, 'storage'), { recursive: true });
  const goodPort = 5300 + (process.pid % 80);
  let goodProc = null;

  try {
    // ------------------------------------------------------------------
    section('1. 잘못된 설정으로 띄웠을 때 — 서버가 스스로 찾아내는가');
    // 일부러 전부 틀리게: DB·첨부가 영구 디스크 밖, 앱 origin 누락, 문자 테스트모드
    const bad = await boot('bad', {
      PORT: String(goodPort + 1),
      DB_PATH: badDb,
      PERSISTENT_DISK_PATH: disk,          // 존재하지만 DB/첨부는 그 밖에 둔다
      LOCAL_STORAGE_DIR: path.join(os.tmpdir(), 'roomer-envchk-outside'),
      NODE_ENV: 'production',
      ALIGO_API_KEY: 'dummy-not-a-real-key',
      ALIGO_TEST_MODE: 'true',
      ALLOWED_ORIGIN: 'https://roomer-backend.onrender.com'
    });

    check('DB가 영구 디스크 밖이면 🚨로 경고한다', /🚨 DB_PATH/.test(bad.log));
    check('첨부 저장소가 영구 디스크 밖이면 🚨로 경고한다', /🚨 LOCAL_STORAGE_DIR/.test(bad.log));
    check('앱 origin이 빠지면 🚨로 경고한다', /🚨 ALLOWED_ORIGIN/.test(bad.log));
    check('문자 테스트모드면 🚨로 경고한다', /🚨 ALIGO_TEST_MODE/.test(bad.log));
    check('누락된 origin 이름을 정확히 알려준다', /capacitor:\/\/localhost/.test(bad.log));
    check('무엇을 해야 하는지(조치 방법)까지 알려준다', /\[조치 방법\]/.test(bad.log));
    check('즉시 조치 항목 건수를 요약해준다', /즉시 조치가 필요한 항목 4건/.test(bad.log), (bad.log.match(/즉시 조치가 필요한 항목.*/) || [])[0]);

    // ------------------------------------------------------------------
    section('2. 🔑 비밀키 "값"이 로그에 새지 않는가 (가장 중요)');
    check('JWT_SECRET 값이 로그에 없다', !bad.log.includes(SECRET));
    check('PII_ENCRYPTION_KEY 값이 로그에 없다', !bad.log.includes(PII_KEY));
    check('알리고 키 값이 로그에 없다', !bad.log.includes('dummy-not-a-real-key'));
    check('진단표에는 키 이름만 남는다', /PII_ENCRYPTION_KEY\s+설정됨/.test(bad.log));

    // ------------------------------------------------------------------
    section('3. 올바른 설정으로 띄웠을 때 — 조용한가');
    const good = await boot('good', {
      PORT: String(goodPort),
      DB_PATH: path.join(disk, 'roomer.db'),
      PERSISTENT_DISK_PATH: disk,
      LOCAL_STORAGE_DIR: path.join(disk, 'storage'),
      NODE_ENV: 'production',
      ALIGO_API_KEY: 'dummy-not-a-real-key',
      ALIGO_TEST_MODE: 'false',
      RESEND_API_KEY: 'dummy-resend',
      ALLOWED_ORIGIN: 'https://roomer-backend.onrender.com,https://localhost,capacitor://localhost'
    }, { keepAlive: true });
    goodProc = good.proc;

    check('DB 위치 정상 판정', /✅ DB_PATH/.test(good.log));
    check('첨부 저장소 정상 판정', /✅ LOCAL_STORAGE_DIR/.test(good.log));
    check('앱 origin 3개 포함 정상 판정', /✅ ALLOWED_ORIGIN/.test(good.log));
    check('문자 실발송 모드 정상 판정', /✅ ALIGO_TEST_MODE/.test(good.log));
    check('이메일 OTP(심사자 로그인) 가능 판정', /✅ RESEND_API_KEY/.test(good.log));
    check('즉시 조치 항목 없음으로 요약된다', /✅ 즉시 조치가 필요한 항목 없음/.test(good.log));
    check('🚨가 하나도 없다', !/🚨/.test(good.log), (good.log.match(/🚨.*/g) || []).slice(0, 3));

    // ------------------------------------------------------------------
    section('4. 공개 /healthz가 서버 내부를 노출하지 않는가');
    const base = `http://localhost:${goodPort}`;
    const res = await fetch(base + '/healthz');
    const body = await res.json();
    const raw = JSON.stringify(body);
    check('헬스체크는 200으로 응답한다(Render 감시용)', res.status === 200, res.status);
    check('살아있는지·DB가 붙는지는 알려준다', body.status === 'ok' && body.db && body.db.ok === true, body);
    check('DB 절대경로를 노출하지 않는다', !raw.includes('roomer.db') && !raw.includes(disk), raw.slice(0, 200));
    check('백업 폴더 경로를 노출하지 않는다', !/backups/.test(raw));
    check('디스크 잔여용량을 노출하지 않는다', !/freeMB|totalMB/.test(raw));
    check('경고 내용 대신 건수만 알려준다', typeof body.warningCount === 'number' && !Array.isArray(body.warnings), body.warningCount);

    // ------------------------------------------------------------------
    section('5. 상세 진단은 관리자만 볼 수 있는가');
    const noAuth = await fetch(base + '/api/admin/env-health');
    check('토큰 없이는 상세 진단이 열리지 않는다', noAuth.status === 401 || noAuth.status === 403, noAuth.status);
    const noAuthBody = await noAuth.text();
    check('거부 응답에도 경로가 새지 않는다', !noAuthBody.includes(disk));

  } catch (e) {
    console.error('\n검증 예외:', e);
    fail++; failures.push('예외: ' + e.message);
  } finally {
    if (goodProc) { try { goodProc.kill(); } catch (e) { /* 이미 종료 */ } }
  }

  console.log('\n' + '='.repeat(70));
  console.log(` 결과: ${pass} 성공 / ${fail} 실패`);
  if (failures.length) console.log(' 실패 항목:\n   - ' + failures.join('\n   - '));
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
})();
