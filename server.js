// 루머 ROOMER 백엔드 프로토타입
// 프로토타입 화면(인별그램018.html)의 핵심 기능 일부를 실제로 동작하는 API로 구현한 것입니다.
// 실서비스에서는: SQLite→PostgreSQL, JWT시크릿 환경변수화, 소셜로그인 실제 OAuth 연동 필요
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const swaggerUi = require('swagger-ui-express');
const QRCode = require('qrcode');
const openapiSpec = require('./openapi.json');

const app = express();
// ===== 1-3(팀장 지시): 보안 정적점검 반영 =====
// 결함수정(사용자가 실제 폰에서 발견한 치명적 버그): helmet()의 기본 CSP(Content-Security-Policy)가
// 인라인 스크립트(<script>...</script>)와 인라인 이벤트핸들러(onclick="...")를 전부 차단해서,
// 화면은 보이지만 모든 버튼이 완전히 먹통이 되던 문제 → 루머03.html의 구조(인라인 스크립트/onclick 대량 사용)에 맞게 CSP 완화
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://t1.daumcdn.net"],
      scriptSrcAttr: ["'unsafe-inline'"], // onclick="..." 같은 인라인 이벤트핸들러 허용(이 프로토타입 전체가 이 방식으로 만들어짐)
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net", "data:"],
      connectSrc: ["'self'", "https:"],
      mediaSrc: ["'self'", "data:", "blob:"]
    }
  }
})); // 결함수정: 기본 보안헤더(X-Frame-Options 등) 전혀 없었음
// 공개 서버의 임의 origin 접근을 막고, 같은 서비스와 명시한 프론트 주소만 허용한다.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://roomer-backend.onrender.com').split(',').map(v => v.trim()).filter(Boolean);
app.use(cors({ origin(origin, callback) { callback(null, !origin || ALLOWED_ORIGINS.includes(origin)); } }));
app.use(express.json({ limit: '1mb' })); // 결함수정: 요청 본문 크기 제한이 없어 대용량 body로 서버 자원 고갈시키는 DoS가 가능했음
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { dotfiles: 'deny', maxAge: '1d', fallthrough: false }));

// 결함수정: 관리자 로그인에 무차별대입(brute-force) 방지가 전혀 없었음 → IP당 15분에 10회로 제한
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요' } }
});
// 결함수정: 소셜로그인도 무제한 호출 가능해서 대량 계정생성 남용 위험 → IP당 15분에 30회로 완만하게 제한
const socialAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요' } }
});
const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: '인증코드 요청이 너무 많습니다. 15분 후 다시 시도해주세요' } }
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: '인증 시도가 너무 많습니다. 15분 후 다시 시도해주세요' } }
});
const portfolioUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_UPLOADS', message: '사진 업로드가 너무 많습니다. 잠시 후 다시 시도해주세요' } }
});

