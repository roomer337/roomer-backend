const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `roomer-qa-${process.pid}.db`);
const secret = 'roomer-qa-secret-at-least-thirty-two-characters';
const port = 4199;
const server = spawn(process.execPath, ['server.js'], { cwd:root, env:{...process.env,PORT:String(port),DB_PATH:dbPath,JWT_SECRET:secret,NODE_ENV:'test',ENABLE_DEV_TEST_ROUTES:'false'}, stdio:['ignore','ignore','inherit'] });
const results=[];
function token(sub,role){return jwt.sign({sub,role},secret,{expiresIn:'10m'});}
async function api(method,url,body,auth){const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(auth?{authorization:`Bearer ${auth}`}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,json:await response.json()};}
function check(name,condition,detail){results.push({name,pass:Boolean(condition),detail});if(!condition)throw new Error(`${name}: ${detail||'failed'}`);}
async function waitReady(){for(let i=0;i<30;i++){try{const r=await fetch(`http://127.0.0.1:${port}/`);if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,100));}throw new Error('server did not start');}
(async()=>{try{
  await waitReady();const db=new Database(dbPath);
  db.exec(`INSERT INTO users(id,social_provider,social_id,nickname) VALUES ('u1','qa','u1','소비자1'),('u2','qa','u2','소비자2');`);
  const insertPartner=db.prepare(`INSERT INTO partners(id,login_provider,login_id,business_name,business_reg_number,ceo_name,tier,region,doc_image_url,verify_status,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
  insertPartner.run('p1','email','p1@test.dev','승인업체1','111-11-11111','대표1','면허 파트너','서울 강남구','file','approved');
  insertPartner.run('p2','email','p2@test.dev','승인업체2','222-22-22222','대표2','면허 파트너','부산 해운대구','file','approved');
  insertPartner.run('p3','email','p3@test.dev','미승인업체','333-33-33333','대표3','면허 파트너','서울 강남구','file','rejected');
  const { randomUUID: qaRandomUUID } = require('crypto');
  const roomBId = qaRandomUUID();
  db.prepare(`INSERT INTO chat_rooms (id, consumer_id, partner_id) VALUES (?,?,?)`).run(roomBId, 'u2', 'p2');
  db.close();
  const u1=token('u1','consumer'),u2=token('u2','consumer'),p1=token('p1','partner'),p2=token('p2','partner');let r;
  r=await api('GET','/api/partners/search?region='+encodeURIComponent('서울 강남구'));check('미승인 업체 검색 차단',r.status===200&&r.json.data.every(x=>x.id!=='p3'),r.status);
  r=await api('POST','/api/quote-requests',{partnerId:'p3',address:'서울',pyeong:20,spaceType:'아파트'},u1);check('미승인 업체 견적요청 차단',r.status===409,r.status);
  r=await api('POST','/api/quote-requests',{partnerId:'p1',address:'서울 강남구',pyeong:20,spaceType:'아파트'},u1);check('견적요청 생성',r.status===200,r.status);const requestId=r.json.data.id,roomId=r.json.data.roomId;
  r=await api('GET','/api/rooms/mine',null,u1);check('소비자 메신저에 실제 업체 상호명',r.status===200&&r.json.data.some(x=>x.id===roomId&&x.displayName==='승인업체1'),r.status);
  r=await api('GET','/api/rooms/mine',null,p1);check('파트너 메신저에 실제 소비자명',r.status===200&&r.json.data.some(x=>x.id===roomId&&x.displayName==='소비자1'),r.status);
  r=await api('POST',`/api/rooms/${roomId}/messages`,{text:'격리 테스트 메시지'},u2);check('타 소비자 메시지 발송 차단',r.status===403,r.status);
  r=await api('POST',`/api/rooms/${roomId}/messages`,{text:'정상 메시지'},u1);check('참여자 메시지 저장',r.status===200&&r.json.data.text==='정상 메시지',r.status);
  r=await api('POST',`/api/rooms/${roomId}/messages`,{text:'중복방지 메시지',clientMessageId:'client-001'},u1);check('클라이언트 메시지ID 저장',r.status===200&&r.json.data.client_message_id==='client-001',r.status);const dedupSeq=r.json.data.seq;
  r=await api('POST',`/api/rooms/${roomId}/messages`,{text:'중복방지 메시지',clientMessageId:'client-001'},u1);check('재전송 메시지 중복방지',r.status===200&&r.json.data.seq===dedupSeq&&r.json.data.deduplicated===true,r.status);
  r=await api('GET','/api/rooms/mine',null,p1);check('상대방 안읽은 메시지 계산',r.status===200&&r.json.data.find(x=>x.id===roomId).unreadCount>=2,r.status);
  r=await api('POST',`/api/rooms/${roomId}/read`,{lastReadSeq:dedupSeq},p1);check('Room 읽음위치 저장',r.status===200&&r.json.data.lastReadSeq===dedupSeq,r.status);
  r=await api('GET','/api/rooms/mine',null,p1);check('읽음 후 안읽은 메시지 0',r.status===200&&r.json.data.find(x=>x.id===roomId).unreadCount===0,r.status);
  const slots=[{id:'s1',date:'2026-09-10',time:'10:30'},{id:'s2',date:'2026-09-11',time:'14:30'}];
  r=await api('POST',`/api/meas-jobs/${roomId}/slots`,{slots},u1);check('소비자 일정제안 차단',r.status===403,r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/slots`,{slots},p1);check('파트너 일정제안 저장',r.status===200&&r.json.data.status==='slots_proposed'&&r.json.data.slots.length===2,r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/select`,{slotId:'s1'},p1);check('파트너 일정선택 차단',r.status===403,r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/select`,{slotId:'s1'},u1);check('소비자 일정선택 저장',r.status===200&&r.json.data.status==='slot_selected'&&r.json.data.chosenSlotId==='s1',r.status);
  const siteNotes=[{phase:'도배',status:'추가 작업 필요',memo:'벽면 보수'}];
  r=await api('POST',`/api/meas-jobs/${roomId}/result`,{siteNotes},u1);check('소비자 실측결과 위조 차단',r.status===403,r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/result`,{siteNotes},p1);check('파트너 실측결과 저장',r.status===200&&r.json.data.status==='measured'&&r.json.data.siteNotes[0].memo==='벽면 보수',r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/final-quote-sent`,{},p1);check('최종견적 단계전이',r.status===200&&r.json.data.status==='final_quote_sent',r.status);
  r=await api('PUT',`/api/meas-jobs/${roomId}/meetings/site`,{completed:true},u1);check('소비자 미팅완료 위조 차단',r.status===403,r.status);
  for(const kind of ['site','design','material']){r=await api('PUT',`/api/meas-jobs/${roomId}/meetings/${kind}`,{completed:true},p1);}
  check('3종 미팅 완료 상태전이',r.status===200&&r.json.data.status==='meetings_done',r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/quote-finalized`,{},p1);check('파트너 최종견적 확정',r.status===200&&r.json.data.status==='quote_finalized',r.status);
  r=await api('PUT',`/api/meas-jobs/${roomId}/confirmation`,{key:'photo',checked:true},p1);check('파트너 소비자확인 위조 차단',r.status===403,r.status);
  r=await api('PUT',`/api/meas-jobs/${roomId}/confirmation`,{key:'photo',checked:true},u1);check('소비자 견적확인 저장',r.status===200&&r.json.data.confirmChecks.photo===true,r.status);
  r=await api('PUT',`/api/meas-jobs/${roomId}/confirmation`,{key:'adjust',checked:true},u1);check('소비자 금액동의 저장',r.status===200&&r.json.data.confirmChecks.adjust===true,r.status);
  r=await api('PUT',`/api/meas-jobs/${roomId}`,{status:'contract_confirmed'},u1);check('실측 전체객체 임의덮어쓰기 차단',r.status===405,r.status);
  r=await api('GET',`/api/meas-jobs/${roomId}`,null,u1);check('실측 상세·이력 새로고침 복구',r.status===200&&r.json.data.siteNotes.length===1&&r.json.data.meetings.material===true&&r.json.data.events.length>=8,r.status);
  r=await api('POST','/api/quotes',{requestId,items:[{name:'도배',price:1000000}]},p2);check('타 업체 견적발송 차단',r.status===403,r.status);
  r=await api('POST','/api/quotes',{requestId,items:[{name:'도배',price:1000000}]},p1);check('담당 업체 견적발송',r.status===200&&r.json.data.version===1&&r.json.data.status==='sent',r.status);const quoteV1=r.json.data.id;
  r=await api('POST',`/api/quotes/${quoteV1}/revisions`,{items:[{name:'도배',price:1050000}]},p2);check('타 업체 수정견적 차단',r.status===403,r.status);
  r=await api('POST',`/api/quotes/${quoteV1}/revisions`,{items:[{name:'도배',price:1050000}]},p1);check('수정견적 v2 생성',r.status===200&&r.json.data.version===2&&r.json.data.parent_quote_id===quoteV1,r.status);const quoteV2=r.json.data.id;
  r=await api('POST',`/api/quotes/${quoteV2}/revision-request`,{reason:'자재비를 다시 확인해주세요'},u2);check('타 소비자 견적결정 차단',r.status===403,r.status);
  r=await api('POST',`/api/quotes/${quoteV2}/revision-request`,{reason:'자재비를 다시 확인해주세요'},u1);check('소비자 수정요청 저장',r.status===200&&r.json.data.status==='revision_requested',r.status);
  r=await api('POST',`/api/quotes/${quoteV2}/revisions`,{items:[{name:'도배',price:1100000}]},p1);check('수정견적 v3 생성',r.status===200&&r.json.data.version===3,r.status);const quoteId=r.json.data.id;
  r=await api('POST',`/api/quotes/${quoteV2}/accept`,{},u1);check('이전 견적버전 수락 차단',r.status===409,r.status);
  r=await api('POST',`/api/quotes/${quoteId}/accept`,{},u1);check('최신 견적 소비자 수락',r.status===200&&r.json.data.status==='accepted',r.status);
  r=await api('GET',`/api/quote-requests/${requestId}/quotes`,null,u2);check('타 소비자 견적조회 차단',r.status===403,r.status);
  r=await api('POST','/api/contracts',{quoteId,deposit:110000,down:330000,middle:330000,final:330000},u2);check('타 소비자 계약생성 차단',r.status===403,r.status);
  // 신규(사용자요청 — 감사보고서 지적사항 7순위: 결제 관련 코드 검증) 계약금 합계가 견적총액과 다르면 차단
  r=await api('POST','/api/contracts',{quoteId,deposit:100000,down:100000,middle:100000,final:100000},u1);check('계약금 합계 불일치시 계약생성 차단',r.status===400,r.status);
  r=await api('POST','/api/contracts',{quoteId,deposit:110000,down:330000,middle:330000,final:330000},u1);check('수락견적 ID 체인 계약생성',r.status===200,r.status);const contractId=r.json.data.id;
  r=await api('GET','/api/contracts/mine',null,u1);const contractRow=r.json.data.find(x=>x.id===contractId);check('계약 견적버전·스냅샷 고정',r.status===200&&contractRow.quote_version===3&&JSON.parse(contractRow.quote_snapshot).total_amount===1100000,r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/contract-confirmed`,{contractId},p1);check('파트너 계약최종확인 위조 차단',r.status===403,r.status);
  r=await api('POST',`/api/meas-jobs/${roomId}/contract-confirmed`,{contractId},u1);check('소비자 계약확정 상태연결',r.status===200&&r.json.data.status==='contract_confirmed',r.status);
  r=await api('POST','/api/contracts',{quoteId,deposit:110000,down:330000,middle:330000,final:330000},u1);check('중복 계약 차단',r.status===409,r.status);
  r=await api('POST','/api/disputes',{contractId,type:'quality',reason:'테스트'},u2);check('타 소비자 분쟁 차단',r.status===403,r.status);
  r=await api('POST','/api/disputes',{contractId,type:'quality',reason:'테스트'},u1);check('계약 소비자 분쟁 접수',r.status===200,r.status);
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구','경기 성남시']},p1);check('활동지역 2곳 저장',r.status===200&&r.json.data.serviceRegions.length===2,r.status);
  r=await api('GET','/api/partners/search?region='+encodeURIComponent('경기 성남시'));check('보조 활동지역 검색 반영',r.status===200&&r.json.data.some(x=>x.id==='p1'),r.status);

  // 신규(사용자요청 — 감사보고서 지적사항 5순위: 활동지역 5개 경계값 전체검증)
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구']},p1);check('활동지역 1개 저장',r.status===200&&r.json.data.serviceRegions.length===1,r.status);
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구','서울 서초구','서울 송파구','서울 용산구','서울 마포구']},p1);
  check('활동지역 정확히 5개 저장',r.status===200&&r.json.data.serviceRegions.length===5,r.status);
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구','서울 서초구','서울 송파구','서울 용산구','서울 마포구','서울 종로구']},p1);
  check('활동지역 6개 차단',r.status===400,r.status);
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:[]},p1);check('활동지역 최소1개 미만 차단',r.status===400,r.status);
  // 같은 지역 중복 입력시 정규화(중복제거)되어 저장 — 거부가 아니라 안전하게 1개로 합쳐짐
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구','서울 강남구','서울 강남구']},p1);
  check('활동지역 중복입력 정규화(1개로 합쳐짐)',r.status===200&&r.json.data.serviceRegions.length===1,r.status);
  // 대표지역 지정: 배열의 첫 항목이 대표지역(isPrimary)이 되는 구조
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구','경기 성남시','서울 마포구']},p1);
  check('대표지역 지정(첫 항목)',r.status===200&&r.json.data.serviceRegions[0].isPrimary===1&&r.json.data.serviceRegions[0].regionCode==='서울 강남구',JSON.stringify(r.json.data.serviceRegions));
  // 대표지역 변경: 순서를 바꿔서 다시 저장하면 새 첫 항목이 대표지역이 됨
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['경기 성남시','서울 강남구','서울 마포구']},p1);
  check('대표지역 변경(순서변경으로)',r.status===200&&r.json.data.serviceRegions[0].isPrimary===1&&r.json.data.serviceRegions[0].regionCode==='경기 성남시',JSON.stringify(r.json.data.serviceRegions));
  // 지역 삭제·추가: 기존 3개 중 1개 빼고 새 지역 추가
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['경기 성남시','서울 종로구']},p1);
  check('활동지역 삭제·추가(3개→2개, 새지역 포함)',r.status===200&&r.json.data.serviceRegions.length===2&&r.json.data.serviceRegions.some(x=>x.regionCode==='서울 종로구')&&!r.json.data.serviceRegions.some(x=>x.regionCode==='서울 마포구'),JSON.stringify(r.json.data.serviceRegions));
  // 마이페이지 새로고침 후 복원: GET /api/partners/me로 재조회해도 동일하게 유지
  r=await api('GET','/api/partners/me',null,p1);
  check('마이페이지 새로고침 후 활동지역 복원',r.status===200&&r.json.data.serviceRegions.length===2&&r.json.data.serviceRegions.some(x=>x.regionCode==='서울 종로구'),JSON.stringify(r.json.data.serviceRegions));
  // 모든 활동지역이 소비자 검색에 반영(대표지역 아닌 지역도 검색되어야 함)
  r=await api('GET','/api/partners/search?region='+encodeURIComponent('서울 종로구'));check('모든 활동지역이 검색에 반영',r.status===200&&r.json.data.some(x=>x.id==='p1'),r.status);
  // 다른 업체(p2)의 활동지역을 p1 권한으로 수정 시도 — 애초에 이 API는 본인(req.user.sub) 것만 수정하므로
  // p1으로 호출하면 p1 자신의 지역만 바뀌고 p2에는 영향이 없어야 함(교차오염 확인)
  const p2RegionsBefore=await api('GET','/api/partners/me',null,p2);
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구']},p1);
  const p2RegionsAfter=await api('GET','/api/partners/me',null,p2);
  check('다른 업체 활동지역 교차오염 없음',JSON.stringify(p2RegionsBefore.json.data.serviceRegions)===JSON.stringify(p2RegionsAfter.json.data.serviceRegions),'p1 수정이 p2에 영향없음');

  // 신규(사용자요청 — 감사보고서 지적사항 6순위: 개인정보·증빙자료 접근권한 실제시험)
  r=await api('GET','/api/partners/p1');
  const publicPartnerKeys=Object.keys(r.json.data||{});
  check('공개 파트너API 사업자번호 차단',!('business_reg_number' in r.json.data),JSON.stringify(publicPartnerKeys));
  check('공개 파트너API 로그인이메일 차단',!('login_id' in r.json.data),JSON.stringify(publicPartnerKeys));
  check('공개 파트너API 전화번호 차단',!('phone' in r.json.data),JSON.stringify(publicPartnerKeys));
  check('공개 파트너API 증빙파일ID(doc_image_url) 차단',!('doc_image_url' in r.json.data),JSON.stringify(publicPartnerKeys));
  check('공개 파트너API CI해시 차단',!('ci_hash' in r.json.data),JSON.stringify(publicPartnerKeys));
  r=await api('GET','/api/admin/files/nonexistent-id',null,null);check('일반사용자(비로그인) 증빙파일 열람 차단',r.status===401,r.status);
  r=await api('GET','/api/admin/files/nonexistent-id',null,u2);check('일반사용자(소비자토큰) 증빙파일 열람 차단',r.status===403,r.status);

  // 신규(사용자요청 — 감사보고서 지적사항 7순위: 결제 코드 정직한 재검증)
  r=await api('POST',`/api/contracts/${contractId}/payments`,{installmentType:'deposit'},u2);check('결제시작 — 타 소비자 차단',r.status===403,r.status);
  r=await api('POST',`/api/contracts/${contractId}/payments`,{installmentType:'deposit'},u1);
  check('결제시작 — 결제설정 미완료시 정직한 503(가짜성공 아님)',r.status===503,r.status);
  // 결제완료 상태를 DB에 직접 만들어(PortOne 실제결제 없이) 중복결제 차단 로직만 검증
  // (앞선 503 테스트에서 이미 payment 레코드가 생성되어 있으므로 UPDATE로 처리)
  const db3=new Database(dbPath);
  db3.prepare(`UPDATE payments SET status='paid' WHERE contract_id=? AND installment_type='deposit'`).run(contractId);
  db3.close();
  r=await api('POST',`/api/contracts/${contractId}/payments`,{installmentType:'deposit'},u1);check('이미 결제된 회차 재결제 차단',r.status===409,r.status);
  r=await api('POST','/api/webhooks/toss/payment',{data:{paymentKey:'nonexistent-payment-key'}});check('웹훅 — 존재하지않는 결제키는 조용히 무시(정상200, 시크릿키 미설정시)',r.status===200&&r.json.data&&r.json.data.ignored===true,r.status);
  r=await api('GET','/api/notifications/mine',null,p1);check('파트너 알림 DB 저장',r.status===200&&r.json.data.items.some(x=>x.type==='quote_request'),r.status);
  // 신규(사용자요청 — 감사보고서 지적사항 2순위: 메신저 첨부파일 자동시험 추가)
  function buildMultipart(fields,fileField,filename,mime,data){
    const boundary='----attach'+Date.now();let parts=[];
    for(const [k,v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
    parts.push(data);parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return {body:Buffer.concat(parts),contentType:`multipart/form-data; boundary=${boundary}`};
  }
  async function apiMultipart(url,multipart,auth){
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method:'POST',headers:{'content-type':multipart.contentType,...(auth?{authorization:`Bearer ${auth}`}:{})},body:multipart.body});
    return {status:response.status,json:await response.json().catch(()=>({}))};
  }
  const jpegHeader=Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
  const pngHeader=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0,0,0,0]);
  let mp=buildMultipart({roomId},'file','test.jpg','image/jpeg',jpegHeader);
  // 결함수정(사용자요청 — 사업자등록증 등 첨부 시 "객체 저장소 환경변수가 설정되지 않았습니다"
  // 오류가 계속 발생): storage.js에 OBJECT_STORAGE_BUCKET 미설정시의 로컬 디스크 폴백을 추가해
  // 항상 실제로 업로드가 동작하도록 고쳤다. 이 테스트는 원래 "가짜로 성공한 척하지 않고 정직하게
  // 503을 던지는지"를 검증했는데, 이제는 계약이 바뀌어 "실제로 저장되고 실제로 재조회까지 되는지"를
  // 검증해야 같은 취지(가짜성공 금지)를 지킬 수 있다 — 200만 확인하고 끝내면 그게 오히려 새로운
  // 가짜성공 허용이 되므로, 업로드 응답 형태와 실제 바이트 재조회까지 함께 검증한다.
  r=await apiMultipart(`/api/rooms/${roomId}/attachments`,mp,u1);
  check('로컬 폴백 저장소 — 실제 업로드 성공(가짜성공 아닌 진짜 저장)',r.status===200&&r.json.success&&r.json.data&&r.json.data.attachment&&typeof r.json.data.attachment.id==='string'&&r.json.data.attachment.id.length>0&&r.json.data.attachment.mimeType==='image/jpeg'&&r.json.data.attachment.sizeBytes===jpegHeader.length,JSON.stringify(r.json));
  const localFallbackAttachmentUrl=r.json.data.attachment.url;
  const downloadResponse=await fetch(`http://127.0.0.1:${port}${localFallbackAttachmentUrl}`,{headers:{authorization:`Bearer ${u1}`}});
  const downloadedBytes=Buffer.from(await downloadResponse.arrayBuffer());
  check('로컬 폴백 저장소 — 업로드한 파일이 실제로 재조회되고 바이트 일치(가짜성공 아님)',downloadResponse.status===200&&downloadResponse.headers.get('content-type')==='image/jpeg'&&downloadedBytes.equals(jpegHeader),{status:downloadResponse.status,contentType:downloadResponse.headers.get('content-type'),len:downloadedBytes.length});
  mp=buildMultipart({roomId},'file','test.jpg','image/jpeg',jpegHeader);
  r=await apiMultipart(`/api/rooms/${roomId}/attachments`,mp,u2);check('첨부 비참여자 업로드 차단',r.status===403,r.status);
  mp=buildMultipart({roomId},'file','evil.svg','image/svg+xml',Buffer.from('<svg onload="alert(1)"></svg>'));
  r=await apiMultipart(`/api/rooms/${roomId}/attachments`,mp,u1);check('첨부 SVG 차단',r.status===400,r.status);
  mp=buildMultipart({roomId},'file','fake.jpg','image/jpeg',pngHeader);
  r=await apiMultipart(`/api/rooms/${roomId}/attachments`,mp,u1);check('첨부 선언MIME 위조 차단',r.status===400,r.status);
  r=await api('POST',`/api/rooms/${roomId}/messages`,{type:'image',attachmentId:'nonexistent-id'},u1);check('첨부 존재하지않는 attachmentId 차단',r.status===403,r.status);

  // 신규(사용자요청 — 감사보고서 지적사항 3순위: WebSocket 실시간 메신저 자동시험 추가)
  function connectWs(tok){ return new WebSocket(`ws://127.0.0.1:${port}/api/realtime?token=${encodeURIComponent(tok)}`); }
  function waitOpenOrClose(ws){ return new Promise(resolve=>{ let done=false; ws.on('open',()=>{if(!done){done=true;resolve('open');}}); ws.on('close',()=>{if(!done){done=true;resolve('close');}}); ws.on('error',()=>{if(!done){done=true;resolve('error');}}); setTimeout(()=>{if(!done){done=true;resolve('timeout');}},2000); }); }
  function collectMessages(ws,ms){ const arr=[]; ws.on('message',d=>{try{arr.push(JSON.parse(d.toString()));}catch(e){}}); return new Promise(resolve=>setTimeout(()=>resolve(arr),ms)); }

  // 1) 소비자+파트너 동시접속, REST 메시지가 둘 다에게 즉시 도착
  const wsU1=connectWs(u1),wsP1=connectWs(p1);
  await Promise.all([waitOpenOrClose(wsU1),waitOpenOrClose(wsP1)]);
  wsU1.send(JSON.stringify({type:'subscribe',roomId,sinceSeq:0}));
  wsP1.send(JSON.stringify({type:'subscribe',roomId,sinceSeq:0}));
  await new Promise(res=>setTimeout(res,300));
  const u1Msgs=[],p1Msgs=[];
  wsU1.on('message',d=>{try{u1Msgs.push(JSON.parse(d.toString()));}catch(e){}});
  wsP1.on('message',d=>{try{p1Msgs.push(JSON.parse(d.toString()));}catch(e){}});
  await api('POST',`/api/rooms/${roomId}/messages`,{text:'WS 실시간 테스트'},u1);
  await new Promise(res=>setTimeout(res,400));
  check('WebSocket 소비자 실시간수신',u1Msgs.some(m=>m.type==='message'&&m.message.text==='WS 실시간 테스트'),JSON.stringify(u1Msgs).slice(0,120));
  check('WebSocket 파트너 실시간수신',p1Msgs.some(m=>m.type==='message'&&m.message.text==='WS 실시간 테스트'),JSON.stringify(p1Msgs).slice(0,120));

  // 2) 비참여자(u2)는 roomId를 구독해도 메시지를 못 받음
  const wsU2=connectWs(u2);await waitOpenOrClose(wsU2);
  const u2Msgs=[];wsU2.on('message',d=>{try{u2Msgs.push(JSON.parse(d.toString()));}catch(e){}});
  wsU2.send(JSON.stringify({type:'subscribe',roomId,sinceSeq:0}));
  await new Promise(res=>setTimeout(res,300));
  await api('POST',`/api/rooms/${roomId}/messages`,{text:'비참여자 차단 테스트'},u1);
  await new Promise(res=>setTimeout(res,400));
  check('WebSocket 비참여자 구독 무시(메시지 미수신)',!u2Msgs.some(m=>m.type==='message'&&m.message.text==='비참여자 차단 테스트'),JSON.stringify(u2Msgs).slice(0,120));

  // 3) Room A 메시지가 Room B(roomBId)에 전달되지 않음(Room 간 격리)
  const wsU2b=connectWs(u2);await waitOpenOrClose(wsU2b);
  const u2bMsgs=[];wsU2b.on('message',d=>{try{u2bMsgs.push(JSON.parse(d.toString()));}catch(e){}});
  wsU2b.send(JSON.stringify({type:'subscribe',roomId:roomBId,sinceSeq:0}));
  await new Promise(res=>setTimeout(res,300));
  await api('POST',`/api/rooms/${roomId}/messages`,{text:'Room격리 테스트'},u1);
  await new Promise(res=>setTimeout(res,400));
  check('Room간 메시지 격리(Room A 메시지가 Room B로 안 감)',!u2bMsgs.some(m=>m.type==='message'&&m.message.text==='Room격리 테스트'),JSON.stringify(u2bMsgs).slice(0,120));
  wsU2b.close();wsU2.close();

  // 4) 연결이 끊긴 뒤 sinceSeq로 누락 메시지 복구 + 메시지 순서 유지
  const lastSeqBefore=Math.max(...u1Msgs.filter(m=>m.type==='message').map(m=>m.message.seq),0);
  wsU1.close();wsP1.close();
  await new Promise(res=>setTimeout(res,200));
  await api('POST',`/api/rooms/${roomId}/messages`,{text:'끊긴동안 메시지1'},u1);
  await api('POST',`/api/rooms/${roomId}/messages`,{text:'끊긴동안 메시지2'},p1);
  const wsU1b=connectWs(u1);await waitOpenOrClose(wsU1b);
  const recovered=[];wsU1b.on('message',d=>{try{recovered.push(JSON.parse(d.toString()));}catch(e){}});
  wsU1b.send(JSON.stringify({type:'subscribe',roomId,sinceSeq:lastSeqBefore}));
  await new Promise(res=>setTimeout(res,500));
  const recoveredTexts=recovered.filter(m=>m.type==='message').map(m=>m.message.text);
  check('재접속시 누락메시지 복구',recoveredTexts.includes('끊긴동안 메시지1')&&recoveredTexts.includes('끊긴동안 메시지2'),JSON.stringify(recoveredTexts));
  const recoveredSeqs=recovered.filter(m=>m.type==='message').map(m=>m.message.seq);
  const sortedSeqs=[...recoveredSeqs].sort((a,b)=>a-b);
  check('메시지 순서 유지(seq 오름차순)',JSON.stringify(recoveredSeqs)===JSON.stringify(sortedSeqs),JSON.stringify(recoveredSeqs));

  // 5) 읽음 이벤트 실시간 전달
  const readEvents=[];wsU1b.on('message',d=>{try{const parsed=JSON.parse(d.toString());if(parsed.type==='read')readEvents.push(parsed);}catch(e){}});
  const wsP1b=connectWs(p1);await waitOpenOrClose(wsP1b);
  wsP1b.send(JSON.stringify({type:'subscribe',roomId,sinceSeq:0}));
  await new Promise(res=>setTimeout(res,300));
  const msgRow=await api('GET',`/api/rooms/${roomId}/messages`,null,u1);
  const anySeq=msgRow.json.data[msgRow.json.data.length-1].seq;
  await api('POST',`/api/rooms/${roomId}/read`,{lastReadSeq:anySeq},p1);
  await new Promise(res=>setTimeout(res,400));
  check('읽음 이벤트 실시간 전달',readEvents.some(e=>e.roomId===roomId),JSON.stringify(readEvents).slice(0,150));
  wsU1b.close();wsP1b.close();

  // 6) 과대 프레임(64KB 초과)이 서버 전체를 종료하지 않음(서버 생존 확인)
  const wsBig=connectWs(u1);await waitOpenOrClose(wsBig);
  wsBig.send(JSON.stringify({type:'subscribe',roomId,sinceSeq:0,junk:'x'.repeat(100*1024)}));
  await new Promise(res=>setTimeout(res,500));
  r=await api('GET','/api/notifications/mine',null,p1);check('과대프레임 이후 서버 생존(정상응답)',r.status===200,r.status);

  // 7) 반려된 파트너(p3) 연결 차단
  const wsP3=connectWs(token('p3','partner'));
  const p3Result=await waitOpenOrClose(wsP3);
  check('반려된 파트너 WebSocket 연결 차단',p3Result!=='open',p3Result);

  // 8) 만료된 JWT 연결 차단
  const expiredTok=jwt.sign({sub:'u1',role:'consumer'},secret,{expiresIn:'-10s'});
  const wsExpired=connectWs(expiredTok);
  const expiredResult=await waitOpenOrClose(wsExpired);
  check('만료된 JWT WebSocket 연결 차단',expiredResult!=='open',expiredResult);

  // 9) 탈퇴한 소비자 연결 차단(u1을 탈퇴 처리한 뒤 접속 시도) — 다른 시험에 영향 없도록 마지막에 수행
  await api('DELETE','/api/users/me',null,u1);
  const wsWithdrawn=connectWs(u1);
  const withdrawnResult=await waitOpenOrClose(wsWithdrawn);
  check('탈퇴한 소비자 WebSocket 연결 차단',withdrawnResult!=='open',withdrawnResult);

  // 신규(사용자요청 — 감사보고서 지적사항 4순위: 파트너가입→관리자심사 전체 E2E)
  // 외부 PortOne/NTS 계약이 없어 실제 검증 API는 호출하지 못하므로, 그 검증이 통과했을 때
  // 서버가 발급하는 것과 동일한 형식의 자체서명 토큰으로 이후 단계(대표자명 일치, 위임증빙,
  // 관리자 심사 전체 흐름)를 검증한다(실제 NTS/PortOne 연동 자체는 NOT TESTABLE로 별도 기록).
  const db2 = new Database(dbPath);
  function e2eOtpCode(email,purpose){ const code=String(Math.floor(100000+Math.random()*900000)); db2.prepare('INSERT INTO otp_codes (id, target, code, expires_at, purpose) VALUES (?,?,?,?,?)').run(qaRandomUUID(),email,require('bcryptjs').hashSync(code,10),new Date(Date.now()+300000).toISOString(),purpose); return code; }
  async function e2eSignupToken(email){ const code=e2eOtpCode(email,'partner_signup'); const res=await api('POST','/api/otp/email/verify',{email,code,forPartner:true,partnerMode:'signup'}); return res.json.data.token; }
  function e2eBizDoc(email){ const fid=qaRandomUUID(); db2.prepare(`INSERT INTO stored_files (id,storage_key,owner_type,owner_id,purpose,mime_type,size_bytes,visibility) VALUES (?,?,?,?,?,?,?,?)`).run(fid,'test/'+fid,'partner_signup',email,'business_registration','image/jpeg',100,'private'); return fid; }
  function e2eAuthDoc(email){ const fid=qaRandomUUID(); db2.prepare(`INSERT INTO stored_files (id,storage_key,owner_type,owner_id,purpose,mime_type,size_bytes,visibility) VALUES (?,?,?,?,?,?,?,?)`).run(fid,'test/'+fid,'partner_signup',email,'authorization','image/jpeg',100,'private'); return fid; }
  function e2eIdentityToken(email,applicantName){ const vid=qaRandomUUID(); db2.prepare(`INSERT INTO partner_identity_verifications (id,login_id,provider,provider_verification_id,applicant_name,status,verified_at) VALUES (?,?,?,?,?,?,datetime('now'))`).run(vid,email,'test','test-'+vid,applicantName,'verified'); return jwt.sign({role:'partner_identity_verification',loginId:email,verificationId:vid},secret,{expiresIn:'10m'}); }
  function e2eBizToken(bizNo,ceoName){ return jwt.sign({role:'partner_business_verification',bizNo:bizNo.replace(/\D/g,''),ceoName},secret,{expiresIn:'10m'}); }

  const adminId=qaRandomUUID();
  db2.prepare('INSERT INTO admins (id, email, password_hash, role) VALUES (?,?,?,?)').run(adminId,'e2e-admin@roomer.com',require('bcryptjs').hashSync('E2ePass1234!',10),'super');
  r=await api('POST','/api/admin/auth/login',{email:'e2e-admin@roomer.com',password:'E2ePass1234!'});const adminTok=r.json.data.token;

  // 신규(사용자요청 — 본인확인 온오프 정책 검증): 기본값(false)에서는 본인확인 없이도 가입
  // 가능해야 하며, 관리자가 정책을 켜면(true) 아래 E2E 시나리오(이름불일치 등)가 다시 작동해야 함
  r=await api('PUT','/api/admin/policy',{key:'identity_verification_required',value:true},adminTok);
  check('본인확인 정책 켜기(관리자)',r.status===200,r.status);
  r=await api('GET','/api/public/policy/identity-verification-required',null,null);
  check('본인확인 정책 공개API 즉시반영',r.status===200&&r.json.data.required===true,JSON.stringify(r.json));

  // 5순위 활동지역 검증의 일부: 관리자 심사화면에 활동지역(최대5개) 표시 확인(adminTok 준비된 이후 수행)
  r=await api('PUT','/api/partners/me/service-regions',{serviceRegions:['서울 강남구','서울 서초구','서울 송파구','서울 용산구','서울 마포구']},p1);
  r=await api('GET','/api/admin/partners/p1/review',null,adminTok);
  check('관리자 심사화면 활동지역(5개) 표시',r.status===200&&r.json.data.serviceRegions&&r.json.data.serviceRegions.length===5,JSON.stringify(r.json.data.serviceRegions||'none'));

  const e2eBase={businessName:'E2E검증업체',businessRegNumber:'666-66-66661',ceoName:'김대표',region:'서울 강남구',postalCode:'06134',roadAddress:'서울 강남구 테헤란로 152',addressDetail:'1층',verificationConsents:{business:true,identity:true,review:true}};

  const e2eEmail1='e2e-partner1@test.com';
  const e2eSignup1=await e2eSignupToken(e2eEmail1);
  const e2eDoc1=e2eBizDoc(e2eEmail1);
  r=await api('POST','/api/partners/register',{...e2eBase,docImageUrl:e2eDoc1},e2eSignup1);check('파트너가입 E2E: 토큰없이 가입 차단',r.status===403,r.status);

  const e2eBizTok1=e2eBizToken(e2eBase.businessRegNumber,e2eBase.ceoName);
  const e2eIdTokWrong=e2eIdentityToken(e2eEmail1,'박다른사람');
  r=await api('POST','/api/partners/register',{...e2eBase,docImageUrl:e2eDoc1,businessVerificationToken:e2eBizTok1,identityVerificationToken:e2eIdTokWrong},e2eSignup1);check('파트너가입 E2E: 대표자명 불일치 차단',r.status===403,r.status);

  const e2eEmail3='e2e-partner3@test.com';
  const e2eSignup3=await e2eSignupToken(e2eEmail3);
  const e2eDoc3=e2eBizDoc(e2eEmail3);
  const e2eBizTok3=e2eBizToken('666-66-66663','실제대표');
  const e2eIdTok3=e2eIdentityToken(e2eEmail3,'담당자이름');
  r=await api('POST','/api/partners/register',{...e2eBase,businessRegNumber:'666-66-66663',ceoName:'실제대표',docImageUrl:e2eDoc3,businessVerificationToken:e2eBizTok3,identityVerificationToken:e2eIdTok3,applicantRole:'manager'},e2eSignup3);check('파트너가입 E2E: 담당자 위임증빙 없으면 차단',r.status===400,r.status);
  const e2eAuthDoc3=e2eAuthDoc(e2eEmail3);
  r=await api('POST','/api/partners/register',{...e2eBase,businessRegNumber:'666-66-66663',ceoName:'실제대표',docImageUrl:e2eDoc3,businessVerificationToken:e2eBizTok3,identityVerificationToken:e2eIdTok3,applicantRole:'manager',authorizationDocUrl:e2eAuthDoc3},e2eSignup3);check('파트너가입 E2E: 담당자 위임증빙 있으면 성공',r.status===200,r.status);

  const e2eIdTok1=e2eIdentityToken(e2eEmail1,e2eBase.ceoName);
  r=await api('POST','/api/partners/register',{...e2eBase,docImageUrl:e2eDoc1,businessVerificationToken:e2eBizTok1,identityVerificationToken:e2eIdTok1},e2eSignup1);
  check('파트너가입 E2E: 정상가입 성공(pending)',r.status===200&&r.json.data.verifyStatus==='pending',r.status);
  const e2ePartnerId=r.json.data.id,e2ePartnerTok=r.json.data.token;

  r=await api('GET','/api/admin/partners/pending',null,adminTok);check('파트너가입 E2E: 관리자 pending목록 표시',r.status===200&&r.json.data.some(p=>p.id===e2ePartnerId),r.status);
  r=await api('GET',`/api/admin/partners/${e2ePartnerId}/review`,null,adminTok);check('파트너가입 E2E: 심사상세 표시',r.status===200&&JSON.stringify(r.json.data).includes('강남'),r.status);
  r=await api('GET','/api/partners/search?region='+encodeURIComponent('서울 강남구'));check('파트너가입 E2E: 승인전 검색 미노출',!r.json.data.some(p=>p.id===e2ePartnerId),r.status);
  r=await api('POST','/api/quote-requests',{partnerId:e2ePartnerId,address:'서울',pyeong:20,spaceType:'거실'},u2);check('파트너가입 E2E: 승인전 견적요청 차단',r.status===409,r.status);
  r=await api('PUT',`/api/admin/partners/${e2ePartnerId}/approve`,{},u1);check('파트너가입 E2E: 관리자아닌사용자 승인차단',r.status===403||r.status===401,r.status);
  r=await api('PUT',`/api/admin/partners/${e2ePartnerId}/approve`,{},adminTok);check('파트너가입 E2E: 관리자 승인 성공',r.status===200,r.status);
  r=await api('GET','/api/partners/search?region='+encodeURIComponent('서울 강남구'));check('파트너가입 E2E: 승인후 검색 노출',r.json.data.some(p=>p.id===e2ePartnerId),r.status);
  r=await api('POST','/api/quote-requests',{partnerId:e2ePartnerId,address:'서울',pyeong:20,spaceType:'거실'},u2);check('파트너가입 E2E: 승인후 견적요청 성공',r.status===200,r.status);
  r=await api('PUT',`/api/admin/partners/${e2ePartnerId}/reject`,{reason:'사업자등록증 사진이 흐릿합니다'},adminTok);check('파트너가입 E2E: 관리자 반려 성공',r.status===200,r.status);
  r=await api('GET','/api/partners/me',null,e2ePartnerTok);check('파트너가입 E2E: 반려사유 파트너화면 표시',r.json.data.reject_reason==='사업자등록증 사진이 흐릿합니다',r.status);
  check('파트너가입 E2E: 반려후 verify_status=rejected',r.json.data.verify_status==='rejected',JSON.stringify(r.json.data).slice(0,80));
  r=await api('PUT',`/api/admin/partners/${e2ePartnerId}/reject`,{reason:'악의적시도'},u1);check('파트너가입 E2E: 관리자아닌사용자 반려차단',r.status===403||r.status===401,r.status);
  db2.close();

  // ---- 신규: 지역기반 서비스 — 좌표→지역 변환(GET /api/geo/reverse), 활성지역 저장(PUT /api/users/me/region) ----
  // 이 서버는 GEO_TEST_MODE/KAKAO_REST_API_KEY 둘 다 설정하지 않은 채로 떠 있다(운영에서 카카오 키를
  // 아직 안 넣은 상태와 동일) — 이 상태에서 가짜 지역을 지어내지 않고 정직하게 503으로 막히는지,
  // 그리고 입력값 검증이 카카오 호출 전에 먼저 걸러지는지를 검증한다. 실제 카카오 API 자체는
  // 이 샌드박스의 외부망 차단·키 미보유로 호출 자체가 불가능해 NOT TESTABLE로 남긴다(정직하게 기록).
  r=await api('GET','/api/geo/reverse?lat=abc&lng=127');check('지역변환: 좌표 형식이 아니면 400',r.status===400,r.status);
  r=await api('GET','/api/geo/reverse?lat=60&lng=127');check('지역변환: 대한민국 범위 밖 좌표는 400',r.status===400,r.status);
  // u1은 앞선 WebSocket 탈퇴 시나리오에서 이미 탈퇴 처리됐으므로, 이 구간은 새 소비자 계정으로 검증한다.
  const dbGeo=new Database(dbPath);
  dbGeo.exec(`INSERT INTO users(id,social_provider,social_id,nickname) VALUES ('u_geo1','qa','u_geo1','지역테스트소비자');`);
  dbGeo.close();
  const uGeo1=token('u_geo1','consumer');
  r=await api('PUT','/api/users/me/region',{region:'서울 강남구'},uGeo1);check('활성지역 저장 성공',r.status===200&&r.json.data.region==='서울 강남구',r);
  r=await api('GET','/api/users/me',null,uGeo1);check('저장한 활성지역이 프로필에 반영됨',r.status===200&&r.json.data.region==='서울 강남구',r);
  r=await api('PUT','/api/users/me/region',{region:'강남구'},uGeo1);check('활성지역 형식(시도+시군구) 미충족시 차단',r.status===400,r.status);
  r=await api('PUT','/api/users/me/region',{region:null},uGeo1);check('활성지역 해제(null) 성공',r.status===200&&r.json.data.region===null,r);
  r=await api('GET','/api/users/me',null,uGeo1);check('활성지역 해제가 프로필에 반영됨',r.status===200&&r.json.data.region===null,r);
  r=await api('PUT','/api/users/me/region',{region:'서울 강남구'},p1);check('파트너 계정은 활성지역 저장 불가(소비자 전용)',r.status===403,r.status);

  console.log(JSON.stringify({passed:results.length,failed:0,results},null,2));
}catch(error){console.error(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:1,error:error.message,results},null,2));process.exitCode=1;}finally{server.kill('SIGTERM');for(const suffix of ['', '-wal','-shm']){try{fs.unlinkSync(dbPath+suffix);}catch(_){}}}})();
