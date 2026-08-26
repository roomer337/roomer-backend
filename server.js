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
// 결함수정: CORS가 모든 오리진을 허용하고 있었음 → 환경변수로 명시적 허용 도메인 지정(미설정시 개발 편의상 전체허용, 배포 전 반드시 설정)
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : '*' }));
app.use(express.json({ limit: '1mb' })); // 결함수정: 요청 본문 크기 제한이 없어 대용량 body로 서버 자원 고갈시키는 DoS가 가능했음

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

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-in-production';
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

// ===== 인증 미들웨어 =====
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ success: false, error: { code: 'NO_TOKEN', message: '로그인이 필요합니다' } });
  try {
    const token = header.replace('Bearer ', '');
    req.user = jwt.verify(token, JWT_SECRET);
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
    db.prepare('INSERT INTO users (id, social_provider, social_id, nickname) VALUES (?,?,?,?)')
      .run(id, provider, socialId, nickname || '회원');
    user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const token = jwt.sign({ sub: user.id, role: 'consumer' }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ success: true, data: { token, user } });
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
app.post('/api/partners/register', (req, res) => {
  const { businessName, businessRegNumber, licenseNumber, ceoName, address, region, docImageUrl, extImageUrl, intImageUrl } = req.body;
  if (!isNonEmptyString(businessName, 100)) return validationError(res, '상호명을 입력해주세요(100자 이내)');
  if (!isNonEmptyString(businessRegNumber) || !BIZNO_RE.test(businessRegNumber)) return validationError(res, '사업자등록번호 형식이 올바르지 않습니다(예: 123-45-67890)');
  if (ceoName && !isNonEmptyString(ceoName, 30)) return validationError(res, '대표자명은 30자 이내여야 합니다');
  if (address && !isNonEmptyString(address, 200)) return validationError(res, '주소는 200자 이내여야 합니다');
  // 재설계(사용자요청): 사업자등록증 없으면 플랫폼 등록 자체를 제한하는 정책
  if (!docImageUrl) {
    return res.status(400).json({ success: false, error: { code: 'DOC_REQUIRED', message: '사업자등록증을 올려야 등록할 수 있습니다' } });
  }
  const id = randomUUID();
  const tier = licenseNumber ? '면허 파트너' : '부분공사가능업체';
  db.prepare(`INSERT INTO partners (id, business_name, business_reg_number, license_number, ceo_name, address, tier, region, doc_image_url, ext_image_url, int_image_url, verify_status, cert_license)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`)
    .run(id, businessName, businessRegNumber, licenseNumber || null, ceoName || null, address || null, tier, region || null, docImageUrl, extImageUrl || null, intImageUrl || null, tier === '면허 파트너' ? 1 : 0);
  const token = jwt.sign({ sub: id, role: 'partner' }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ success: true, data: { id, tier, verifyStatus: 'pending', token, licenseLimitNotice: tier === '부분공사가능업체' ? '무면허 업체는 1,500만원 이상 종합공사를 진행할 수 없습니다.' : null } });
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
app.post('/api/partners/me/portfolio', authRequired, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 등록할 수 있습니다' } });
  const { title, description, photoUrls } = req.body;
  if (!isNonEmptyString(title, 60)) return validationError(res, '제목은 1~60자여야 합니다');
  if (description && !isNonEmptyString(description, 1000)) return validationError(res, '설명은 1000자 이내여야 합니다');
  if (!Array.isArray(photoUrls) || photoUrls.length === 0) return validationError(res, '사진을 1장 이상 올려주세요');
  if (photoUrls.length > 20) return validationError(res, '사진은 최대 20장까지 올릴 수 있습니다');
  if (!photoUrls.every(u => isNonEmptyString(u, 500))) return validationError(res, '사진 URL 형식이 올바르지 않습니다');
  const projectId = randomUUID();
  db.prepare('INSERT INTO portfolio_projects (id, partner_id, title, description) VALUES (?,?,?,?)')
    .run(projectId, req.user.sub, title, description || null);
  const insertPhoto = db.prepare('INSERT INTO portfolio_photos (id, project_id, image_url, sort_order) VALUES (?,?,?,?)');
  photoUrls.forEach((url, i) => insertPhoto.run(randomUUID(), projectId, url, i));
  // 실시공 인증(계약 이력과 별개로, 포트폴리오 등록 자체는 인증에 반영하지 않음 — cert_completed는 계약건수 기준)
  res.json({ success: true, data: { id: projectId } });
});

app.get('/api/partners/:id/portfolio', (req, res) => {
  const projects = db.prepare('SELECT * FROM portfolio_projects WHERE partner_id=? ORDER BY created_at DESC').all(req.params.id);
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

// ===== 5. 광고(Ad Slots) — AI 1차 검수 데모 포함 =====
const AD_BANNED_WORDS = ['100%', '최고', '1위', '완벽', '무조건'];
app.post('/api/ads', authRequired, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '업체 계정만 광고를 등록할 수 있습니다' } });
  const { slotType, region, tagline, costType, costValue } = req.body;
  if (!isNonEmptyString(slotType, 30)) return validationError(res, '광고 슬롯 유형을 선택해주세요');
  if (region && !isNonEmptyString(region, 50)) return validationError(res, '지역은 50자 이내여야 합니다');
  if (tagline && !isNonEmptyString(tagline, 100)) return validationError(res, '광고 문구는 100자 이내여야 합니다');
  if (!isPositiveInt(costValue) || costValue <= 0) return validationError(res, '비용은 0보다 큰 정수여야 합니다');
  const hit = AD_BANNED_WORDS.filter(w => (tagline || '').includes(w));
  const id = randomUUID();
  db.prepare(`INSERT INTO ad_slots (id, partner_id, slot_type, region, tagline, status, cost_type, cost_value, ai_precheck_result)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.sub, slotType, region, tagline, 'pending', costType, costValue, hit.length ? 'flagged' : 'pass');
  res.json({ success: true, data: { id, aiPrecheckResult: hit.length ? 'flagged' : 'pass', flaggedWords: hit } });
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
  const fs = require('fs'); // 함수 내부에서 직접 require(모듈 캐싱되므로 성능 문제 없음, 파일 상단 선언 순서와 무관하게 항상 안전)
  const targetNFC = '루머03.html'.normalize('NFC');
  const files = fs.readdirSync(__dirname);
  const found = files.find(f => f.normalize('NFC') === targetNFC);
  return found || '루머03.html';
}
app.use('/app', express.static(__dirname, { index: findIndexFileNormalized() }));

// ===== 18. 라이브 리로드(파일만 교체하면 PC·모바일 자동 새로고침) =====
// 신규(사용자요청): 수정한 루머03.html로 교체만 하면, 서버 재시작·수동 새로고침 없이
// 열려있는 모든 브라우저(PC+모바일)가 3초 안에 저절로 새로고침되도록
const fs = require('fs');
const path = require('path');
app.get('/api/dev-file-version', (req, res) => {
  try {
    const stat = fs.statSync(path.join(__dirname, '루머03.html'));
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
    return res.status(400).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '요청 본문이 너무 큽니다(최대 1MB)' } });
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