// ===== 1-2(팀장 지시): 요청 로깅 미들웨어 =====
// 모든 요청의 method·path·상태코드·소요시간·요청자(있으면)를 기록(콘솔 + DB 양쪽)
// ⚡MVP-SWITCH: 실서버 → 파일/외부 로그수집기(CloudWatch, Datadog 등)로 전송하도록 교체. 지금은 콘솔+SQLite
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    let requester = null;
    try {
      const header = req.headers.authorization;
      if (header) {
        const payload = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
        requester = payload.role + ':' + payload.sub;
      }
    } catch (e) { /* 토큰 없거나 유효하지 않으면 null(익명)로 기록 */ }
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms) by ${requester || 'anonymous'}`);
    try {
      db.prepare('INSERT INTO request_logs (method, path, status_code, duration_ms, user_id) VALUES (?,?,?,?,?)')
        .run(req.method, req.originalUrl, res.statusCode, duration, requester);
    } catch (e) { console.error('로그 DB 기록 실패:', e.message); }
  });
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret-change-in-production');
if (!JWT_SECRET) throw new Error('운영환경에서는 JWT_SECRET 환경변수가 반드시 필요합니다.');
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  경고: JWT_SECRET 환경변수가 설정되지 않아 개발용 기본값을 사용 중입니다. 배포 전 반드시 환경변수로 강력한 값을 설정하세요.');
}

// ===== 1-1(팀장 지시): 입력값 검증 헬퍼 — 43개 API 전체에 공통 적용 =====
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^01[016789][0-9]{7,8}$/;
const BIZNO_RE = /^\d{3}-?\d{2}-?\d{5}$/;

function isNonEmptyString(v, maxLen = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}
function isPositiveInt(v) {
  return Number.isInteger(v) && v >= 0;
}
function isPositiveAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000_000_000; // 1000억 상한(비정상값 방지)
}
function validationError(res, message) {
  return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });
}
function hasRequiredConsent(consent) {
  return !!(consent && consent.tos === true && consent.privacy === true);
}

// ===== 인증 미들웨어 =====
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ success: false, error: { code: 'NO_TOKEN', message: '로그인이 필요합니다' } });
  try {
    const token = header.replace('Bearer ', '');
    req.user = jwt.verify(token, JWT_SECRET);
    if (!['consumer', 'partner'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: { code: 'INVALID_ROLE', message: '이 API에 사용할 수 없는 인증입니다' } });
    }
    // 신규(2차 심층검증 중 발견): 탈퇴한 회원의 토큰이 만료 전까지 계속 유효했던 보안 문제 수정
    // → 매 요청마다 탈퇴 여부를 확인해서, 탈퇴한 회원은 토큰이 남아있어도 즉시 차단
    if (req.user.role === 'consumer') {
      const u = db.prepare('SELECT withdrawn_at FROM users WHERE id=?').get(req.user.sub);
      if (!u || u.withdrawn_at) return res.status(401).json({ success: false, error: { code: 'ACCOUNT_WITHDRAWN', message: '탈퇴한 계정입니다' } });
    }
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '유효하지 않은 토큰입니다' } });
  }
}

function partnerSignupRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ success: false, error: { code: 'OTP_REQUIRED', message: '파트너 이메일 인증이 필요합니다' } });
  try {
    const payload = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    if (payload.role !== 'partner_signup' || !payload.loginId || payload.loginProvider !== 'email') {
      return res.status(403).json({ success: false, error: { code: 'INVALID_SIGNUP_TOKEN', message: '유효한 파트너 가입 인증이 아닙니다' } });
    }
    req.partnerSignup = payload;
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: { code: 'INVALID_SIGNUP_TOKEN', message: '파트너 가입 인증이 만료되었거나 유효하지 않습니다' } });
  }
}

// ===== 관리자 인증 미들웨어 =====
// 결함수정(팀장 지시 반영 — 코드 내 최우선 경고사항):
// 기존 프론트엔드는 클라이언트측 PIN 코드(2486) 하나로 관리자 진입이 가능했음.
// "이 클라이언트측 PIN 검증을 절대 그대로 쓰지 말 것"이라고 코드에 명시돼 있던 부분 →
// 서버측 이메일+비밀번호 로그인 + JWT(role 포함) + 역할기반 권한(RBAC)으로 완전히 교체
function adminAuthRequired(requiredRole) {
  return function (req, res, next) {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ success: false, error: { code: 'NO_TOKEN', message: '관리자 로그인이 필요합니다' } });
    try {
      const token = header.replace('Bearer ', '');
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.role !== 'admin_super' && payload.role !== 'admin_operator' && payload.role !== 'admin_cs') {
        return res.status(403).json({ success: false, error: { code: 'NOT_ADMIN', message: '관리자 권한이 없습니다' } });
      }
      if (requiredRole && payload.role !== requiredRole && payload.role !== 'admin_super') {
        return res.status(403).json({ success: false, error: { code: 'INSUFFICIENT_ROLE', message: '이 작업에 필요한 권한이 없습니다' } });
      }
      req.admin = payload;
      next();
    } catch (e) {
      res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '유효하지 않은 토큰입니다' } });
    }
  };
}

// ===== 0. 관리자 인증 =====
app.post('/api/admin/auth/login', adminLoginLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!isNonEmptyString(email) || !EMAIL_RE.test(email)) return validationError(res, '올바른 이메일 형식이 아닙니다');
  if (!isNonEmptyString(password, 100)) return validationError(res, '비밀번호를 입력해주세요');
  const admin = db.prepare('SELECT * FROM admins WHERE email=?').get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 올바르지 않습니다' } });
  }
  db.prepare("UPDATE admins SET last_login_at=datetime('now') WHERE id=?").run(admin.id);
  const token = jwt.sign({ sub: admin.id, role: 'admin_' + admin.role }, JWT_SECRET, { expiresIn: '4h' });
  res.json({ success: true, data: { token, role: admin.role } });
});

// 개발 전용: 최초 관리자 계정 생성(실서비스 배포 시 이 엔드포인트는 반드시 제거하고 DB에 직접 시딩할 것)
app.post('/api/admin/auth/seed-dev-only', (req, res) => {
  const { email, password, role } = req.body;
  if (!isNonEmptyString(email) || !EMAIL_RE.test(email)) return validationError(res, '올바른 이메일 형식이 아닙니다');
  if (!isNonEmptyString(password) || password.length < 8) return validationError(res, '비밀번호는 8자 이상이어야 합니다');
  if (role && !['super', 'operator', 'cs'].includes(role)) return validationError(res, '올바른 역할이 아닙니다');
  const existing = db.prepare('SELECT id FROM admins WHERE email=?').get(email);
  if (existing) return res.status(400).json({ success: false, error: { code: 'ALREADY_EXISTS', message: '이미 존재하는 관리자입니다' } });
  const id = randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admins (id, email, password_hash, role) VALUES (?,?,?,?)').run(id, email, hash, role || 'super');
  res.json({ success: true, data: { id, message: '개발용 관리자 계정이 생성됐습니다(실배포 전 이 엔드포인트 제거 필수)' } });
});


// ===== 1. 인증 (소셜로그인은 데모용으로 간소화 — 실제로는 카카오/네이버 API와 통신해야 함) =====
app.post('/api/auth/social/:provider', socialAuthLimiter, (req, res) => {
  const { provider } = req.params;
  const { socialId, nickname } = req.body;
  if (!['kakao', 'naver', 'google'].includes(provider)) return validationError(res, '지원하지 않는 로그인 방식입니다');
  if (!isNonEmptyString(socialId, 100)) return validationError(res, 'socialId가 필요합니다');
  if (nickname && !isNonEmptyString(nickname, 30)) return validationError(res, '닉네임은 30자 이내여야 합니다');

  let user = db.prepare('SELECT * FROM users WHERE social_provider=? AND social_id=?').get(provider, socialId);
  if (!user) {
    const id = randomUUID();
    // 신규(사용자요청 — 캐시→크레딧 명칭통일 + 실제 가입혜택 지급): 첫화면 배너("가입시 29,000크레딧")가
    // 실제로는 지급되지 않던 문제 발견·수정. 가입 즉시 29,000크레딧을 실제로 적립.
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname, cash_balance) VALUES (?,?,?,?,?)')
      .run(id, provider, socialId, nickname || '회원', 29000);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const token = jwt.sign({ sub: user.id, role: 'consumer' }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ success: true, data: { token, user } });
});

// 신규(사용자요청 — 카카오 REST API 키 발급 완료, 실연동 구현): 실제 카카오 OAuth 콜백.
// 인가코드(code)를 카카오 토큰 API로 교환 → 액세스 토큰으로 사용자 정보 조회 → users upsert → JWT 발급.
app.post('/api/auth/social/kakao/callback', socialAuthLimiter, async (req, res) => {
  const { code, redirectUri, consent } = req.body;
  if (!isNonEmptyString(code, 500)) return validationError(res, 'code가 필요합니다');
  if (!hasRequiredConsent(consent)) return validationError(res, '필수 이용약관과 개인정보 수집 동의가 필요합니다');
  const restApiKey = process.env.KAKAO_REST_API_KEY;
  if (!restApiKey) {
    return res.status(501).json({ success: false, error: { code: 'KAKAO_NOT_CONFIGURED', message: '카카오 로그인이 아직 설정되지 않았어요.' } });
  }
  // 신규(사용자요청 — 카카오 앱이 "클라이언트 시크릿" 활성화 상태로 발급되어, 토큰교환시
  // client_secret이 없으면 실패하는 문제 발견·수정): 환경변수로만 관리(코드에 절대 하드코딩 금지)
  const clientSecret = process.env.KAKAO_CLIENT_SECRET;
  try {
    // 1) 인가코드 → 액세스 토큰 교환
    const tokenParams = {
      grant_type: 'authorization_code',
      client_id: restApiKey,
      redirect_uri: redirectUri || 'https://roomer-backend.onrender.com/oauth/kakao/callback',
      code: code
    };
    if (clientSecret) tokenParams.client_secret = clientSecret;
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(tokenParams)
    });
    const tokenBody = await tokenRes.json();
    if (!tokenRes.ok || !tokenBody.access_token) {
      console.error('카카오 토큰 교환 실패:', tokenBody);
      return res.status(400).json({ success: false, error: { code: 'KAKAO_TOKEN_ERROR', message: '카카오 인증에 실패했어요. 다시 로그인해주세요.' } });
    }
    // 2) 액세스 토큰으로 사용자 정보 조회
    const profileRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { 'Authorization': 'Bearer ' + tokenBody.access_token }
    });
    const profileBody = await profileRes.json();
    if (!profileRes.ok || !profileBody.id) {
      console.error('카카오 사용자정보 조회 실패:', profileBody);
      return res.status(400).json({ success: false, error: { code: 'KAKAO_PROFILE_ERROR', message: '카카오 사용자 정보를 가져오지 못했어요.' } });
    }
    const kakaoId = String(profileBody.id);
    const nickname = (profileBody.kakao_account && profileBody.kakao_account.profile && profileBody.kakao_account.profile.nickname) || '카카오회원';
    const email = (profileBody.kakao_account && profileBody.kakao_account.email) || null;
    // 3) users 테이블 upsert(기존 회원이면 그대로, 신규면 29,000크레딧 지급)
    let user = db.prepare('SELECT * FROM users WHERE social_provider=? AND social_id=?').get('kakao', kakaoId);
    if (!user) {
      const id = randomUUID();
      db.prepare('INSERT INTO users (id, social_provider, social_id, nickname, email, cash_balance) VALUES (?,?,?,?,?,?)')
        .run(id, 'kakao', kakaoId, nickname, email, 29000);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    }
    db.prepare('UPDATE users SET consent_marketing=?, consent_location=? WHERE id=?').run(consent.marketing === true ? 1 : 0, consent.location === true ? 1 : 0, user.id);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    const jwtToken = jwt.sign({ sub: user.id, role: 'consumer' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, data: { token: jwtToken, user, providerUserId: kakaoId, nickname, email } });
  } catch (e) {
    console.error('카카오 로그인 처리 중 오류:', e.message);
    res.status(500).json({ success: false, error: { code: 'KAKAO_CALLBACK_ERROR', message: '카카오 로그인 처리 중 오류가 발생했어요.' } });
  }
});

// 신규(사용자요청 — 네이버도 카카오처럼 실연동): 네이버 OAuth 콜백. 카카오와 동일한 구조(인가코드→
// 토큰교환→사용자정보조회→users upsert→JWT발급), 네이버 API 스펙에 맞춰 구현.
app.post('/api/auth/social/naver/callback', socialAuthLimiter, async (req, res) => {
  const { code, state, redirectUri, consent } = req.body;
  if (!isNonEmptyString(code, 500)) return validationError(res, 'code가 필요합니다');
  if (!hasRequiredConsent(consent)) return validationError(res, '필수 이용약관과 개인정보 수집 동의가 필요합니다');
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: '네이버 로그인 연동이 아직 준비 중이에요.' } });
  }
  try {
    // 1) 인가코드 → 액세스 토큰 교환
    const tokenRes = await fetch('https://nid.naver.com/oauth2.0/token?' + new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      state: state || ''
    }));
    const tokenBody = await tokenRes.json();
    if (!tokenRes.ok || !tokenBody.access_token) {
      console.error('네이버 토큰 교환 실패:', tokenBody);
      return res.status(400).json({ success: false, error: { code: 'NAVER_TOKEN_ERROR', message: '네이버 인증에 실패했어요. 다시 로그인해주세요.' } });
    }
    // 2) 액세스 토큰으로 사용자 정보 조회
    const profileRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { 'Authorization': 'Bearer ' + tokenBody.access_token }
    });
    const profileBody = await profileRes.json();
    if (!profileRes.ok || !profileBody.response || !profileBody.response.id) {
      console.error('네이버 사용자정보 조회 실패:', profileBody);
      return res.status(400).json({ success: false, error: { code: 'NAVER_PROFILE_ERROR', message: '네이버 사용자 정보를 가져오지 못했어요.' } });
    }
    const naverId = String(profileBody.response.id);
    const nickname = profileBody.response.nickname || profileBody.response.name || '네이버회원';
    const email = profileBody.response.email || null;
    // 3) users 테이블 upsert(기존 회원이면 그대로, 신규면 29,000크레딧 지급)
    let user = db.prepare('SELECT * FROM users WHERE social_provider=? AND social_id=?').get('naver', naverId);
    if (!user) {
      const id = randomUUID();
      db.prepare('INSERT INTO users (id, social_provider, social_id, nickname, email, cash_balance) VALUES (?,?,?,?,?,?)')
        .run(id, 'naver', naverId, nickname, email, 29000);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    }
    db.prepare('UPDATE users SET consent_marketing=?, consent_location=? WHERE id=?').run(consent.marketing === true ? 1 : 0, consent.location === true ? 1 : 0, user.id);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    const jwtToken = jwt.sign({ sub: user.id, role: 'consumer' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, data: { token: jwtToken, user, providerUserId: naverId, nickname, email } });
  } catch (e) {
    console.error('네이버 로그인 처리 중 오류:', e.message);
    res.status(500).json({ success: false, error: { code: 'NAVER_CALLBACK_ERROR', message: '네이버 로그인 처리 중 오류가 발생했어요.' } });
  }
});

// 신규(사용자요청 — 실제 이메일 인증코드 발송): Resend API로 실제 이메일 발송.
// 6자리 코드를 생성해 DB에 5분 만료로 저장하고, 실제 이메일을 보낸다.
app.post('/api/otp/email/send', otpSendLimiter, async (req, res) => {
  const { email, forPartner, partnerMode } = req.body;
  if (!isNonEmptyString(email, 200) || !EMAIL_RE.test(email)) return validationError(res, '올바른 이메일 형식이 아닙니다');
  if (forPartner && !['signup', 'login'].includes(partnerMode)) return validationError(res, '파트너 인증 목적이 올바르지 않습니다');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = bcrypt.hashSync(code, 10);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const purpose = forPartner ? 'partner_' + partnerMode : 'consumer';
  db.prepare('UPDATE otp_codes SET consumed_at=datetime(\'now\') WHERE target=? AND purpose=? AND consumed_at IS NULL').run(email.toLowerCase(), purpose);
  db.prepare('INSERT INTO otp_codes (id, target, code, expires_at, purpose) VALUES (?,?,?,?,?)').run(id, email.toLowerCase(), codeHash, expiresAt, purpose);
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    db.prepare('DELETE FROM otp_codes WHERE id=?').run(id);
    return res.status(503).json({ success: false, error: { code: 'EMAIL_NOT_CONFIGURED', message: '이메일 인증 서비스 설정이 필요합니다' } });
  }
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Resend 운영 발신주소는 검증된 도메인의 주소를 Render 환경변수로 지정한다.
        // 미지정 시 Resend 시험용 주소를 사용하며, 이 경우 수신자가 제한될 수 있다.
        from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
        to: email,
        subject: '[루머 ROOMER] 인증코드 안내',
        html: '<p>안녕하세요, 루머(ROOMER)입니다.</p><p>인증코드는 <strong style="font-size:20px">' + code + '</strong> 입니다.<br>5분 이내에 입력해주세요.</p>'
      })
    });
    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      console.error('이메일 발송 실패:', errBody);
      db.prepare('DELETE FROM otp_codes WHERE id=?').run(id);
      return res.status(500).json({ success: false, error: { code: 'EMAIL_SEND_ERROR', message: '이메일 발송에 실패했어요. 잠시 후 다시 시도해주세요.' } });
    }
    res.json({ success: true, data: { sent: true } });
  } catch (e) {
    console.error('이메일 발송 오류:', e.message);
    db.prepare('DELETE FROM otp_codes WHERE id=?').run(id);
    res.status(500).json({ success: false, error: { code: 'EMAIL_SEND_ERROR', message: '이메일 발송 중 오류가 발생했어요.' } });
  }
});

// 신규(사용자요청): 이메일 인증코드 확인. 일치하면 users upsert(신규면 29,000크레딧) 후 JWT 발급.
// 파트너 가입 흐름에서는 단순 확인(verified)만 쓰고, 유저 생성은 프론트에서 별도 처리.
app.post('/api/otp/email/verify', otpVerifyLimiter, (req, res) => {
  const { email, code, forPartner, partnerMode } = req.body;
  if (!isNonEmptyString(email, 200) || !isNonEmptyString(code, 10)) return validationError(res, 'email과 code가 필요합니다');
  if (forPartner && !['signup', 'login'].includes(partnerMode)) return validationError(res, '파트너 인증 목적이 올바르지 않습니다');
  const normalizedEmail = email.toLowerCase();
  const purpose = forPartner ? 'partner_' + partnerMode : 'consumer';
  const row = db.prepare('SELECT * FROM otp_codes WHERE target=? AND purpose=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1').get(normalizedEmail, purpose);
  if (!row) return res.status(400).json({ success: false, error: { code: 'OTP_NOT_FOUND', message: '인증코드를 먼저 요청해주세요.' } });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ success: false, error: { code: 'OTP_EXPIRED', message: '인증코드가 만료됐어요. 다시 요청해주세요.' } });
  if (row.attempts >= 5) return res.status(429).json({ success: false, error: { code: 'OTP_LOCKED', message: '인증 시도 횟수를 초과했습니다. 코드를 다시 요청해주세요.' } });
  if (!bcrypt.compareSync(code, row.code)) {
    db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    return res.status(400).json({ success: false, error: { code: 'OTP_MISMATCH', message: '인증코드가 일치하지 않아요.' } });
  }
  db.prepare("UPDATE otp_codes SET verified=1, consumed_at=datetime('now') WHERE id=?").run(row.id);
  if (forPartner) {
    if (partnerMode === 'login') {
      const partner = db.prepare('SELECT * FROM partners WHERE login_provider=? AND login_id=?').get('email', normalizedEmail);
      if (!partner) return res.status(404).json({ success: false, error: { code: 'PARTNER_NOT_FOUND', message: '이 이메일로 가입된 파트너를 찾을 수 없습니다' } });
      const partnerToken = jwt.sign({ sub: partner.id, role: 'partner' }, JWT_SECRET, { expiresIn: '4h' });
      return res.json({ success: true, data: { token: partnerToken, partner, verified: true } });
    }
    const signupToken = jwt.sign({ role: 'partner_signup', loginId: normalizedEmail, loginProvider: 'email' }, JWT_SECRET, { expiresIn: '30m' });
    return res.json({ success: true, data: { token: signupToken, verified: true } });
  }
  let user = db.prepare('SELECT * FROM users WHERE social_provider=? AND social_id=?').get('email', normalizedEmail);
  if (!user) {
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname, email, cash_balance) VALUES (?,?,?,?,?,?)')
      .run(id, 'email', normalizedEmail, normalizedEmail.split('@')[0], normalizedEmail, 29000);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const token = jwt.sign({ sub: user.id, role: 'consumer' }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ success: true, data: { token, user, verified: true } });
});

// ===== 2. 회원 =====
app.get('/api/users/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
  if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다' } });
  res.json({ success: true, data: user });
});

app.patch('/api/users/me/consent', authRequired, (req, res) => {
  const { marketing, location } = req.body;
  if (typeof marketing !== 'boolean' || typeof location !== 'boolean') return validationError(res, 'marketing/location은 true/false 값이어야 합니다');
  db.prepare('UPDATE users SET consent_marketing=?, consent_location=? WHERE id=?')
    .run(marketing ? 1 : 0, location ? 1 : 0, req.user.sub);
  res.json({ success: true, data: { marketing, location } });
});

app.get('/api/users/me/data-export', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(user);
});

app.delete('/api/users/me', authRequired, (req, res) => {
  db.prepare("UPDATE users SET withdrawn_at=datetime('now') WHERE id=?").run(req.user.sub);
  res.json({ success: true, data: { message: '탈퇴 처리되었습니다' } });
});

// ===== 3. 업체 가입·검증 =====
// 결함수정(팀장 지시 반영): 기존엔 등록 즉시 승인(approved_at)되어 관리자 검수 절차 자체가 없었음
// → 프론트엔드(루머02.html) 정책과 일치하도록 pending 상태로 시작, 관리자 승인 후에만 검색·노출되게 수정
app.post('/api/partners/register', partnerSignupRequired, (req, res) => {
  const { businessName, businessRegNumber, licenseNumber, ceoName, address, region, docImageUrl, extImageUrl, intImageUrl,
    intro, strengthTags, portfolioImages, availableHours, spaceCategories, loginId, loginProvider } = req.body;
  if (!isNonEmptyString(businessName, 100)) return validationError(res, '상호명을 입력해주세요(100자 이내)');
  if (!isNonEmptyString(businessRegNumber) || !BIZNO_RE.test(businessRegNumber)) return validationError(res, '사업자등록번호 형식이 올바르지 않습니다(예: 123-45-67890)');
  if (ceoName && !isNonEmptyString(ceoName, 30)) return validationError(res, '대표자명은 30자 이내여야 합니다');
  if (address && !isNonEmptyString(address, 200)) return validationError(res, '주소는 200자 이내여야 합니다');
  // 신규(사용자요청 — 2단계: 가입폼 확장) 필드 검증
  if (intro && !isNonEmptyString(intro, 50)) return validationError(res, '한줄소개는 50자 이내여야 합니다');
  if (strengthTags && (!Array.isArray(strengthTags) || strengthTags.length > 5)) return validationError(res, '강점 키워드는 최대 5개까지 선택 가능합니다');
  if (portfolioImages && (!Array.isArray(portfolioImages) || portfolioImages.length > 6)) return validationError(res, '대표 시공사진은 최대 6장까지 등록 가능합니다');
  if (spaceCategories && !Array.isArray(spaceCategories)) return validationError(res, '전문분야 형식이 올바르지 않습니다');
  // 재설계(사용자요청): 사업자등록증 없으면 플랫폼 등록 자체를 제한하는 정책
  if (!docImageUrl) {
    return res.status(400).json({ success: false, error: { code: 'DOC_REQUIRED', message: '사업자등록증을 올려야 등록할 수 있습니다' } });
  }
  const verifiedLoginId = req.partnerSignup.loginId;
  const verifiedLoginProvider = req.partnerSignup.loginProvider;
  if ((loginId && loginId.toLowerCase() !== verifiedLoginId) || (loginProvider && loginProvider !== verifiedLoginProvider)) {
    return res.status(403).json({ success: false, error: { code: 'LOGIN_ID_MISMATCH', message: '인증한 이메일과 가입 이메일이 일치하지 않습니다' } });
  }
  const duplicateLogin = db.prepare('SELECT id FROM partners WHERE login_provider=? AND login_id=?').get(verifiedLoginProvider, verifiedLoginId);
  if (duplicateLogin) return res.status(409).json({ success: false, error: { code: 'ALREADY_EXISTS', message: '이미 가입된 파트너 이메일입니다' } });
  const id = randomUUID();
  const tier = licenseNumber ? '면허 파트너' : '부분공사가능업체';
  db.prepare(`INSERT INTO partners (id, login_provider, login_id, business_name, business_reg_number, license_number, ceo_name, address, tier, region, doc_image_url, ext_image_url, int_image_url, verify_status, cert_license, intro, strength_tags, portfolio_images, available_hours, space_categories)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?,?,?,?,?,?)`)
    .run(id, verifiedLoginProvider, verifiedLoginId, businessName, businessRegNumber, licenseNumber || null, ceoName || null, address || null, tier, region || null, docImageUrl, extImageUrl || null, intImageUrl || null, tier === '면허 파트너' ? 1 : 0,
      intro || null, JSON.stringify(strengthTags || []), JSON.stringify(portfolioImages || []), availableHours || null, JSON.stringify(spaceCategories || []));
  const token = jwt.sign({ sub: id, role: 'partner' }, JWT_SECRET, { expiresIn: '1h' });
  const partner = db.prepare('SELECT * FROM partners WHERE id=?').get(id);
  res.json({ success: true, data: { id, tier, verifyStatus: 'pending', token, partner, licenseLimitNotice: tier === '부분공사가능업체' ? '무면허 업체는 1,500만원 이상 종합공사를 진행할 수 없습니다.' : null } });
});

app.get('/api/partners/search', (req, res) => {
  const { region, category } = req.query;
  // 결함수정: 승인된(approved) 업체만 검색 노출되도록 verify_status 조건 추가(기존 approved_at만 보던 것 정리)
  let query = "SELECT * FROM partners WHERE verify_status='approved'";
  const params = [];
  if (region) { query += ' AND region LIKE ?'; params.push(`%${region}%`); }
  const partners = db.prepare(query).all(...params);
  res.json({ success: true, data: partners });
});

// 신규(사용자요청 — ChatGPT 협업 병합): 로그인한 파트너 본인의 프로필 조회.
// 주의: 반드시 아래의 '/api/partners/:id'보다 먼저 등록해야 함(Express는 등록순서대로 매칭하므로,
// 순서가 바뀌면 'me'라는 문자열이 :id 파라미터로 잘못 매칭되어버림)
app.get('/api/partners/me', authRequired, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 접근할 수 있습니다' } });
  const partner = db.prepare('SELECT * FROM partners WHERE id=?').get(req.user.sub);
  if (!partner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '업체 정보를 찾을 수 없습니다' } });
  res.json({ success: true, data: partner });
});

app.get('/api/partners/:id', (req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!partner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '업체를 찾을 수 없습니다' } });
  res.json({ success: true, data: partner });
});

// ===== 3-1. 관리자 — 업체 가입심사 큐 =====
app.get('/api/admin/partners/pending', adminAuthRequired(), (req, res) => {
  const list = db.prepare("SELECT * FROM partners WHERE verify_status='pending' ORDER BY created_at DESC").all();
  res.json({ success: true, data: list });
});

app.put('/api/admin/partners/:id/approve', adminAuthRequired(), (req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!partner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '업체를 찾을 수 없습니다' } });
  db.prepare(`UPDATE partners SET verify_status='approved', approved_at=datetime('now'),
    cert_business=1, cert_location=1, cert_contact=1 WHERE id=?`).run(req.params.id);
  res.json({ success: true, data: { message: '승인되었습니다' } });
});

app.put('/api/admin/partners/:id/reject', adminAuthRequired(), (req, res) => {
  const { reason } = req.body;
  const result = db.prepare("UPDATE partners SET verify_status='rejected', reject_reason=? WHERE id=?").run(reason || '서류 미비', req.params.id);
  if (result.changes === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '업체를 찾을 수 없습니다' } });
  res.json({ success: true, data: { message: '반려되었습니다' } });
});

// ===== 3-2. 포트폴리오(프로젝트 단위: 제목+여러사진+설명) =====
function parseMultipartBody(req) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match || !Buffer.isBuffer(req.body)) throw new Error('MULTIPART_REQUIRED');
  const boundary = Buffer.from('--' + (match[1] || match[2]).trim());
  const fields = {};
  const files = [];
  let cursor = req.body.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (req.body.slice(cursor, cursor + 2).toString() === '--') break;
    if (req.body.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const next = req.body.indexOf(boundary, cursor);
    if (next === -1) break;
    const headerEnd = req.body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1 || headerEnd > next) throw new Error('INVALID_MULTIPART');
    const headerText = req.body.slice(cursor, headerEnd).toString('utf8');
    let dataEnd = next;
    if (req.body.slice(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
    const data = req.body.slice(headerEnd + 4, dataEnd);
    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const filenameMatch = headerText.match(/filename="([^"]*)"/i);
    const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);
    if (nameMatch) {
      if (filenameMatch) files.push({ field: nameMatch[1], filename: filenameMatch[1], declaredType: (typeMatch && typeMatch[1].trim().toLowerCase()) || '', data });
      else fields[nameMatch[1]] = data.toString('utf8');
    }
    cursor = next;
  }
  return { fields, files };
}

function detectPortfolioImage(file) {
  const b = file.data;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const portfolioMultipart = express.raw({ type: 'multipart/form-data', limit: '105mb' });
app.post('/api/partners/me/portfolio', authRequired, portfolioUploadLimiter, portfolioMultipart, (req, res, next) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 등록할 수 있습니다' } });
  let parsed;
  try { parsed = parseMultipartBody(req); }
  catch (e) { return validationError(res, 'multipart/form-data 형식의 사진 업로드가 필요합니다'); }
  const { title, description } = parsed.fields;
  const photoFiles = parsed.files.filter(file => file.field === 'photos');
  if (!isNonEmptyString(title, 60)) return validationError(res, '제목은 1~60자여야 합니다');
  if (description && !isNonEmptyString(description, 1000)) return validationError(res, '설명은 1000자 이내여야 합니다');
  if (photoFiles.length === 0) return validationError(res, '사진을 1장 이상 올려주세요');
  if (photoFiles.length > 10) return validationError(res, '사진은 최대 10장까지 올릴 수 있습니다');
  const validated = [];
  for (const file of photoFiles) {
    if (file.data.length === 0 || file.data.length > 10 * 1024 * 1024) return validationError(res, '사진 1장당 최대 10MB까지 올릴 수 있습니다');
    const detected = detectPortfolioImage(file);
    if (!detected || file.declaredType !== detected.mime) return validationError(res, 'JPG, PNG, WebP 이미지 파일만 올릴 수 있습니다');
    validated.push({ ...file, ...detected });
  }
  const projectId = randomUUID();
  const uploadDir = path.join(__dirname, 'uploads', 'portfolio');
  fs.mkdirSync(uploadDir, { recursive: true });
  const savedPaths = [];
  try {
    const photos = validated.map((file, i) => {
      const storedName = projectId + '-' + i + '-' + randomUUID() + '.' + file.ext;
      const diskPath = path.join(uploadDir, storedName);
      fs.writeFileSync(diskPath, file.data, { flag: 'wx' });
      savedPaths.push(diskPath);
      return '/uploads/portfolio/' + storedName;
    });
    const saveProject = db.transaction(() => {
      db.prepare('INSERT INTO portfolio_projects (id, partner_id, title, description) VALUES (?,?,?,?)').run(projectId, req.user.sub, title.trim(), description ? description.trim() : null);
      const insertPhoto = db.prepare('INSERT INTO portfolio_photos (id, project_id, image_url, sort_order) VALUES (?,?,?,?)');
      photos.forEach((url, i) => insertPhoto.run(randomUUID(), projectId, url, i));
    });
    saveProject();
    res.json({ success: true, data: { id: projectId, title: title.trim(), description: description ? description.trim() : '', photos } });
  } catch (e) {
    savedPaths.forEach(filePath => { try { fs.unlinkSync(filePath); } catch (_) {} });
    next(e);
  }
});

app.get('/api/partners/:id/portfolio', (req, res) => {
  const projects = db.prepare('SELECT * FROM portfolio_projects WHERE partner_id=? ORDER BY created_at DESC').all(req.params.id);
  const getPhotos = db.prepare('SELECT image_url FROM portfolio_photos WHERE project_id=? ORDER BY sort_order');
  const withPhotos = projects.map(p => ({ ...p, photos: getPhotos.all(p.id).map(r => r.image_url) }));
  res.json({ success: true, data: withPhotos });
});

// 신규(사용자요청 — 완성도리포트 개선: REALCASES 색상placeholder를 실제사진으로 대체):
// 승인된(verify_status='approved') 모든 업체의 포트폴리오 프로젝트를 최신순으로 모아
// 소비자 피드(완공사례)에 실제 데이터로 노출하기 위한 API. 사진이 없으면 빈 배열 반환(정직).
app.get('/api/portfolio/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 60);
  const projects = db.prepare(`
    SELECT pp.id, pp.title, pp.description, pp.created_at, p.business_name, p.region, p.tier
    FROM portfolio_projects pp
    JOIN partners p ON p.id = pp.partner_id
    WHERE p.verify_status = 'approved'
    ORDER BY pp.created_at DESC
    LIMIT ?
  `).all(limit);
  const getPhotos = db.prepare('SELECT image_url FROM portfolio_photos WHERE project_id=? ORDER BY sort_order');
  const withPhotos = projects.map(p => ({ ...p, photos: getPhotos.all(p.id).map(r => r.image_url) }));
  res.json({ success: true, data: withPhotos });
});

// ===== 4. 견적 요청 =====
app.post('/api/quote-requests', authRequired, (req, res) => {
  const { partnerId, address, pyeong, spaceType } = req.body;
  if (!isNonEmptyString(partnerId, 100)) return validationError(res, '업체를 선택해주세요');
  if (!isNonEmptyString(address, 200)) return validationError(res, '주소를 입력해주세요');
  if (!Number.isInteger(pyeong) || pyeong <= 0 || pyeong > 1000) return validationError(res, '평수는 1~1000 사이의 정수여야 합니다');
  if (!isNonEmptyString(spaceType, 30)) return validationError(res, '공간유형을 입력해주세요');
  const partnerExists = db.prepare('SELECT id FROM partners WHERE id=?').get(partnerId);
  if (!partnerExists) return validationError(res, '존재하지 않는 업체입니다');
  const id = randomUUID();
  db.prepare('INSERT INTO quote_requests (id, user_id, partner_id, address, pyeong, space_type) VALUES (?,?,?,?,?,?)')
    .run(id, req.user.sub, partnerId, address, pyeong, spaceType);
  // 신규(사용자요청 — 견적요청 알림): 견적요청 시 소비자-업체 채팅방을 자동으로 찾거나 만들고,
  // 그 방에 "견적요청" 타입의 특수 메시지를 남겨서 업체가 메신저에서 바로 확인·구분할 수 있게 함
  let room = db.prepare('SELECT * FROM chat_rooms WHERE consumer_id=? AND partner_id=?').get(req.user.sub, partnerId);
  if (!room) {
    const roomId = randomUUID();
    db.prepare('INSERT INTO chat_rooms (id, consumer_id, partner_id) VALUES (?,?,?)').run(roomId, req.user.sub, partnerId);
    db.prepare('INSERT INTO meas_jobs (room_id) VALUES (?)').run(roomId);
    room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(roomId);
  }
  const quoteMsgText = JSON.stringify({ requestId: id, address, pyeong, spaceType });
  db.prepare('INSERT INTO chat_messages (id, room_id, sender_role, sender_id, text, msg_type) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), room.id, 'consumer', req.user.sub, quoteMsgText, 'quote_request');
  res.json({ success: true, data: { id, status: 'requested', roomId: room.id } });
});

app.get('/api/quote-requests/mine', authRequired, (req, res) => {
  const list = db.prepare('SELECT * FROM quote_requests WHERE user_id=? ORDER BY created_at DESC').all(req.user.sub);
  res.json({ success: true, data: list });
});

// ===== 4-1. 견적서(업체 → 소비자, 공정별 상세내역 필수) =====
// 결함 재발 방지(프론트엔드에서 실제 발견된 버그): 공정별 항목명+단가(items)가 누락되면
// 소비자에게 총액만 전달되고 상세내역이 안 보이는 문제가 있었음 — items 필수값으로 강제
app.post('/api/quotes', authRequired, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 견적서를 보낼 수 있습니다' } });
  const { requestId, pyeong, items, type } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: { code: 'ITEMS_REQUIRED', message: '공정별 항목이 1개 이상 필요합니다(총액만 보내는 것 금지)' } });
  }
  if (items.length > 100) return validationError(res, '항목은 최대 100개까지 가능합니다');
  for (const it of items) {
    if (!isNonEmptyString(it.name, 100)) return validationError(res, '항목명은 1~100자여야 합니다');
    if (!isPositiveAmount(it.price) || it.price <= 0) return validationError(res, '항목 가격은 0보다 큰 숫자여야 합니다');
    if (it.phaseLabel && !isNonEmptyString(it.phaseLabel, 50)) return validationError(res, '공정명은 50자 이내여야 합니다');
  }
  if (type && !['initial', 'additional'].includes(type)) return validationError(res, '올바른 견적서 유형이 아닙니다');
  const request = db.prepare('SELECT * FROM quote_requests WHERE id=?').get(requestId);
  if (!request) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '견적요청을 찾을 수 없습니다' } });

  const total = items.reduce((sum, it) => sum + (Number(it.price) || 0), 0);
  const quoteId = randomUUID();
  db.prepare('INSERT INTO quotes (id, request_id, partner_id, type, pyeong, total_amount) VALUES (?,?,?,?,?,?)')
    .run(quoteId, requestId, req.user.sub, type || 'initial', pyeong || request.pyeong || null, total);
  const insertItem = db.prepare('INSERT INTO quote_items (id, quote_id, phase_label, item_name, price) VALUES (?,?,?,?,?)');
  items.forEach(it => insertItem.run(randomUUID(), quoteId, it.phaseLabel || null, it.name, it.price));
  res.json({ success: true, data: { id: quoteId, total } });
});

// 소비자가 본인 견적요청에 대해 받은 견적서 전체(공정별 상세 포함) 조회
app.get('/api/quote-requests/:id/quotes', authRequired, (req, res) => {
  const request = db.prepare('SELECT * FROM quote_requests WHERE id=?').get(req.params.id);
  if (!request) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '견적요청을 찾을 수 없습니다' } });
  if (request.user_id !== req.user.sub) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '본인 견적요청만 조회할 수 있습니다' } });
  const quotes = db.prepare('SELECT * FROM quotes WHERE request_id=? ORDER BY sent_at DESC').all(req.params.id);
  const getItems = db.prepare('SELECT phase_label, item_name, price FROM quote_items WHERE quote_id=?');
  const withItems = quotes.map(q => ({ ...q, items: getItems.all(q.id) }));
  res.json({ success: true, data: withItems });
});

// ===== 4-2. 계약 확정 =====
// 등급별 수수료율(프론트엔드 루머02.html의 window.TIER_FEE와 정확히 동일하게 유지할 것)
const TIER_FEE = { '면허 파트너': 0.015, '인증사업자': 0.025, '부분공사가능업체': 0.03 };

app.post('/api/contracts', authRequired, (req, res) => {
  if (req.user.role !== 'consumer') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '소비자 계정만 계약을 확정할 수 있습니다' } });
  const { quoteId, deposit, down, middle, final } = req.body;
  if (!isNonEmptyString(quoteId, 100)) return validationError(res, '견적서를 선택해주세요');
  for (const [label, v] of [['계약금', deposit], ['선금', down], ['중도금', middle], ['잔금', final]]) {
    if (v !== undefined && !isPositiveAmount(v)) return validationError(res, `${label}은 0 이상의 숫자여야 합니다`);
  }
  const quote = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId);
  if (!quote) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '견적서를 찾을 수 없습니다' } });
  const partner = db.prepare('SELECT * FROM partners WHERE id=?').get(quote.partner_id);
  if (!partner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '업체를 찾을 수 없습니다' } });

  // 결함방지(사용자요청 반영): 확정 시점의 수수료율을 스냅샷으로 고정 저장 — 이후 업체 등급이 바뀌어도
  // 이미 확정된 이 계약의 수수료율은 절대 바뀌지 않아야 함(정산 정합성의 핵심)
  const feeRateSnapshot = TIER_FEE[partner.tier] ?? 0.03;

  const contractId = randomUUID();
  db.prepare(`INSERT INTO contracts (id, quote_id, consumer_id, partner_id, fee_rate_snapshot, deposit_amount, down_amount, middle_amount, final_amount)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(contractId, quoteId, req.user.sub, quote.partner_id, feeRateSnapshot, deposit || 0, down || 0, middle || 0, final || 0);
  // 실시공 인증(cert_completed): 계약이 1건이라도 생기면 자동 활성화
  db.prepare('UPDATE partners SET contracts_count = contracts_count + 1, cert_completed = 1 WHERE id=?').run(quote.partner_id);
  // 신규(팀장 지시 반영 — 로드맵 명시사항): "실서비스는 contract_confirmed시 자동생성" → 계약 확정과 동시에 정산건 자동 생성
  const totalAmount = (deposit || 0) + (down || 0) + (middle || 0) + (final || 0);
  db.prepare('INSERT INTO settlements (id, contract_id, partner_id, amount, fee_rate) VALUES (?,?,?,?,?)')
    .run(randomUUID(), contractId, quote.partner_id, totalAmount, feeRateSnapshot);
  res.json({ success: true, data: { id: contractId, feeRateSnapshot } });
});

app.get('/api/contracts/mine', authRequired, (req, res) => {
  const column = req.user.role === 'partner' ? 'partner_id' : 'consumer_id';
  const list = db.prepare(`SELECT * FROM contracts WHERE ${column}=? ORDER BY confirmed_at DESC`).all(req.user.sub);
  res.json({ success: true, data: list });
});

// ===== 4-3. 정산 =====
// 보안 핵심(프론트엔드 프로토타입에서 실제 발견된 버그 재발 방지):
// partner_id는 오직 인증토큰(req.user.sub)에서만 가져오고, 쿼리 파라미터로는 절대 받지 않는다.
// → 다른 업체 ID를 쿼리에 넣어도 절대 접근 불가(토큰 소유자 본인 것만 조회됨)
app.get('/api/settlements/mine', authRequired, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 조회할 수 있습니다' } });
  const { period } = req.query; // this|last|all — 기간필터는 실제로는 payout_date 기준 WHERE절 추가
  const list = db.prepare('SELECT * FROM settlements WHERE partner_id=? ORDER BY created_at DESC').all(req.user.sub);
  res.json({ success: true, data: list });
});

app.put('/api/settlements/:id/pay-fee', authRequired, (req, res) => {
  const settlement = db.prepare('SELECT * FROM settlements WHERE id=?').get(req.params.id);
  if (!settlement) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '정산건을 찾을 수 없습니다' } });
  // 보안: 본인 정산건인지 반드시 확인(다른 업체 정산을 조작 못 하도록)
  if (settlement.partner_id !== req.user.sub) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '본인 정산건만 처리할 수 있습니다' } });
  db.prepare("UPDATE settlements SET status='fee_paid' WHERE id=?").run(req.params.id);
  res.json({ success: true, data: { message: '수수료 납부 완료 처리됐어요' } });
});


// ===== 6. 분쟁 =====
// 프론트엔드(루머02.html) DISPUTE_TYPES와 판단기준을 그대로 동기화
const DISPUTE_TYPES = {
  defect:  { label: '하자 미처리',    basis: '하자 접수 이력 · 완공 사진 대조 · 업체 SLA(48h)', rec: '업체 SLA 초과 여부 확인 → 초과 시 업체 우선 책임, 이행보증금에서 대체 시공비 차감 검토' },
  payment: { label: '대금·정산 이견', basis: '계약서 대금 분할 · 정산 내역', rec: '계약 기준과 실제 지급 대조 → 차액 발생 시 분할 기준으로 조정' },
  noshow:  { label: '노쇼·잠수',      basis: '실측 일정 로그 · 노쇼 신고 기록', rec: '반복 노쇼(2회+) 시 어뷰징 큐 연계, 대체 업체 배정 또는 계약 해지 검토' },
  quality: { label: '품질 불만',      basis: '완공 AI 검수 · 현장 사진 · 자재 미팅 기록', rec: '검수 기준 미달 항목 확인 → 재시공 또는 부분 환불 협의 권고' }
};

app.post('/api/disputes', authRequired, (req, res) => {
  const { contractId, type, reason } = req.body;
  if (!isNonEmptyString(contractId, 100)) return validationError(res, '계약을 선택해주세요');
  if (!DISPUTE_TYPES[type]) return res.status(400).json({ success: false, error: { code: 'INVALID_TYPE', message: '올바른 분쟁 유형이 아닙니다' } });
  if (reason && !isNonEmptyString(reason, 1000)) return validationError(res, '사유는 1000자 이내여야 합니다');
  const contractExists = db.prepare('SELECT id FROM contracts WHERE id=?').get(contractId);
  if (!contractExists) return validationError(res, '존재하지 않는 계약입니다');
  const id = randomUUID();
  db.prepare('INSERT INTO disputes (id, contract_id, type, filed_by, reason) VALUES (?,?,?,?,?)')
    .run(id, contractId, type, req.user.role, reason || null);
  res.json({ success: true, data: { id, status: 'filed' } });
});

// ⚡MVP-SWITCH: 실서버 → AI 판정은 서버 LLM(Claude API) 호출 결과 사용. 지금은 유형별 템플릿 기반 시뮬레이션
app.post('/api/disputes/:id/ai-judge', authRequired, (req, res) => {
  const dispute = db.prepare('SELECT * FROM disputes WHERE id=?').get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '분쟁을 찾을 수 없습니다' } });
  const t = DISPUTE_TYPES[dispute.type];
  const verdict = { typeLabel: t.label, basis: t.basis, recommendation: t.rec };
  db.prepare("UPDATE disputes SET ai_verdict=?, status='ai_judged' WHERE id=?").run(JSON.stringify(verdict), req.params.id);
  res.json({ success: true, data: verdict });
});

app.put('/api/disputes/:id/resolve', adminAuthRequired(), (req, res) => {
  // 결함수정(팀장 지시 반영): "실서비스는 관리자 권한 확인 미들웨어 필요"라고 남겨뒀던 주석 처리 완료
  const { decision, settlementAdjustment } = req.body;
  const dispute = db.prepare('SELECT * FROM disputes WHERE id=?').get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '분쟁을 찾을 수 없습니다' } });
  const tx = db.transaction(() => {
    db.prepare("UPDATE disputes SET status='resolved', resolution=?, settlement_adjustment=?, resolved_at=datetime('now') WHERE id=?")
      .run(decision, settlementAdjustment || null, req.params.id);
    if (settlementAdjustment) {
      const settlement = db.prepare('SELECT * FROM settlements WHERE contract_id=?').get(dispute.contract_id);
      if (settlement) {
        db.prepare("UPDATE settlements SET status='hold', hold_reason=? WHERE id=?").run('분쟁 조정 반영: ' + decision, settlement.id);
      }
    }
  });
  tx();
  res.json({ success: true, data: { message: '조정 완료됐어요' } });
});

// ===== 6-1. 하자보수 =====
app.post('/api/defects', authRequired, (req, res) => {
  const { contractId, photos, description } = req.body;
  if (!isNonEmptyString(contractId, 100)) return validationError(res, '계약을 선택해주세요');
  if (!Array.isArray(photos) || photos.length === 0) {
    return res.status(400).json({ success: false, error: { code: 'PHOTO_REQUIRED', message: '사진을 1장 이상 첨부해야 접수할 수 있습니다' } });
  }
  if (photos.length > 10) return validationError(res, '사진은 최대 10장까지 첨부할 수 있습니다');
  if (description && !isNonEmptyString(description, 1000)) return validationError(res, '설명은 1000자 이내여야 합니다');
  const contractExists = db.prepare('SELECT id FROM contracts WHERE id=?').get(contractId);
  if (!contractExists) return validationError(res, '존재하지 않는 계약입니다');
  // ⚡MVP-SWITCH: 실서버는 AI가 사진+설명 기반으로 긴급도 자동분류. 지금은 사진 장수 기준 결정적 mock
  const urgency = photos.length >= 3 ? '24h' : photos.length === 2 ? '72h' : '168h';
  const id = randomUUID();
  db.prepare('INSERT INTO defects (id, contract_id, photos, description, urgency) VALUES (?,?,?,?,?)')
    .run(id, contractId, JSON.stringify(photos), description || null, urgency);
  res.json({ success: true, data: { id, urgency } });
});

app.get('/api/defects/mine', authRequired, (req, res) => {
  const column = req.user.role === 'partner' ? 'c.partner_id' : 'c.consumer_id';
  const list = db.prepare(`
    SELECT d.* FROM defects d JOIN contracts c ON d.contract_id = c.id
    WHERE ${column} = ? ORDER BY d.created_at DESC
  `).all(req.user.sub);
  res.json({ success: true, data: list });
});

// ===== 7. AI 공사감리 =====
// 요금제(루머02.html INSPECT_PLANS와 동일하게 유지)
const INSPECT_PLANS = {
  basic:   { label: 'BASIC · AI 빠른 확인', price: 9900 },
  premium: { label: 'PREMIUM · 전문가 사진감리', price: 39000 },
  full:    { label: 'FULL · 전문가 정밀감리(총 2회)', price: 79000 }
};
// 등급별 판정 템플릿(루머02.html INSPECT_VERDICTS와 동일하게 유지)
const INSPECT_VERDICTS = {
  '양호': { score: 92, opinion: '전반적으로 시공 품질이 양호합니다. 타일 수평·도배 이음새가 기준을 충족합니다.', advice: '현재 상태로 다음 공정을 진행해도 좋습니다.' },
  '주의': { score: 76, opinion: '대체로 양호하나 일부 마감에서 편차가 보입니다. 욕실 코킹 두께 불균일이 의심됩니다.', advice: '해당 부분 재점검을 업체에 요청하고, 사진을 추가로 받아 확인하는 것을 권장합니다.' },
  '문제': { score: 58, opinion: '주요 공정에서 기준 미달이 감지됩니다. 타일 줄눈 간격 불균일·방수 처리 미흡 가능성이 있습니다.', advice: '다음 공정 진행 전 재시공을 요청하고, 이 보고서를 하자보수 접수 근거로 보관하세요.' }
};

app.post('/api/inspections', authRequired, (req, res) => {
  const { contractId, plan } = req.body;
  if (!INSPECT_PLANS[plan]) return res.status(400).json({ success: false, error: { code: 'INVALID_PLAN', message: '올바른 요금제가 아닙니다' } });
  const id = randomUUID();
  db.prepare('INSERT INTO inspections (id, contract_id, plan) VALUES (?,?,?)').run(id, contractId, plan);
  res.json({ success: true, data: { id, plan, price: INSPECT_PLANS[plan].price, status: 'unpaid' } });
});

// 결제 성공 콜백에서만 보고서 생성(되돌리기 잠금 — 미결제 상태에서는 절대 보고서 안 나옴)
// ⚡MVP-SWITCH: 실서버 → 실제 PG 결제 API 호출 후 성공 콜백에서 아래 로직 실행
app.post('/api/inspections/:id/pay', authRequired, (req, res) => {
  const { method } = req.body;
  const inspection = db.prepare('SELECT * FROM inspections WHERE id=?').get(req.params.id);
  if (!inspection) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '신청 내역을 찾을 수 없습니다' } });
  if (inspection.status === 'reported') return res.status(400).json({ success: false, error: { code: 'ALREADY_PAID', message: '이미 결제·보고서 생성이 완료됐습니다' } });

  // ⚡MVP-SWITCH: 실서버 → 업로드된 공정 사진을 Claude Vision에 전달해 실제 판정. 지금은 결정적 mock
  const grades = Object.keys(INSPECT_VERDICTS);
  const grade = grades[Math.floor(Math.random() * grades.length)];
  const verdict = INSPECT_VERDICTS[grade];
  const report = JSON.stringify({ grade, score: verdict.score, opinion: verdict.opinion, advice: verdict.advice });

  db.prepare("UPDATE inspections SET status='reported', grade=?, score=?, report=?, paid_at=datetime('now') WHERE id=?")
    .run(grade, verdict.score, report, req.params.id);
  res.json({ success: true, data: { grade, score: verdict.score, opinion: verdict.opinion, advice: verdict.advice } });
});

app.get('/api/inspections/mine', authRequired, (req, res) => {
  const list = db.prepare(`
    SELECT i.* FROM inspections i JOIN contracts c ON i.contract_id = c.id
    WHERE c.consumer_id = ? ORDER BY i.applied_at DESC
  `).all(req.user.sub);
  res.json({ success: true, data: list });
});

// ===== 8. 채팅방·실측일정 =====
app.post('/api/rooms', authRequired, (req, res) => {
  const { partnerId } = req.body;
  let room = db.prepare('SELECT * FROM chat_rooms WHERE consumer_id=? AND partner_id=?').get(req.user.sub, partnerId);
  if (!room) {
    const id = randomUUID();
    db.prepare('INSERT INTO chat_rooms (id, consumer_id, partner_id) VALUES (?,?,?)').run(id, req.user.sub, partnerId);
    db.prepare('INSERT INTO meas_jobs (room_id) VALUES (?)').run(id);
    room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(id);
  }
  res.json({ success: true, data: room });
});

// ===== 8-1. 채팅 메시지(소비자↔업체 실시간 메신저) =====
// 방 접근권한 확인 헬퍼: 본인이 속한 방인지(소비자 본인 또는 업체 본인) 검증
function assertRoomAccess(room, user) {
  if (!room) return false;
  if (user.role === 'consumer') return room.consumer_id === user.sub;
  if (user.role === 'partner') return room.partner_id === user.sub;
  return false;
}

// 본인(소비자 또는 업체)이 속한 채팅방 목록(최근 생성순)
// 본인(소비자 또는 업체)이 속한 채팅방 목록(최근 생성순) — 상대방 이름·마지막메시지 포함
// 결함수정(사용자 실제 발견): 이전엔 방 ID만 줘서, 프론트가 이름/최근메시지를 표시할 방법이 없어
// 화면(메신저 목록)이 실제 서버 데이터에 연결이 안 되고 고정 데모데이터만 보여주던 문제
app.get('/api/rooms/mine', authRequired, (req, res) => {
  const column = req.user.role === 'partner' ? 'partner_id' : 'consumer_id';
  const rooms = db.prepare(`SELECT * FROM chat_rooms WHERE ${column}=? ORDER BY created_at DESC`).all(req.user.sub);
  const getLastMsg = db.prepare('SELECT text, msg_type, created_at FROM chat_messages WHERE room_id=? ORDER BY seq DESC LIMIT 1');
  const enriched = rooms.map(room => {
    let displayName;
    if (req.user.role === 'partner') {
      const consumer = db.prepare('SELECT nickname FROM users WHERE id=?').get(room.consumer_id);
      displayName = (consumer && consumer.nickname) || '회원';
    } else {
      const partner = db.prepare('SELECT business_name FROM partners WHERE id=?').get(room.partner_id);
      displayName = (partner && partner.business_name) || '업체';
    }
    const lastMsg = getLastMsg.get(room.id);
    // 신규(사용자요청 — 견적요청 알림): 목록에서 견적요청 메시지는 사람이 읽기 좋은 요약문구로 표시
    let lastMessagePreview = lastMsg ? lastMsg.text : '';
    if (lastMsg && lastMsg.msg_type === 'quote_request') {
      try { const q = JSON.parse(lastMsg.text); lastMessagePreview = '📋 견적요청 · ' + q.address + ' · ' + q.pyeong + '평'; } catch (e) {}
    }
    return {
      id: room.id,
      displayName,
      lastMessage: lastMessagePreview,
      lastMessageType: lastMsg ? lastMsg.msg_type : 'text',
      lastTime: lastMsg ? lastMsg.created_at : room.created_at
    };
  });
  res.json({ success: true, data: enriched });
});

app.post('/api/rooms/:roomId/messages', authRequired, (req, res) => {
  const { text } = req.body;
  if (!isNonEmptyString(text, 1000)) return validationError(res, '메시지 내용은 1~1000자여야 합니다');
  const room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(req.params.roomId);
  if (!assertRoomAccess(room, req.user)) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '본인이 속한 채팅방이 아닙니다' } });
  const id = randomUUID();
  db.prepare('INSERT INTO chat_messages (id, room_id, sender_role, sender_id, text) VALUES (?,?,?,?,?)')
    .run(id, req.params.roomId, req.user.role, req.user.sub, text);
  const saved = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(id);
  res.json({ success: true, data: saved });
});

// 폴링용 조회: since 파라미터(마지막으로 받은 메시지 시각) 이후의 새 메시지만 반환
app.get('/api/rooms/:roomId/messages', authRequired, (req, res) => {
  const room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(req.params.roomId);
  if (!assertRoomAccess(room, req.user)) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '본인이 속한 채팅방이 아닙니다' } });
  // 결함수정(실제 재현·발견된 버그): since를 시간(문자열)으로 비교하면, 같은 초(1초 이내)에 여러 메시지가
  // 오갈 경우 SQLite 시간정밀도(초 단위) 한계로 새 메시지를 놓치는 문제가 있었음
  // → 시간 대신 자동증가 순번(seq)으로 비교해서 정확히 그 이후 메시지만 가져오도록 근본수정
  const { sinceSeq } = req.query;
  const rows = sinceSeq
    ? db.prepare('SELECT * FROM chat_messages WHERE room_id=? AND seq > ? ORDER BY seq ASC').all(req.params.roomId, Number(sinceSeq))
    : db.prepare('SELECT * FROM chat_messages WHERE room_id=? ORDER BY seq ASC').all(req.params.roomId);
  res.json({ success: true, data: rows });
});

// 프론트엔드(루머02.html) saveMeasJob()/loadMeasJob() 어댑터와 1:1 대응 — 상태 객체 통째로 저장/조회
app.get('/api/meas-jobs/:roomId', authRequired, (req, res) => {
  const job = db.prepare('SELECT * FROM meas_jobs WHERE room_id=?').get(req.params.roomId);
  if (!job) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '실측 정보를 찾을 수 없습니다' } });
  res.json({ success: true, data: { status: job.status, slots: JSON.parse(job.slots), chosenSlotId: job.chosen_slot_id, rescheduleCount: job.reschedule_count, noshow: JSON.parse(job.noshow_log) } });
});

app.put('/api/meas-jobs/:roomId', authRequired, (req, res) => {
  const { status, slots, chosenSlotId, rescheduleCount, noshow } = req.body;
  const result = db.prepare(`UPDATE meas_jobs SET status=?, slots=?, chosen_slot_id=?, reschedule_count=?, noshow_log=?, updated_at=datetime('now') WHERE room_id=?`)
    .run(status, JSON.stringify(slots || []), chosenSlotId || null, rescheduleCount || 0, JSON.stringify(noshow || []), req.params.roomId);
  if (result.changes === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '실측 정보를 찾을 수 없습니다' } });
  res.json({ success: true, data: { message: '저장됐어요' } });
});

// 업체가 실측 가능일정 제안
app.post('/api/meas-jobs/:roomId/slots', authRequired, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 일정을 제안할 수 있습니다' } });
  const { slots } = req.body;
  if (!Array.isArray(slots) || slots.length === 0) return validationError(res, '일정을 1개 이상 제안해주세요');
  if (slots.length > 10) return validationError(res, '일정은 최대 10개까지 제안할 수 있습니다');
  if (!slots.every(s => isNonEmptyString(s.id, 50) && isNonEmptyString(s.date, 30) && isNonEmptyString(s.time, 20))) {
    return validationError(res, '각 일정에는 id, date, time이 필요합니다');
  }
  const job = db.prepare('SELECT room_id FROM meas_jobs WHERE room_id=?').get(req.params.roomId);
  if (!job) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '채팅방을 찾을 수 없습니다' } });
  db.prepare(`UPDATE meas_jobs SET status='slots_proposed', slots=?, chosen_slot_id=NULL, updated_at=datetime('now') WHERE room_id=?`)
    .run(JSON.stringify(slots), req.params.roomId);
  res.json({ success: true, data: { message: '일정이 제안됐어요' } });
});

// 소비자가 일정 중 하나 선택
app.post('/api/meas-jobs/:roomId/select', authRequired, (req, res) => {
  if (req.user.role !== 'consumer') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '소비자 계정만 선택할 수 있습니다' } });
  const { slotId } = req.body;
  if (!isNonEmptyString(slotId, 50)) return validationError(res, '일정을 선택해주세요');
  const job = db.prepare('SELECT * FROM meas_jobs WHERE room_id=?').get(req.params.roomId);
  if (!job) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '채팅방을 찾을 수 없습니다' } });
  const validSlot = JSON.parse(job.slots).some(s => s.id === slotId);
  if (!validSlot) return validationError(res, '제안된 일정 중에서만 선택할 수 있습니다');
  db.prepare(`UPDATE meas_jobs SET status='confirmed', chosen_slot_id=?, updated_at=datetime('now') WHERE room_id=?`)
    .run(slotId, req.params.roomId);
  res.json({ success: true, data: { message: '실측 일정이 확정됐어요' } });
});

// 노쇼 신고(반복시 어뷰징 큐 연계 — 프론트엔드 로직과 동일하게 기록만, 실제 어뷰징 판정은 관리자 큐에서)
app.post('/api/meas-jobs/:roomId/noshow', authRequired, (req, res) => {
  const job = db.prepare('SELECT * FROM meas_jobs WHERE room_id=?').get(req.params.roomId);
  if (!job) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '실측 정보를 찾을 수 없습니다' } });
  const noshowLog = JSON.parse(job.noshow_log);
  noshowLog.push({ reportedBy: req.user.role, at: new Date().toISOString() });
  db.prepare(`UPDATE meas_jobs SET noshow_log=?, status='none', chosen_slot_id=NULL, updated_at=datetime('now') WHERE room_id=?`)
    .run(JSON.stringify(noshowLog), req.params.roomId);
  res.json({ success: true, data: { noshowCount: noshowLog.length, needsAbuseReview: noshowLog.length >= 2 } });
});

// ===== 5. 광고(Ad Slots) — AI 1차 검수 + 구매 즉시 자동노출(5단계: 사용자요청) =====
const AD_BANNED_WORDS = ['100%', '최고', '1위', '완벽', '무조건'];
// 신규(사용자요청 — 5단계: 지역광고 자동노출): 슬롯종류별 가격표(서버가 신뢰 소스 — 클라이언트가 보낸 가격은 사용하지 않음)
// 프론트(window.AD_PRICING)와 반드시 동일한 값으로 유지할 것
const AD_PRICING = {
  hero: { periodDays: 7, price: 99000 },
  'hero-sub': { periodDays: 7, price: 29000 },
  'region-top': { periodDays: 30, price: 200000 }
};
// 신규(사용자요청 — 5단계): 슬롯종류별 "지역당" 최대 동시노출 개수(자리 품절 방지)
const AD_CAPACITY_PER_REGION = { hero: 1, 'hero-sub': 2, 'region-top': 1 };

app.post('/api/ads', authRequired, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 광고를 등록할 수 있습니다' } });
  const { slotType, region, tagline } = req.body;
  if (!isNonEmptyString(slotType, 30) || !AD_PRICING[slotType]) return validationError(res, '올바른 광고 슬롯 유형을 선택해주세요');
  if (!isNonEmptyString(region, 50)) return validationError(res, '노출 지역을 선택해주세요');
  if (!isNonEmptyString(tagline, 100)) return validationError(res, '광고 문구를 입력해주세요(100자 이내)');

  const pricing = AD_PRICING[slotType];
  const hit = AD_BANNED_WORDS.filter(w => tagline.includes(w));
  const aiPrecheckResult = hit.length ? 'flagged' : 'pass';
  const id = randomUUID();

  try {
    const tx = db.transaction(() => {
      // 1) 지역별 정원 확인 — 이미 이 지역+슬롯종류에 활성 광고가 꽉 찼으면 차단
      const activeCount = db.prepare("SELECT COUNT(*) as c FROM ad_slots WHERE slot_type=? AND region=? AND status='active'").get(slotType, region).c;
      const capacity = AD_CAPACITY_PER_REGION[slotType] || 1;
      if (activeCount >= capacity) {
        throw Object.assign(new Error('이 지역은 광고 자리가 모두 찼어요. 다른 지역을 선택하거나 대기 등록해주세요.'), { code: 'CAPACITY_FULL' });
      }
      // 2) 크레딧 잔액 확인
      const partner = db.prepare('SELECT credit_balance FROM partners WHERE id=?').get(req.user.sub);
      if (!partner) throw Object.assign(new Error('업체를 찾을 수 없습니다'), { code: 'NOT_FOUND' });
      if (partner.credit_balance < pricing.price) {
        throw Object.assign(new Error('보유 크레딧이 부족합니다. 충전 후 다시 시도해주세요.'), { code: 'INSUFFICIENT_BALANCE' });
      }
      // 3) 크레딧 차감 + 원장 기록
      db.prepare('UPDATE partners SET credit_balance = credit_balance - ? WHERE id=?').run(pricing.price, req.user.sub);
      db.prepare('INSERT INTO credit_ledger (id, partner_id, type, amount, related_ad_id) VALUES (?,?,?,?,?)')
        .run(randomUUID(), req.user.sub, 'ad_purchase', -pricing.price, id);
      // 4) 광고 슬롯 생성 — 금칙어 없으면 즉시 active(자동노출), 금칙어 있으면 관리자 확인 대기(pending)
      //    (크레딧은 어느 경우든 이미 차감됨 — 반려시 별도 환불 처리는 관리자 반려 API에서 수행)
      const status = hit.length ? 'pending' : 'active';
      const startDate = new Date().toISOString().slice(0, 10);
      const endDate = new Date(Date.now() + pricing.periodDays * 86400000).toISOString().slice(0, 10);
      db.prepare(`INSERT INTO ad_slots (id, partner_id, slot_type, region, tagline, status, cost_type, cost_value, spent_credits, start_date, end_date, ai_precheck_result)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, req.user.sub, slotType, region, tagline, status, 'period', pricing.periodDays, pricing.price, startDate, endDate, aiPrecheckResult);
    });
    tx();
  } catch (e) {
    const code = e.code || 'AD_PURCHASE_FAILED';
    const status = code === 'NOT_FOUND' ? 404 : (code === 'INSUFFICIENT_BALANCE' || code === 'CAPACITY_FULL') ? 400 : 500;
    return res.status(status).json({ success: false, error: { code, message: e.message } });
  }

  res.json({ success: true, data: {
    id, price: pricing.price, periodDays: pricing.periodDays,
    autoActivated: !hit.length, aiPrecheckResult, flaggedWords: hit,
    message: hit.length ? '광고 문구에 확인이 필요한 표현이 있어 관리자 검토 후 노출됩니다.' : '결제가 완료되어 즉시 노출이 시작됐어요.'
  } });
});

app.get('/api/ads/active', (req, res) => {
  const { slotType } = req.query;
  const list = db.prepare("SELECT * FROM ad_slots WHERE status='active' AND slot_type=?").all(slotType);
  res.json({ success: true, data: list });
});

app.patch('/api/admin/ads/:id/approve', adminAuthRequired(), (req, res) => {
  const result = db.prepare("UPDATE ad_slots SET status='active' WHERE id=?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '해당 광고를 찾을 수 없습니다' } });
  res.json({ success: true, data: { message: '승인되었습니다' } });
});

app.patch('/api/admin/ads/:id/reject', adminAuthRequired(), (req, res) => {
  const { reason } = req.body;
  const result = db.prepare("UPDATE ad_slots SET status='rejected', reject_reason=? WHERE id=?").run(reason || '관리자 검토 후 반려', req.params.id);
  if (result.changes === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '해당 광고를 찾을 수 없습니다' } });
  res.json({ success: true, data: { message: '반려되었습니다' } });
});

// ===== 신규(사용자요청 — 루머칼럼 Notion 연동) =====
// 운영자가 Notion 데이터베이스에 글을 쓰면, 이 서버가 주기적으로(또는 수동 트리거로) 가져와서
// columns 테이블에 동기화한다. NOTION_API_KEY/NOTION_DATABASE_ID 환경변수가 없으면 폴백(기본 3개 글)만 사용.
// 실서비스 확장 시: 이 폴링 방식 대신 Notion 웹훅으로 실시간 동기화 권장.
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || '';

// 폴백(기본) 칼럼 3개 — Notion 미연동 상태에서도 화면이 비어보이지 않도록 서버 최초 기동시 1회 시딩
function seedDefaultColumnsIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as c FROM columns').get().c;
  if (count > 0) return;
  // 신규(사용자요청 — 실제 웹 기사 기반 칼럼): 아래 3개는 실제 인테리어 매체 기사를 조사해
  // 저작권 규정에 맞게 직접 인용 없이 자체적으로 재구성한 요약이며, 각 기사의 실제 원문 링크(source_url)를
  // 함께 제공해 사용자가 원문을 계속 읽을 수 있도록 합니다.
  const defaults = [
    {
      id: randomUUID(), tag: '욕실 인테리어', title: '2026년 욕실 트렌드, 대형 타일이 대세인 이유',
      summary: '줄눈을 줄이는 대형 타일 시공이 욕실을 넓어 보이게 하는 핵심 트렌드로 떠오르고 있습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-20',
      source_name: '오늘의집 라이프스타일 매거진', source_url: 'https://ohou.se/advices/12252',
      body: '최근 인테리어 시공 사례들을 살펴보면 욕실과 거실 벽에서 공통적으로 눈에 띄는 변화가 있습니다. 바로 대형 타일의 확산입니다.\n\n작은 타일을 촘촘히 붙이던 기존 방식과 달리, 600×600mm 이상의 대형 포세린 타일을 쓰면 줄눈 개수가 크게 줄어듭니다. 그 결과 벽면과 바닥이 훨씬 매끈하고 넓어 보이는 효과를 얻을 수 있어, 좁은 욕실을 고민하는 세대에서 특히 선호도가 높습니다.\n\n조명 설계도 함께 달라지고 있습니다. 예전에는 욕실 전체를 하나의 조명으로 균일하게 밝히는 방식이 일반적이었다면, 최근에는 세면대·샤워부스 등 구역마다 조도를 다르게 설계해 공간에 입체감을 주는 방식이 늘고 있습니다. 밝은 영역과 은은한 영역이 공존하면 실제 면적보다 더 넓게 느껴지는 효과가 있습니다.\n\n타일 색상은 화이트·아이보리 같은 밝은 톤이 여전히 강세지만, 최근에는 호텔 욕실처럼 고급스러운 무드를 내기 위해 마감재의 질감(무광·유광)을 다르게 조합하는 경우도 늘고 있습니다.\n\n실제 시공 시에는 타일 크기가 커질수록 평탄 작업의 중요성도 함께 커지므로, 바닥 미장 상태를 꼼꼼히 확인해줄 수 있는 시공 경험이 풍부한 업체를 선택하는 것이 중요합니다.'
    },
    {
      id: randomUUID(), tag: '주방 트렌드', title: '2026년 주방 인테리어, 대면형과 엔지니어드 스톤이 이끈다',
      summary: '요리하며 가족과 소통할 수 있는 대면형 주방과, 고급스러운 질감의 엔지니어드 스톤 상판이 올해 주방 트렌드를 이끌고 있습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-18',
      source_name: '오늘의집 라이프스타일 매거진', source_url: 'https://ohou.se/advices/12252',
      body: '2026년 주방 인테리어에서 가장 두드러지는 흐름은 대면형(아일랜드·ㄷ자 개방형) 주방의 확산입니다. 조리대가 거실을 바라보는 구조라 요리를 하면서도 가족이나 손님과 자연스럽게 대화를 나눌 수 있고, 거실과 주방의 경계가 흐려지면서 공간 전체가 넓어 보이는 효과도 있습니다.\n\n다만 대면형 구조를 무리 없이 적용하려면 어느 정도 면적이 확보되어야 합니다. 협소한 주방이라면 기존 배치를 유지하되 아일랜드 느낌을 낼 수 있는 소형 테이블을 절충안으로 고려하는 경우가 많습니다.\n\n상판 소재로는 엔지니어드 스톤(쿼츠 스톤)이 올해 1순위로 꼽힙니다. 내구성이 좋고 관리가 편하면서도 자연석과 유사한 고급스러운 질감을 낼 수 있기 때문입니다. 최근에는 인공적인 느낌보다 자연스러운 무늬를 살린 제품이 특히 인기입니다.\n\n가전 배치도 인테리어 설계 초반부터 함께 고려하는 추세입니다. 빌트인 냉장고·인덕션·식기세척기 등의 위치를 먼저 정한 뒤 전기 설비와 수납 구조를 맞추는 순서로 진행하면, 시공 중간에 위치를 바꾸는 시행착오를 줄일 수 있습니다.'
    },
    {
      id: randomUUID(), tag: '견적 가이드', title: '인테리어 견적서, 이 항목들을 꼭 확인하세요',
      summary: '항목별 세부내역, 자재 등급 명시, A/S 보증기간까지 — 견적서에서 분쟁을 예방하는 핵심 체크포인트를 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-15',
      source_name: 'LifeBase 인테리어 가이드', source_url: 'https://lifebase.kr/blog/0429-interior-estimate-checklist/',
      body: '인테리어 견적서는 보통 철거·목공·전기·도배·장판·타일·가구·조명 등의 항목으로 구성됩니다. 각 항목이 "공사 내용 - 수량 - 단가 - 총액"으로 세분화되어 있는지, 세부 내역의 합이 전체 소계와 정확히 일치하는지부터 확인하는 것이 견적서 검토의 출발점입니다.\n\n특히 "전체 리모델링 일체 2,000만원"처럼 여러 공정을 하나로 뭉뚱그린 이른바 "일식" 항목은 주의가 필요합니다. 나중에 어떤 항목이 빠졌는지, 왜 추가 비용이 발생했는지 설명하기 어려워지는 경우가 많기 때문입니다. 철거비·폐기물 처리비·인건비를 개별 항목으로 나눠 요청하는 것이 안전합니다.\n\n자재 등급 표기도 중요한 포인트입니다. "마루 시공"처럼 뭉뚱그려진 표현보다 브랜드·모델명·규격까지 구체적으로 적혀 있어야, 시공 중 더 저렴한 자재로 바뀌는 것을 예방할 수 있습니다.\n\nA/S(하자보수) 보증기간도 반드시 계약서에 명시해야 합니다. 공정별로 보증기간이 다른 경우가 많은데, 일반적으로 도배·도장·타일 등은 1년, 급배수나 설비 공사는 2년 이상으로 정하는 경우가 흔합니다. 보증 범위(시공 불량, 자재 하자, 누수 등)까지 구체적으로 남겨두면 이후 분쟁 소지를 크게 줄일 수 있습니다.\n\n계약금 비율도 확인해야 할 항목입니다. 계약금을 지나치게 높게 요구하는 업체는 주의가 필요하며, 착수금·중도금·잔금으로 나누어 지급하는 구조가 일반적으로 더 안전합니다.'
    },
    {
      id: randomUUID(), tag: '거실 인테리어', title: '2026년 거실 트렌드, 워밍 뉴트럴과 곡선 디자인',
      summary: '차가운 미니멀에서 따뜻한 절제미로 — 올해 거실 인테리어를 이끄는 4가지 키워드를 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-25',
      source_name: '오늘의집 라이프스타일 매거진', source_url: 'https://ohou.se/advices/12448',
      body: '2026년 거실 인테리어는 이전의 차갑던 미니멀 스타일에서, 한층 따뜻하고 절제된 분위기로 흐름이 바뀌고 있습니다. 한국·유럽·일본의 인테리어 매거진들이 공통적으로 짚는 키워드는 워밍 뉴트럴, 곡선 디자인, 존 디바이드(공간 분리), 플랜테리어 네 가지입니다.\n\n컬러는 베이지를 기본 바탕으로 하고, 테라코타나 세이지그린 같은 어스톤을 포인트로 더하는 조합이 강세입니다. 자재 면에서는 헤링본 패턴 마루나 마이크로 시멘트 마감이 인기를 얻고 있습니다.\n\n조명도 예전처럼 천장등 하나에 의존하기보다, 메인 조명·간접 조명·무드 조명을 함께 활용해 시간대별로 다른 분위기를 연출하는 방식이 트렌드로 자리잡고 있습니다.\n\n다만 평수가 좁은 거실이라면 이 모든 요소를 한 번에 적용하기보다, 러그·소파 등 가구로 먼저 분위기를 잡아보고 마음에 들면 마루나 벽 마감 같은 자재 시공으로 확장하는 단계적 접근이 안전합니다.'
    },
    {
      id: randomUUID(), tag: '컬러 가이드', title: '2026년 인테리어 컬러, 어스톤이 답이다',
      summary: '베이지·테라코타·올리브그린 — 공간을 압도하지 않으면서 개성을 살리는 2026년 컬러 배합법을 소개합니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-24',
      source_name: 'LifeBase 인테리어 가이드', source_url: 'https://lifebase.kr/blog/0184-interior-color-trends-2026/',
      body: '2026년 인테리어 컬러 트렌드는 채도가 살아있는 어스톤과 딥톤이 중심입니다. 웜그레이나 베이지를 기본 배경으로 삼고, 테라코타나 올리브그린 같은 어스톤을 포인트로 더하면 안정적이면서도 개성 있는 공간을 만들 수 있습니다.\n\n색상 배합에는 흔히 70:20:10 법칙이 활용됩니다. 베이스 컬러를 70%, 서브 컬러를 20%, 포인트 컬러를 10% 정도로 배분하면 과하지 않으면서도 시각적으로 안정된 균형을 만들 수 있습니다.\n\n거실처럼 가족이 함께 시간을 보내는 공간에는 편안함을 주는 색상이 적합합니다. 벽면은 웜그레이나 베이지로, 소파나 러그에는 테라코타·카라멜 같은 따뜻한 색을 포인트로 주면 아늑한 분위기를 연출할 수 있습니다.\n\n한 가지 색을 공간 전체에 과하게 적용하기보다, 벽·가구·소품 등 서로 다른 요소에 나눠 배치하는 것이 실패 확률을 줄이는 방법입니다.'
    },
    {
      id: randomUUID(), tag: '조명 팁', title: '침실 조명, 밝기보다 색온도가 중요한 이유',
      summary: '숙면을 돕는 침실 조명의 핵심은 밝기가 아니라 따뜻한 색온도입니다. 공간별 조명 선택 요령을 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-23',
      source_name: 'LifeBase 인테리어 가이드', source_url: 'https://lifebase.kr/blog/0455-interior-jomyeong-gongganbbyeol-jomyeong-seontaeggwa-baechi-yoryeong/',
      body: '침실 조명을 고를 때 가장 흔히 하는 실수는 밝기만 신경 쓰는 것입니다. 실제로 숙면에 더 큰 영향을 주는 요소는 색온도입니다. 천장 조명은 3000K 이하의 따뜻한 색온도를 선택하고, 밝기를 조절할 수 있는 디밍 기능을 함께 갖추는 것이 좋습니다.\n\n침대 양옆에는 독서용 스탠드나 벽등을 따로 두는 것을 추천합니다. 천장 조명 하나에만 의존하면 책을 읽거나 취침 준비를 할 때 불편할 수 있습니다.\n\n조명은 시선에 직접 닿지 않도록 간접적으로 배치하는 것이 원칙입니다. 빛이 눈에 바로 들어오면 오히려 수면을 방해할 수 있기 때문입니다. 드레스룸이나 화장대가 있다면 거울 주변에 자연광에 가까운 색온도(약 5000K)의 조명을 배치하면 도움이 됩니다.\n\n같은 공간 안에서 색온도가 제각각이면 어수선해 보이므로, 거실·주방·침실의 색온도를 비슷하게 맞추거나 공간별로 명확히 구분하는 것이 좋습니다.'
    },
    {
      id: randomUUID(), tag: '수납 팁', title: '침실이 좁아 보인다면? 수납부터 다시 보세요',
      summary: '큰 공사 없이도 침실을 넓어 보이게 만드는 수납 정리 아이디어를 단계별로 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-22',
      source_name: '셀프 인테리어 기초', source_url: 'https://quax-interior.com/increase-bedroom-storage/',
      body: '침실이 좁아 보이는 이유는 실제 면적보다, 물건이 쌓여 어수선해 보이는 경우가 더 많습니다. 셀프 인테리어로 수납을 개선하기 전에는, 먼저 침실에서 무엇이 가장 많이 쌓이는지부터 파악하는 것이 순서입니다.\n\n옷이 많다면 옷걸이 수납이 부족한 경우가 많고, 침구나 계절 용품이 많다면 침대 아래 공간을 활용하는 편이 효율적입니다. 책이나 잡화가 많다면 벽면 선반이나 서랍형 수납이 더 잘 맞습니다.\n\n한 번에 침실 전체를 바꾸기보다, 가장 불편한 지점 하나부터 개선하는 방식이 예산도 아끼고 실패 확률도 낮출 수 있습니다. 보기 좋은 배치보다 꺼내기 쉽고 다시 넣기 쉬운 구조를 우선하는 것이 실사용 측면에서 훨씬 만족도가 높습니다.\n\n다만 수납 가구를 늘릴 때는 통로나 문이 열리는 공간이 좁아지지 않는지 미리 확인해야, 오히려 사용성이 떨어지는 상황을 피할 수 있습니다.'
    },
    {
      id: randomUUID(), tag: '하자보수 가이드', title: '인테리어 완공 후, 이 부분은 꼭 체크하세요',
      summary: '공정별로 하자가 잘 생기는 지점을 정리했습니다. 완공 직후 이 체크리스트로 집중 점검해보세요.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-21',
      source_name: '오늘의집 라이프스타일 매거진', source_url: 'https://ohou.se/advices/2327',
      body: '인테리어 공사가 끝난 직후에는, 공정별로 하자가 잘 생기는 곳을 정리해둔 체크리스트를 기준으로 하나씩 확인하는 것이 안전합니다. 특히 배관이나 설비를 이동한 경우라면 더욱 꼼꼼한 점검이 필요합니다.\n\n대면형 주방처럼 수도관·배관을 이동했다면, 설비 후 물을 30분에서 1시간 정도 틀어놓고 녹물이 나오지는 않는지, 물이 잘 나오는지 확인해야 합니다. 그다음엔 배수도 함께 확인해야 하는데, 싱크대 이동으로 배관이 길어지면 기울기가 완만해져 물빠짐이 잘 안 되는 하자가 생기기 쉽기 때문입니다.\n\n새시나 문짝은 가장 먼저 여닫힘 상태를 확인하는 것이 좋습니다. 틀어진 곳 없이 수평·수직이 잘 맞는지도 함께 점검해야 합니다.\n\n공정이 끝날 때마다 그 부분을 바로바로 점검하는 습관을 들이면, 나중에 문제가 누적되어 원인을 찾기 어려워지는 상황을 예방할 수 있습니다.'
    },
    {
      id: randomUUID(), tag: '계약 체크리스트', title: '인테리어 계약 전, 후회 없는 체크리스트',
      summary: '견적 내역부터 자재 등급, 하자보수 조항까지 — 계약 전 반드시 확인해야 할 항목을 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-19',
      source_name: '인테리어 가이드', source_url: 'https://interiorguide.co.kr/267/',
      body: '인테리어 공사 계약을 서두르면 예산 초과, 하자 발생, 책임 소재 불분명 같은 문제로 이어지기 쉽습니다. 실제로 소비자원에 접수되는 민원 중 상당수가 인테리어 관련 분쟁일 정도로, 계약 전 체계적인 점검이 중요합니다.\n\n견적서에는 철거·설비·마감재·가구 제작 및 운송비·폐기물 처리 비용까지 모두 기재되어 있는지 확인해야 합니다. "마루 시공"처럼 뭉뚱그린 표현보다, 구체적인 브랜드와 규격이 적혀 있어야 나중에 저가 자재로 바뀌는 상황을 예방할 수 있습니다.\n\n"추후 발생 가능"처럼 모호한 항목은 삭제를 요청하거나, 발생 기준을 명확히 정해두는 것이 좋습니다. 계약금은 전체 비용의 10~20% 정도가 일반적이며, 착수금·중도금·잔금으로 나눠 지급하는 구조가 안전합니다.\n\n업체를 고를 때는 가격보다 신뢰성과 시공 품질이 우선입니다. 사업자 등록증과 보험 가입 여부, 실제 시공 사례를 함께 확인하는 것이 좋습니다.'
    },
    {
      id: randomUUID(), tag: '견적 가이드', title: '여러 인테리어 견적, 이렇게 비교하세요',
      summary: '같은 조건으로 여러 업체에 견적을 요청해야 금액 차이의 이유가 명확해집니다. 견적 비교의 핵심 포인트를 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-17',
      source_name: '모모랩', source_url: 'https://momolabdesign.com/story/how-to-compare-estimates',
      body: '여러 업체의 견적을 비교할 때 가장 중요한 원칙은, 원하는 공사 범위와 자재 등급, 포함 항목(철거·폐기물·청소 등)을 한 장으로 정리해 모든 업체에 동일하게 전달하는 것입니다. 같은 조건에서 나온 견적이라야 어느 업체가 무엇을 더 넣었고 뺐는지가 명확히 드러나고, 금액 차이의 이유도 설명이 가능해집니다.\n\n견적서를 볼 때는 공종별로 자재비·인건비·수량이 나뉘어 있는지, 혹은 "일식"으로 뭉쳐 있지는 않은지부터 확인해야 합니다. 자재 정보도 브랜드·품번·등급·규격과 수량까지 구체적으로 적혀 있는지 봐야 합니다.\n\n하자보증 기간은 법으로 일률적으로 정해진 것이 아니라 계약서에 적힌 대로 적용됩니다. 참고로 건설산업기본법상 하자담보책임기간은 공종에 따라 다른데, 도배·도장·타일·방수·창호 등은 보통 1년, 급배수·냉난방 설비는 2년 정도로 정해져 있습니다.\n\n지급 조건도 비교 포인트입니다. 선금 비중이 지나치게 크지 않은지, 공정 진행에 맞춰 나눠 지급하는 구조인지 확인하는 것이 안전합니다.'
    },
    {
      id: randomUUID(), tag: '서재 인테리어', title: '2026년 홈오피스, 일과 휴식 분리가 핵심입니다',
      summary: '재택근무가 일상이 되면서 홈오피스는 선택이 아닌 필수 공간이 됐습니다. 업무 집중도를 높이는 공간 구성법을 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-27',
      source_name: '인테리어꿀팁', source_url: 'https://www.intip.kr/posts/home-office-setup',
      body: '재택근무와 자기계발 시간이 늘면서, 서재나 홈오피스는 이제 선택이 아니라 필수 공간으로 자리잡고 있습니다. 침실 한쪽에서 불편하게 노트북을 펴던 시절과 달리, 최근에는 집에서도 사무실 못지않게 집중할 수 있는 별도 공간을 마련하는 경우가 늘고 있습니다.\n\n홈오피스 구성의 첫 번째 원칙은 "일하는 공간"과 "쉬는 공간"을 명확히 분리하는 것입니다. 별도의 방이 있다면 가장 좋지만, 여의치 않다면 파티션이나 책장으로 구역만 나눠줘도 업무 모드로 전환하는 데 도움이 됩니다.\n\n조명은 전체 조명과 책상 위를 비추는 부분 조명을 함께 쓰는 것이 좋습니다. 색온도도 상황에 따라 다르게 맞추는 게 효과적인데, 집중이 필요한 업무 시간에는 하얀빛(4000~6000K)이, 휴식이나 아이디어가 필요할 때는 노란빛(2700~3000K)이 더 잘 맞습니다.\n\n모니터 높이는 시선이 약간 아래(15~20도)를 향하도록 맞추는 것이 목 건강에 좋습니다. 책상 위는 필요한 물건만 두고 나머지는 정리해두면, 시각적인 산만함이 줄어 집중력 유지에도 도움이 됩니다.'
    },
    {
      id: randomUUID(), tag: '발코니 활용', title: '발코니 확장, 이 2가지만은 꼭 확인하세요',
      summary: '발코니를 실내 공간으로 확장할 때, 춥지 않게 시공하려면 창호 교체와 바닥 단열을 제대로 챙겨야 합니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-26',
      source_name: '오늘의집 라이프스타일 매거진', source_url: 'https://ohou.se/advices/2191',
      body: '좁은 집이 답답하게 느껴질 때 많이 고려하는 것이 발코니 확장입니다. 다만 발코니 확장은 단순히 면적만 넓히는 공사가 아니라, 여러 공정이 함께 필요한 시공이라 미리 알아두면 좋은 부분들이 있습니다.\n\n발코니 확장을 고민할 때 가장 많이 나오는 질문이 "확장하면 춥지 않을까"입니다. 발코니가 사라지면 외부와 실내가 더 직접 맞닿게 되니 당연한 걱정인데, 핵심은 창호와 바닥 단열을 제대로 하는지에 달려 있습니다.\n\n먼저 기존에 단창이었던 발코니 새시는 반드시 이중창으로 교체해야 합니다. 그다음으로 중요한 것이 바닥 단열입니다. 기존 발코니 바닥을 철거한 뒤 보일러를 깔기 전에 단열재를 제대로 시공해야 하는데, 비용을 아끼려고 기존 타일을 뜯지 않고 그 위에 덧방 시공을 하는 경우 단열재가 얇아져 웃풍이나 결로가 생기기 쉽습니다.\n\n확장한 발코니는 거실 연장 공간으로 쓰기도 하고, 최근에는 홈카페나 미니 정원, 작업실처럼 개성 있는 공간으로 꾸미는 사례도 늘고 있습니다. 다만 참고로 발코니 확장은 법적으로 1.5m까지 가능하지만, 베란다는 위아래 층의 면적 차이로 생긴 공간이라 성격이 달라 확장이 불가능하다는 점은 헷갈리지 않아야 합니다.'
    },
    {
      id: randomUUID(), tag: '현관 인테리어', title: '현관 신발장, 이 4가지 스타일 중 골라보세요',
      summary: '붙박이형·하부 띄움형·거울 도어형·오픈 선반형 — 현관 폭과 신발 수에 맞는 신발장 스타일을 정리했습니다.',
      thumb_emoji: '', thumb_color: '', published_at: '2026-08-28',
      source_name: '한샘 스토어', source_url: 'https://store.hanssem.com/tips/info/%ED%98%84%EA%B4%80-%EC%8B%A0%EB%B0%9C%EC%9E%A5-%EC%9D%B8%ED%85%8C%EB%A6%AC%EC%96%B4-%EC%B6%94%EC%B2%9C/',
      body: '현관 신발장은 크게 붙박이형, 하부 띄움형, 거울 도어형, 오픈 선반형 네 가지로 나눠볼 수 있습니다. 각각 장단점이 달라서, 현관 폭과 보유한 신발 수에 따라 적합한 스타일이 달라집니다.\n\n붙박이형은 수납량을 가장 많이 확보할 수 있어 신발이 많은 가정에 적합합니다. 하부 띄움형은 신발장 아래를 바닥에서 띄워 시공하는 방식으로, 자주 신는 신발을 빠르게 꺼내고 넣기 편하다는 장점이 있습니다.\n\n좁은 현관이라면 밝은 컬러의 슬림형 신발장이 잘 어울립니다. 화이트나 라이트 그레이, 혹은 거울 도어를 활용하면 신발장이 차지하는 시각적 존재감이 줄어들어 공간이 넓어 보이는 효과가 있습니다. 다만 수납할 신발이 많다면, 내부 선반 조절이 가능한지 부츠나 우산을 넣을 별도 공간이 있는지도 함께 확인하는 것이 좋습니다.\n\n시공 전에는 보유한 신발 수와 신발 높이, 현관 치수, 중문 설치 여부를 먼저 확인해야 합니다. 신발을 운동화·구두·부츠처럼 종류별로 분류해두면, 필요한 선반 간격과 하부 오픈 공간을 정하기가 한결 수월해집니다.'
    }
  ];
  const stmt = db.prepare(`INSERT INTO columns (id, tag, title, summary, body, thumb_emoji, thumb_color, published_at, sort_order, source_name, source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  defaults.forEach((c, i) => stmt.run(c.id, c.tag, c.title, c.summary, c.body, c.thumb_emoji, c.thumb_color, c.published_at, i, c.source_name, c.source_url));
}
seedDefaultColumnsIfEmpty();

// Notion 텍스트 블록들을 간단한 개행 텍스트로 변환(리치텍스트의 plain_text만 이어붙임)
function notionBlocksToPlainText(blocks) {
  return blocks.map(b => {
    const type = b.type;
    const rich = (b[type] && b[type].rich_text) || [];
    const text = rich.map(t => t.plain_text).join('');
    if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') return '\n' + text + '\n';
    return text;
  }).filter(Boolean).join('\n\n');
}

// Notion 데이터베이스를 조회해 columns 테이블에 upsert. 실패해도 서버 기동에는 영향 없음(폴백 유지).
async function syncColumnsFromNotion() {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    return { synced: false, reason: 'NOTION_API_KEY 또는 NOTION_DATABASE_ID 환경변수가 설정되지 않았습니다' };
  }
  const headers = { 'Authorization': `Bearer ${NOTION_API_KEY}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
  const dbRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, { method: 'POST', headers, body: JSON.stringify({ page_size: 50 }) });
  if (!dbRes.ok) throw new Error(`Notion 데이터베이스 조회 실패 (${dbRes.status})`);
  const dbJson = await dbRes.json();
  const pages = dbJson.results || [];
  let syncedCount = 0;
  for (const page of pages) {
    const props = page.properties || {};
    const getTitle = (p) => (p && p.title || []).map(t => t.plain_text).join('') || '';
    const getRichText = (p) => (p && p.rich_text || []).map(t => t.plain_text).join('') || '';
    const getSelect = (p) => (p && p.select && p.select.name) || '';
    const title = getTitle(props['Title'] || props['제목']);
    if (!title) continue; // 제목 없는 항목은 건너뜀
    const tag = getSelect(props['Tag'] || props['태그']) || '인테리어';
    const summary = getRichText(props['Summary'] || props['요약']);
    const emoji = getRichText(props['Emoji'] || props['이모지']) || '🏠';
    // 본문(블록) 조회
    const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, { headers });
    const blocksJson = blocksRes.ok ? await blocksRes.json() : { results: [] };
    const body = notionBlocksToPlainText(blocksJson.results || []) || summary;
    const publishedAt = (page.created_time || '').slice(0, 10);
    const existing = db.prepare('SELECT id FROM columns WHERE notion_page_id=?').get(page.id);
    if (existing) {
      db.prepare(`UPDATE columns SET tag=?, title=?, summary=?, body=?, thumb_emoji=?, updated_at=datetime('now') WHERE notion_page_id=?`)
        .run(tag, title, summary, body, emoji, page.id);
    } else {
      db.prepare(`INSERT INTO columns (id, notion_page_id, tag, title, summary, body, thumb_emoji, thumb_color, published_at, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), page.id, tag, title, summary, body, emoji, 'linear-gradient(135deg,#8FA890,#4A7BA6)', publishedAt, -Date.now());
    }
    syncedCount++;
  }
  return { synced: true, count: syncedCount };
}

// 칼럼 목록(요약) — 최신순
app.get('/api/columns', (req, res) => {
  const list = db.prepare('SELECT id, tag, title, summary, thumb_emoji, thumb_color, published_at FROM columns ORDER BY sort_order ASC, published_at DESC').all();
  res.json({ success: true, data: list });
});

// 칼럼 상세(본문 포함)
app.get('/api/columns/:id', (req, res) => {
  const col = db.prepare('SELECT * FROM columns WHERE id=?').get(req.params.id);
  if (!col) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '칼럼을 찾을 수 없습니다' } });
  res.json({ success: true, data: col });
});

// 관리자 수동 동기화 트리거(Notion에 새 글 쓴 뒤 즉시 반영하고 싶을 때 호출)
app.post('/api/admin/columns/sync-notion', adminAuthRequired(), async (req, res) => {
  try {
    const result = await syncColumnsFromNotion();
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ success: false, error: { code: 'NOTION_SYNC_FAILED', message: e.message } });
  }
});

// ===== 6. 관리자 대시보드 카운트 =====
// 결함수정(전체 재검증 중 발견): dispute/abuse/inspect/settleHold/tier가 전부 하드코딩된 0이었음
// → 각각 실제 테이블에서 미처리 건수를 집계하도록 수정
app.get('/api/admin/dashboard/counts', adminAuthRequired(), (req, res) => {
  const ads = db.prepare("SELECT COUNT(*) c FROM ad_slots WHERE status='pending'").get().c;
  const partners = db.prepare("SELECT COUNT(*) c FROM partners WHERE verify_status='pending'").get().c;
  const dispute = db.prepare("SELECT COUNT(*) c FROM disputes WHERE status IN ('filed','ai_judged')").get().c;
  const inspect = db.prepare("SELECT COUNT(*) c FROM inspections WHERE status='unpaid'").get().c;
  const settleHold = db.prepare("SELECT COUNT(*) c FROM settlements WHERE status='hold'").get().c;
  const abuseCandidates = db.prepare("SELECT room_id, noshow_log FROM meas_jobs").all()
    .filter(j => { try { return JSON.parse(j.noshow_log).length >= 2; } catch (e) { return false; } }).length;
  res.json({ success: true, data: { ads, partners, dispute, abuse: abuseCandidates, inspect, settleHold, tier: 0 } });
});

// ===== 1-5(팀장 지시): API 문서 자동화(Swagger) — /api-docs 에서 43개 전체 확인·직접 테스트 가능 =====
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

// ===== 9. 검증(사업자번호/대표자명) =====
// ⚡MVP-SWITCH: 실서버는 국세청 사업자등록정보 진위확인 API(공공데이터포털) 연동. 지금은 형식검증만 하는 결정적 mock
app.post('/api/verify/business-number', (req, res) => {
  const { bizNo } = req.body;
  if(!bizNo || !/^\d{3}-?\d{2}-?\d{5}$/.test(bizNo)) return res.status(400).json({ success:false, error:{code:'VALIDATION_ERROR', message:'사업자등록번호 형식이 올바르지 않습니다'} });
  res.json({ success:true, data:{ valid:true, status:'정상' } });
});
app.post('/api/verify/ceo-name', (req, res) => {
  const { bizNo, ceoName } = req.body;
  if(!isNonEmptyString(bizNo) || !isNonEmptyString(ceoName, 30)) return validationError(res, 'bizNo, ceoName이 필요합니다');
  res.json({ success:true, data:{ match:true } });
});

// ===== 10. 정산 내보내기 =====
app.get('/api/settlements/export', authRequired, (req, res) => {
  if(req.user.role !== 'partner') return res.status(403).json({ success:false, error:{code:'FORBIDDEN', message:'업체 계정만 내보낼 수 있습니다'} });
  const rows = db.prepare('SELECT * FROM settlements WHERE partner_id=?').all(req.user.sub);
  res.setHeader('Content-Disposition', 'attachment; filename="settlements.json"');
  res.json({ success:true, data: rows });
});

// ===== 11. 캐시 적립 =====
app.post('/api/cash/credit', authRequired, (req, res) => {
  const { amount, reason } = req.body;
  if(!isPositiveAmount(amount) || amount<=0) return validationError(res, '적립 금액은 0보다 커야 합니다');
  db.prepare('UPDATE users SET cash_balance = cash_balance + ? WHERE id=?').run(amount, req.user.sub);
  const user = db.prepare('SELECT cash_balance FROM users WHERE id=?').get(req.user.sub);
  res.json({ success:true, data:{ balance:user.cash_balance, credited:amount, reason: reason||null } });
});

// ===== 12. 업체 출금 =====
app.post('/api/withdrawals', authRequired, (req, res) => {
  if(req.user.role !== 'partner') return res.status(403).json({ success:false, error:{code:'FORBIDDEN', message:'업체 계정만 출금할 수 있습니다'} });
  const { amount, bankAccount } = req.body;
  if(!isPositiveAmount(amount) || amount<=0) return validationError(res, '출금액은 0보다 커야 합니다');
  if(!isNonEmptyString(bankAccount, 50)) return validationError(res, '계좌정보를 입력해주세요');
  // 결함수정(4단계 부하테스트 중 발견 — 중대): 잔액 검증이 전혀 없어 보유 캐시 초과 출금이나
  // 동시 다발 요청으로 인한 이중출금이 가능했음 → 트랜잭션으로 잔액 확인+즉시차감을 원자적으로 처리
  const id = randomUUID();
  try {
    const tx = db.transaction(() => {
      const partner = db.prepare('SELECT credit_balance FROM partners WHERE id=?').get(req.user.sub);
      if(!partner) throw Object.assign(new Error('업체를 찾을 수 없습니다'), { code:'NOT_FOUND' });
      if(partner.credit_balance < amount) throw Object.assign(new Error('보유 잔액이 부족합니다'), { code:'INSUFFICIENT_BALANCE' });
      db.prepare('UPDATE partners SET credit_balance = credit_balance - ? WHERE id=?').run(amount, req.user.sub);
      db.prepare('INSERT INTO credit_ledger (id, partner_id, type, amount, payment_method) VALUES (?,?,?,?,?)')
        .run(id, req.user.sub, 'withdrawal', -Math.abs(amount), bankAccount);
    });
    tx();
  } catch(e) {
    const code = e.code || 'WITHDRAWAL_FAILED';
    const status = code === 'NOT_FOUND' ? 404 : code === 'INSUFFICIENT_BALANCE' ? 400 : 500;
    return res.status(status).json({ success:false, error:{ code, message: e.message } });
  }
  res.json({ success:true, data:{ id, status:'requested', message:'출금 신청이 접수됐어요' } });
});

// ===== 13. SNS 공유 + 초대 =====
app.post('/api/share/sns', authRequired, (req, res) => {
  const { platform, contentUrl } = req.body;
  if(!isNonEmptyString(platform, 30)) return validationError(res, '공유 플랫폼을 지정해주세요');
  // ⚡MVP-SWITCH: 실서버 → 실제 SNS 공유 SDK 콜백 확인 후 리워드 지급. 지금은 즉시 지급 mock
  db.prepare('UPDATE users SET cash_balance = cash_balance + 1000 WHERE id=?').run(req.user.sub);
  res.json({ success:true, data:{ shared:true, rewardCredited:true, reward:1000 } });
});
app.post('/api/invite', authRequired, (req, res) => {
  const inviteId = randomUUID();
  res.json({ success:true, data:{ inviteId, inviteUrl: 'https://roomer.app/invite/'+inviteId } });
});

// ===== 14. 관리자 알림·정책 =====
app.post('/api/admin/alert', adminAuthRequired(), (req, res) => {
  const { channel, message } = req.body;
  if(!['sms','email'].includes(channel)) return validationError(res, '올바른 발송채널이 아닙니다(sms/email)');
  // ⚡MVP-SWITCH: 실서버 → SMS/이메일 게이트웨이(알리고·SendGrid 등) API 호출
  console.log('[관리자알림 발송 mock]', channel, message);
  res.json({ success:true, data:{ sent:true, channel } });
});
app.put('/api/admin/policy', adminAuthRequired('admin_super'), (req, res) => {
  const { key, value } = req.body;
  if(!isNonEmptyString(key, 100)) return validationError(res, 'key가 필요합니다');
  db.prepare('CREATE TABLE IF NOT EXISTS admin_policies (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime(\'now\')))').run();
  db.prepare('INSERT INTO admin_policies (key, value, updated_at) VALUES (?,?,datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime(\'now\')').run(key, JSON.stringify(value));
  res.json({ success:true, data:{ key, value } });
});

// ===== 15. QR코드 생성 =====
// 실제로 동작하는 QR코드(외부 서비스 계약 불필요, npm qrcode 라이브러리 사용)
app.get('/api/qrcode', async (req, res) => {
  const { data } = req.query;
  if(!isNonEmptyString(data, 500)) return validationError(res, 'data(인코딩할 내용)가 필요합니다');
  try {
    const dataUrl = await QRCode.toDataURL(data, { width: 300, margin: 2 });
    res.json({ success: true, data: { qrCodeDataUrl: dataUrl } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'QR_GENERATION_FAILED', message: e.message } });
  }
});

// ===== 17. 프론트엔드 직접 서빙(PC+모바일 동시 테스트용) =====
// 같은 와이파이의 PC/모바일 모두 이 서버 하나만 켜져있으면 http://<PC IP>:4000/app 으로 접속 가능
// 프론트엔드 파일을 수정할 때는 이 폴더의 루머03.html만 교체하면 됨(서버 재시작 불필요, 브라우저 새로고침만 하면 반영됨)
// 결함수정(Mac에서 실제로 재현·확인된 심각한 버그): macOS는 파일을 Finder로 옮기거나
// 다운로드하는 과정에서 한글 파일명을 내부적으로 "분해형(NFD)"으로 자동 변환해서 저장함.
// 코드에 적힌 '루머03.html'(결합형/NFC)과 실제 디스크의 파일명(분해형/NFD)이 바이트 단위로
// 달라서 express.static이 파일을 못 찾고 계속 404를 반환했음(Mac에서만 재현되던 문제).
// → 폴더를 실제로 스캔해서, 정규화(NFC) 기준으로 이름이 같은 파일을 찾아 그 "실제 파일명"으로 서빙
function findIndexFileNormalized() {
  const targetNFC = '루머03.html'.normalize('NFC');
  const files = fs.readdirSync(__dirname);
  const found = files.find(f => f.normalize('NFC') === targetNFC);
  return found ? path.join(__dirname, found) : null;
}

// 보안수정(루머28): __dirname 전체를 정적 공개하면 /app/server.js, /app/db.js 및 DB 파일까지
// 다운로드될 수 있다. 앱 HTML 한 파일만 명시적으로 제공하고, 내용이 실제 HTML인지도 확인한다.
function sendRoomerApp(req, res) {
  const appFile = findIndexFileNormalized();
  if (!appFile) {
    return res.status(503).json({ success:false, error:{ code:'FRONTEND_NOT_FOUND', message:'루머03.html 파일이 배포되지 않았습니다' } });
  }
  try {
    const prefix = fs.readFileSync(appFile, { encoding:'utf8' }).slice(0, 256).toLowerCase();
    if (!prefix.includes('<!doctype html') && !prefix.includes('<html')) {
      return res.status(503).json({ success:false, error:{ code:'FRONTEND_INVALID', message:'배포된 루머03.html 파일의 내용이 올바르지 않습니다' } });
    }
  } catch (e) {
    return res.status(503).json({ success:false, error:{ code:'FRONTEND_READ_ERROR', message:'앱 화면 파일을 읽을 수 없습니다' } });
  }
  res.type('html').sendFile(appFile);
}
app.get(['/app', '/app/'], sendRoomerApp);

// 신규(사용자요청 — 네이버/카카오 OAuth 콜백시 ROUTE_NOT_FOUND 에러 수정): 소셜로그인 완료 후
// 카카오/네이버가 리다이렉트하는 /oauth/*/callback 경로는 API가 아니라 "앱 화면"이 다시 열려야
// 하는 경로임(그래야 프론트의 handleKakaoOAuthCallback/handleNaverOAuthCallback이 code를 읽어
// 처리함). 이 경로들에서도 앱 파일을 그대로 서빙하도록 명시적으로 라우트 추가.
app.get(['/oauth/kakao/callback', '/oauth/naver/callback'], (req, res) => {
  sendRoomerApp(req, res);
});

// ===== 18. 라이브 리로드(파일만 교체하면 PC·모바일 자동 새로고침) =====
// 신규(사용자요청): 수정한 루머03.html로 교체만 하면, 서버 재시작·수동 새로고침 없이
// 열려있는 모든 브라우저(PC+모바일)가 3초 안에 저절로 새로고침되도록
app.get('/api/dev-file-version', (req, res) => {
  try {
    const appFile = findIndexFileNormalized();
    if (!appFile) throw new Error('루머03.html not found');
    const stat = fs.statSync(appFile);
    res.json({ success: true, data: { mtime: stat.mtimeMs } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'FILE_ERROR', message: e.message } });
  }
});
// 모바일 접속 URL을 프론트엔드가 QR코드로 바로 보여줄 수 있도록 로컬IP 제공
app.get('/api/dev-local-url', (req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let ip = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
    }
    if (ip) break;
  }
  res.json({ success: true, data: { url: ip ? `http://${ip}:${PORT}/app` : null } });
});

app.get('/', (req, res) => res.json({ service: '루머 ROOMER API', status: 'running', docs: '/api-docs', app: '/app' }));

// ===== 16. 테스트 채팅 — 두 브라우저 창이 반드시 같은 방에서 만나게 해주는 고정 테스트업체 =====
// 실서비스에서는 사용하지 않음(개발/체험 검증 전용). 소비자 계정에서 이 API를 호출하면
// 항상 "테스트업체(고정 ID)"와의 채팅방을 반환/생성함 — 다른 창에서 업체로 로그인할 때 이 업체를 찾으면 됨
const TEST_PARTNER_ID = '00000000-0000-0000-0000-000000000001';
function ensureTestPartner() {
  const existing = db.prepare('SELECT * FROM partners WHERE id=?').get(TEST_PARTNER_ID);
  if (existing) return existing;
  db.prepare(`INSERT INTO partners (id, business_name, business_reg_number, ceo_name, tier, region, doc_image_url, verify_status, cert_business, cert_location, cert_contact)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(TEST_PARTNER_ID, '테스트업체(체험용)', '000-00-00000', '테스트대표', '면허 파트너', '서울', 'test', 'approved', 1, 1, 1);
  return db.prepare('SELECT * FROM partners WHERE id=?').get(TEST_PARTNER_ID);
}
app.get('/api/test-partner', (req, res) => {
  const p = ensureTestPartner();
  res.json({ success: true, data: { id: p.id, businessName: p.business_name, hint: '이 화면 정보로 다른 창에서 업체 로그인 후 테스트하세요. (테스트업체는 별도 계정 없이, 서버가 자동으로 만들어둔 고정 업체입니다)' } });
});
app.post('/api/test-room', authRequired, (req, res) => {
  if (req.user.role !== 'consumer') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '소비자 계정에서만 테스트 채팅을 시작할 수 있습니다' } });
  ensureTestPartner();
  let room = db.prepare('SELECT * FROM chat_rooms WHERE consumer_id=? AND partner_id=?').get(req.user.sub, TEST_PARTNER_ID);
  if (!room) {
    const id = randomUUID();
    db.prepare('INSERT INTO chat_rooms (id, consumer_id, partner_id) VALUES (?,?,?)').run(id, req.user.sub, TEST_PARTNER_ID);
    db.prepare('INSERT INTO meas_jobs (room_id) VALUES (?)').run(id);
    room = db.prepare('SELECT * FROM chat_rooms WHERE id=?').get(id);
  }
  res.json({ success: true, data: room });
});
// 업체용: "테스트업체" 계정으로 즉시 로그인(비밀번호 불필요, 체험 전용 특수 로그인)
app.post('/api/test-partner-login', (req, res) => {
  const p = ensureTestPartner();
  const token = jwt.sign({ sub: p.id, role: 'partner' }, JWT_SECRET, { expiresIn: '4h' });
  res.json({ success: true, data: { token, partner: p } });
});

// ===== 1-2(팀장 지시): 정의되지 않은 경로 → Express 기본 HTML 에러 대신 일관된 JSON으로 응답 =====
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'ROUTE_NOT_FOUND', message: '존재하지 않는 API 경로입니다' } });
});

// 신규(2차 심층검증 중 발견): FK위반·잘못된 JSON 요청이 전부 500(서버오류)으로 뭉뚱그려지던 문제 수정
// → 클라이언트 잘못(400)과 진짜 서버오류(500)를 구분해서 응답
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: '요청 형식이 올바르지 않습니다' } });
  }
  // 결함수정(4단계 부하테스트 중 발견): 1MB 초과 요청이 500(서버오류)으로 잘못 분류되던 문제 → 400으로 정확히 구분
  if (err.type === 'entity.too.large') {
    const portfolioUpload = req.path === '/api/partners/me/portfolio';
    return res.status(400).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: portfolioUpload ? '포트폴리오 업로드 용량이 너무 큽니다(사진당 10MB·최대 10장)' : '요청 본문이 너무 큽니다(최대 1MB)' } });
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REFERENCE', message: '존재하지 않는 대상을 참조했습니다(예: 잘못된 업체ID)' } });
  }
  console.error(err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다' } });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`루머 ROOMER 백엔드 실행중: http://localhost:${PORT}`);
  // 신규(PC+모바일 동시테스트 지원): 같은 와이파이의 다른 기기(모바일)에서 접속할 정확한 주소를 자동으로 찾아서 안내
  const os = require('os');
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  if (addrs.length) {
    console.log('\n📱 모바일(같은 와이파이)에서 접속하려면:');
    addrs.forEach(ip => console.log(`   http://${ip}:${PORT}/app`));
    console.log('');
  }
});
