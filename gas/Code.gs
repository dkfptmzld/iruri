/* 이루리 정산 시스템 — Google Apps Script 백엔드
 *
 * ═══ 2026-08 속도 개선판 ═══
 * 바뀐 곳은 [속도] 로 표시했습니다. 그 외 동작은 기존과 100% 동일합니다.
 *
 *  1. [속도] 스프레드시트 핸들 재사용
 *     getSheet() 가 호출될 때마다 SpreadsheetApp.openById() 를 다시 하고 있었습니다.
 *     한 번만 열고 재사용합니다.
 *
 *  2. [속도] 버전 확인 → 안 바뀌었으면 안 보냄  ★가장 큰 효과
 *     getCenters / getTeachers 는 매번 시트 전체(센터 278행 × 14열)를 읽어
 *     수백 KB 를 내려보내고 있었습니다. 실제로는 하루에 몇 번밖에 안 바뀌는데도요.
 *     → 강사DB·센터DB 가 바뀔 때마다 '버전 번호'를 1씩 올립니다.
 *       앱이 ?v=<가지고 있는 버전> 을 같이 보내고, 서버 버전과 같으면
 *       시트를 읽지도 않고 {ok:true, unchanged:true} 만 돌려줍니다(약 50바이트).
 *     ※ 앱이 v 를 안 보내면(구버전 앱) 예전처럼 전체를 그대로 내려줍니다 — 호환됨.
 *
 *  3. [속도] 내용이 같으면 시트를 다시 쓰지 않음
 *     syncTeachers / syncCenters 는 호출될 때마다 clearContents() 후
 *     전체를 다시 썼습니다(센터 278행 × 14열 = 약 3,900칸). 내용이 똑같아도요.
 *     → 쓸 내용의 지문(해시)을 저장해두고, 같으면 건너뜁니다.
 *       (시트 행 수가 달라졌으면 = 누가 손으로 고쳤으면, 지문이 같아도 다시 씁니다)
 *
 * ═══ 2026-09 속도 개선 2탄 — 월별 정산 기록(스냅샷) ═══
 * 바뀐 곳은 [속도 2] 로 표시했습니다. 저장 규칙(빈 데이터 거부·단조성·급감 차단·롤링 백업)은 그대로입니다.
 *
 *  4. [속도 2] 월 스냅샷을 구글 '캐시'에 담아두고 바로 내려줌  ★다른 관리자 PC가 느리던 문제
 *     예전: 요청이 올 때마다 드라이브에서 폴더 3번 찾기 → 파일 찾기 → 파일 읽기 → JSON 해석/재조립.
 *     이제: 한 번 읽은 달은 CacheService(구글이 주는 빠른 임시 저장소)에 압축해서 6시간 보관.
 *           같은 달을 다시 요청하면 드라이브를 안 건드리고 바로 돌려줍니다.
 *     · 그 달이 저장/삭제/복구되면 '달별 버전'이 올라가서 옛 캐시는 자동으로 안 쓰입니다(항상 최신).
 *     · 캐시가 비었거나(구글이 비울 수 있음) 너무 크면 예전 방식으로 읽습니다 — 결과는 같음.
 *
 *  5. [속도 2] 앱이 가진 저장시각(?since=)이 서버와 같으면 → 데이터 없이 '안 바뀜'만 응답(약 80바이트)
 *     기존 PC가 달을 열 때마다 확인차 전체를 다시 받던 것을 줄여, 서버가 덜 붐비게 합니다.
 *     ※ 앱이 since 를 안 보내면(구버전 앱) 예전처럼 전체를 내려줍니다 — 호환됨.
 *
 *  6. [속도 2] 폴더·파일 위치를 기억
 *     '이루리' · '정산스냅샷' 폴더와 달별 파일의 ID를 스크립트 속성에 기억해서, 매번 이름으로 찾지 않습니다.
 *     (폴더를 지우거나 파일 이름이 바뀌면 자동으로 다시 찾습니다)
 *
 *  7. [속도 2] 월 목록(listMonthlySnapshots)도 캐시 — 저장/삭제 때 자동 갱신
 *
 * ── 되돌리려면 ──
 *   Apps Script 편집기 왼쪽 '버전 기록'에서 이전 버전을 다시 배포하거나,
 *   깃허브 저장소 gas/Code.gs 파일의 '이전 커밋' 내용을 붙여넣으면 원래대로 돌아갑니다.
 *   버전/지문/캐시는 스크립트 속성·캐시에만 저장되므로 시트·드라이브 데이터에는 영향이 없습니다.
 */

/* ⚠️ 이 저장소는 공개(GitHub Pages)라서 실제 스프레드시트 ID를 비워뒀습니다.
 *    붙여넣을 때는 아래 한 줄만 실제 값으로 바꾸세요.
 *    값은 스프레드시트 주소의  /d/  와  /edit  사이 문자열입니다.
 *    (기존 Apps Script 편집기에 있던 값을 그대로 쓰면 됩니다) */
const SPREADSHEET_ID   = '여기에_스프레드시트_ID_를_넣으세요';
const IRURI_ROOT       = '이루리';
const RECEIPTS_FOLDER  = '이루리_영수증';
const SNAPSHOTS_FOLDER = '정산스냅샷';
const SHEET_SUBMISSIONS = '제출데이터';
const SHEET_ACCOUNTS   = '강사계정';
const SHEET_HISTORY    = '제출이력';
const SHEET_RECEIPTS   = '영수증';
const SHEET_TEACHERS   = '강사DB';
const SHEET_CENTERS    = '센터DB';
const SHEET_PRESENCE   = '접속현황';
const SHEET_PENDING    = '가입대기';
const SHEET_SCHEDREQ   = '스케줄요청';   // v16.05: 강사 스케줄 수정요청
const SHEET_CTOMB      = '센터삭제기록';  // v16.20: 서버 공용 삭제기록(묘비) — 삭제한 센터가 다른 기기 캐시로 부활하는 것 방지
const SHEET_JOURNAL    = '프로그램일지';   // 계획서 도구: 프로그램 일지 누적(시트 탭 + 드라이브 폴더)

function response(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const p = e.parameter;
    const action = p.action;
    if (action === 'getSubmissions')       return response(getSubmissions());
    if (action === 'getHistory')           return response(getHistory(p.teacher));
    if (action === 'getReceipts')          return response(getReceipts(p.teacher, p.yearMonth));
    if (action === 'getTeachers')          return response(getTeachers(p.teacher, p.isAdmin, p.v));   // [속도] v = 앱이 가진 버전
    if (action === 'getCenters')           return response(getCenters(p.v));                          // [속도]
    if (action === 'getCenterTombs')       return response(getCenterTombs());                         // v16.20: 서버 삭제기록
    if (action === 'getMonthlySnapshot')   return snapshotOut_(p.yearMonth, p.since);                 // [속도 2] 캐시 + since
    if (action === 'getMonthlySnapshots')  return snapshotListOut_();                                 // [속도 2]
    if (action === 'listMonthlySnapshots') return snapshotListOut_();                                 // [속도 2]
    if (action === 'ping')                 return response({ ok: true, message: '이루리 서버 연결됨 v7.6' });
    if (action === 'getSystemSettings')    return response(getSystemSettings());
    if (action === 'getPresence')          return response(getPresence());
    if (action === 'getSettlementStatus')  return response(getSettlementStatus(p.teacher));
    if (action === 'getDbMeta')            return response(getDbMeta());
    if (action === 'getPendingSignups')    return response(getPendingSignups());
    if (action === 'getScheduleRequests')  return response(getScheduleRequests());   // v16.05
    if (action === 'getJournalRecords')    return response(getJournalRecords(p.center, p.teacher, p.year, p.month, p.region));   // 계획서 일지
    if (action === 'getDepositMappings')   return response(depGetMappings());                                                    // 계좌매칭: 매핑 조회
    if (action === 'getDepositRecords')    return response(depGetRecords());                                                     // 계좌매칭: 회차 입금내역 조회
    return response({ ok: false, message: '알 수 없는 action' });
  } catch (err) { return response({ ok: false, message: err.toString() }); }
}

function doPost(e) {
  var body, action;
  try { body = JSON.parse(e.postData.contents); action = body.action; }
  catch (err) { return response({ ok: false, message: '요청 파싱 실패' }); }
  // [안전 2단계] 쓰기 잠금 — 저장을 한 번에 하나씩만 처리(동시 저장 충돌 방지).
  //  접속현황·영수증 업로드처럼 '줄 추가만 하는(충돌 무해)' 동작은 잠금 없이 통과 → 강사 활동은 안 느려짐.
  var _NO_LOCK = { updatePresence: 1, removePresence: 1, uploadReceipt: 1 };
  var _lock = null;
  if (!_NO_LOCK[action]) {
    _lock = LockService.getScriptLock();
    try { _lock.waitLock(30000); }
    catch (e2) { return response({ ok: false, busy: true, message: '다른 저장이 처리 중이에요. 잠시 후 다시 시도해 주세요' }); }
  }
  try {
    if (action === 'submitRecord')          return response(submitRecord(body.data));
    if (action === 'signupAccount')         return response(signupAccount(body.teacher, body.hashedPw));
    if (action === 'loginCheck')            return response(loginCheck(body.teacher, body.hashedPw, body.legacyPw));
    if (action === 'deleteSubmission')      return response(deleteSubmission(body.teacher, body.yearMonth, body.submittedAt));
    if (action === 'uploadReceipt')         return response(uploadReceipt(body.teacher, body.yearMonth, body.fileName, body.base64, body.mimeType));
    if (action === 'saveTeacher')           return response(saveTeacher(body.teacher));
    if (action === 'deleteTeacher')         return response(deleteTeacher(body.name));
    if (action === 'saveCenter')            return response(saveCenter(body.center));
    if (action === 'deleteCenter')          return response(deleteCenter(body.name, body.region));
    if (action === 'removeCenterTomb')      { try { _removeCenterTombGas(body.name, body.region); } catch (e) {} return response({ ok: true }); }   // v16.20: 삭제기록 해제(관리/테스트용)
    if (action === 'syncTeachers')          return response(syncTeachers(body.teachers, body.force));
    if (action === 'syncCenters')           return response(syncCenters(body.centers, body.force));
    if (action === 'saveMonthlySnapshot')   return response(saveMonthlySnapshot(body.yearMonth, body.data, body.force, body.savedAt));
    if (action === 'deleteMonthlySnapshot') return response(deleteMonthlySnapshot(body.yearMonth));
    if (action === 'getMonthlySnapshots')   return response(getMonthlySnapshots());
    if (action === 'getMonthlySnapshot')    return response(getMonthlySnapshot(body.yearMonth));
    if (action === 'saveSystemSettings')    return response(saveSystemSettings(body.settings));
    if (action === 'updatePresence')        return response(updatePresence(body.teacher, body.page));
    if (action === 'removePresence')        return response(removePresence(body.teacher));
    if (action === 'finalizeSettlement')    return response(finalizeSettlement(body.teacher, body.yearMonth, body.note, body.notesData));
    if (action === 'signupRequest')         return response(signupRequest(body.data));
    if (action === 'approveSignup')         return response(approveSignup(body.name));
    if (action === 'rejectSignup')          return response(rejectSignup(body.name));
    if (action === 'submitScheduleRequest') return response(submitScheduleRequest(body));            // v16.05
    if (action === 'resolveScheduleRequest')return response(resolveScheduleRequest(body.id, body.status));   // v16.05
    if (action === 'saveJournalRecord')     return response(saveJournalRecord(body.data));            // 계획서 일지
    if (action === 'deleteJournalRecord')   return response(deleteJournalRecord(body.id));            // 계획서 일지 삭제
    if (action === 'combineJournalDocs')    return response(combineJournalDocs(body.ids));            // 계획서 일지 WORD 합치기
    if (action === 'zipJournalDocs')        return response(zipJournalDocs(body.ids));                // 계획서 일지 ZIP
    if (action === 'saveDepositMappings')   return response(depSaveMappings(body.mappings));         // 계좌매칭: 매핑 저장(전체 교체)
    if (action === 'saveDepositRecords')    return response(depSaveRecords(body.period, body.records)); // 계좌매칭: 회차 입금내역 저장

    return response({ ok: false, message: '알 수 없는 action' });
  } catch (err) { return response({ ok: false, message: err.toString() }); }
  finally { if (_lock) { try { _lock.releaseLock(); } catch (_e) {} } }
}

/* ════════ [속도] DB 버전 · 내용 지문 ════════
 *  버전(DBVER_xxx) : 강사DB/센터DB 가 실제로 바뀔 때마다 1씩 증가.
 *                    앱이 보낸 v 와 같으면 시트를 읽지 않고 unchanged 만 돌려준다.
 *  지문(DBHASH_xxx): 마지막으로 시트에 써넣은 내용의 해시.
 *                    같은 내용을 또 쓰라고 오면 시트 쓰기를 통째로 건너뛴다.
 *  행수(DBROWS_xxx): 누가 시트를 손으로 고쳤는지 확인용. 다르면 지문이 같아도 다시 쓴다.
 *  모두 스크립트 속성에만 저장 → 시트 데이터에는 영향 없음.
 */
function props_() { return PropertiesService.getScriptProperties(); }

function dbVersion_(kind) {
  const p = props_(), k = 'DBVER_' + kind;
  let v = p.getProperty(k);
  if (v === null || v === '') { v = '1'; p.setProperty(k, v); }
  return Number(v) || 1;
}
/* 주의: 반드시 dbVersion_() 를 거쳐 올린다.
 *  속성이 아직 없을 때 0+1=1 로 올려버리면, dbVersion_() 의 초기값(1)과 같아져
 *  '한 번도 동기화 안 한 상태'와 '첫 동기화를 마친 상태'가 같은 버전이 된다.
 *  그러면 앱이 옛 데이터를 들고도 unchanged 를 받아 갱신을 놓친다. */
function bumpDbVersion_(kind) {
  const v = dbVersion_(kind) + 1;
  props_().setProperty('DBVER_' + kind, String(v));
  return v;
}
/* 개별 행을 고쳤을 때 — 버전은 올리고, 전체 지문은 무효화(다음 전체 동기화는 반드시 다시 쓰도록) */
function touchDb_(kind) {
  bumpDbVersion_(kind);
  try { props_().deleteProperty('DBHASH_' + kind); } catch (e) {}
}
function contentHash_(rows) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(rows), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ((b & 0xFF) + 0x100).toString(16).slice(1); }).join('');
}

/* ════════ [속도] 스프레드시트 핸들 재사용 ════════
 *  기존에는 getSheet() 를 부를 때마다 openById() 를 다시 했다.
 *  한 번의 요청 안에서는 같은 핸들을 재사용한다. */
var _SS_CACHE = null;
function ss_() {
  if (!_SS_CACHE) _SS_CACHE = SpreadsheetApp.openById(SPREADSHEET_ID);
  return _SS_CACHE;
}

/* [속도 2] 폴더 위치 기억 — 이름으로 매번 찾던 것을 ID로 바로 연다.
 *  기억한 폴더가 지워졌거나(휴지통) 열리지 않으면 예전처럼 이름으로 다시 찾고 새 ID를 기억한다. */
function folderById_(propKey, finder) {
  const p = props_();
  const id = p.getProperty(propKey);
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  const f = finder();
  try { p.setProperty(propKey, f.getId()); } catch (e) {}
  return f;
}

function getIruriRoot() {
  return folderById_('FOLDER_IRURI_ROOT', function () {   // [속도 2]
    const folders = DriveApp.getRootFolder().getFoldersByName(IRURI_ROOT);
    return folders.hasNext() ? folders.next() : DriveApp.getRootFolder().createFolder(IRURI_ROOT);
  });
}
function getReceiptsRoot() {
  const root = getIruriRoot();
  const folders = root.getFoldersByName(RECEIPTS_FOLDER);
  return folders.hasNext() ? folders.next() : root.createFolder(RECEIPTS_FOLDER);
}
function getSnapshotRoot() {
  return folderById_('FOLDER_SNAPSHOTS', function () {    // [속도 2]
    const root = getIruriRoot();
    const folders = root.getFoldersByName(SNAPSHOTS_FOLDER);
    return folders.hasNext() ? folders.next() : root.createFolder(SNAPSHOTS_FOLDER);
  });
}

function getSheet(name) {
  const ss = ss_();                     // [속도] openById 재사용
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === SHEET_TEACHERS) sheet.appendRow(['강사명','지역','급여유형','급여액','입사일','인상일','계좌정보','JSON전체']);
    if (name === SHEET_CENTERS)  sheet.appendRow(['센터명','지역','수업료','강사1','강사2','강사3','강사4','주소','출처','스케줄JSON','전화','이메일','담당자','JSON전체']);
    if (name === SHEET_PENDING)  sheet.appendRow(['이름','비번해시','지역','입사일','계좌','과목','신청일','상태','휴대폰','주소']);
    if (name === SHEET_SCHEDREQ) sheet.appendRow(['ID','강사명','지역','변경내용JSON','메시지','요청시각','상태','처리시각']);
    if (name === SHEET_CTOMB)    sheet.appendRow(['센터명','지역','삭제시각']);
    if (name === SHEET_JOURNAL)  sheet.appendRow(['저장시각','센터','지역','강사','프로그램','년','월','일','요일','진행일시','참여자','메인활동','보조활동①','보조활동②','활동목표','특이사항/총평','고유ID','폴더URL','PDF','WORD']);
  }
  return sheet;
}

/* ════════ 신규 가입 승인 ════════ */
function signupRequest(d){
  if(!d || !d.name) return { ok:false, message:'이름 없음' };
  const tv = getSheet(SHEET_TEACHERS).getDataRange().getValues();
  for(let i=1;i<tv.length;i++){
    if(String(tv[i][0]).trim() === String(d.name).trim()){
      signupAccount(d.name, d.hashedPw);
      return { ok:true, existing:true, message:'기존 강사 비밀번호 설정 완료' };
    }
  }
  const sheet = getSheet(SHEET_PENDING);
  const vals = sheet.getDataRange().getValues();
  const now = new Date().toLocaleString('ko-KR', { timeZone:'Asia/Seoul' });
  const row = [d.name, d.hashedPw, d.region||'', d.hireDate||'', d.account||'', d.subject||'', now, '대기', d.phone||'', d.address||''];
  for(let i=1;i<vals.length;i++){
    if(String(vals[i][0]).trim() === String(d.name).trim()){
      sheet.getRange(i+1,1,1,10).setValues([row]);
      return { ok:true, pending:true, message:'가입 신청 갱신(승인 대기)' };
    }
  }
  sheet.appendRow(row);
  return { ok:true, pending:true, message:'가입 신청 완료(관리자 승인 대기)' };
}

function getPendingSignups(){
  const sheet = getSheet(SHEET_PENDING);
  const vals = sheet.getDataRange().getValues();
  const list = [];
  for(let i=1;i<vals.length;i++){
    const [name,,region,hireDate,account,subject,requestedAt,status,phone,address] = vals[i];
    if(!name || status === '승인') continue;
    list.push({ name:String(name), region:String(region||''), hireDate:String(hireDate||''),
                account:String(account||''), subject:String(subject||''), requestedAt:String(requestedAt||''),
                phone:String(phone||''), address:String(address||'') });
  }
  return { ok:true, data:list };
}

function approveSignup(name){
  const sheet = getSheet(SHEET_PENDING);
  const vals = sheet.getDataRange().getValues();
  for(let i=1;i<vals.length;i++){
    if(String(vals[i][0]).trim() === String(name).trim()){
      const [nm, hash, region, hireDate, account, subject, requestedAt, status, phone, address] = vals[i];
      saveTeacher({ name:String(nm), region:String(region||''), feeType:'pct', feeVal:0,
                    hireDate:String(hireDate||''), raiseDate:'', account:String(account||''), subject:String(subject||''),
                    phone:String(phone||''), address:String(address||'') });
      signupAccount(String(nm), String(hash));
      sheet.deleteRow(i+1);
      return { ok:true, message:nm + ' 승인 완료' };
    }
  }
  return { ok:false, message:'대기 신청 없음' };
}

function rejectSignup(name){
  const sheet = getSheet(SHEET_PENDING);
  const vals = sheet.getDataRange().getValues();
  for(let i=1;i<vals.length;i++){
    if(String(vals[i][0]).trim() === String(name).trim()){
      sheet.deleteRow(i+1);
      return { ok:true, message:'거절됨' };
    }
  }
  return { ok:false, message:'대기 신청 없음' };
}

/* ════════ v16.05: 강사 스케줄 수정요청 ════════
 *  강사가 자기 스케줄(강의시간·주소·이메일)을 채워 관리자에게 요청을 보낸다.
 *  요청은 이 시트에만 쌓이고, 실제 센터DB 반영은 관리자가 '전체 반영'을 눌러야 일어난다
 *  (강사 기기는 센터DB를 직접 못 쓰게 막혀 있음 = 삭제된 센터가 되살아나는 사고 방지).
 *  · 변경내용JSON: [{center,region,day,gyosi,field,from,to}, ...]
 *  · 상태: 대기 / 반영 / 거절 */
function submitScheduleRequest(body){
  if(!body || !Array.isArray(body.changes) || !body.changes.length){
    return { ok:false, message:'변경 내용이 없습니다' };
  }
  const sheet = getSheet(SHEET_SCHEDREQ);
  const now = new Date();
  const id = 'SR' + now.getTime() + Math.floor(Math.random()*1000);
  const when = now.toLocaleString('ko-KR', { timeZone:'Asia/Seoul' });
  sheet.appendRow([ id, String(body.teacher||''), String(body.region||''),
                    JSON.stringify(body.changes), String(body.message||''), when, '대기', '' ]);
  return { ok:true, id:id, message:'수정 요청 접수' };
}

function getScheduleRequests(){
  const sheet = getSheet(SHEET_SCHEDREQ);
  const vals = sheet.getDataRange().getValues();
  const list = [];
  for(let i=1;i<vals.length;i++){
    const [id, teacher, region, changesJson, message, requestedAt, status] = vals[i];
    if(!id || String(status) !== '대기') continue;
    let changes = [];
    try{ changes = JSON.parse(String(changesJson||'[]')); }catch(e){ changes = []; }
    list.push({ id:String(id), teacher:String(teacher||''), region:String(region||''),
                changes:changes, message:String(message||''), requestedAt:String(requestedAt||'') });
  }
  return { ok:true, data:list };
}

function resolveScheduleRequest(id, status){
  const st = (status === 'applied') ? '반영' : (status === 'rejected') ? '거절' : String(status||'처리');
  const sheet = getSheet(SHEET_SCHEDREQ);
  const vals = sheet.getDataRange().getValues();
  const when = new Date().toLocaleString('ko-KR', { timeZone:'Asia/Seoul' });
  for(let i=1;i<vals.length;i++){
    if(String(vals[i][0]) === String(id)){
      sheet.getRange(i+1, 7, 1, 2).setValues([[ st, when ]]);   // 상태(7열), 처리시각(8열)
      return { ok:true, message:'처리됨: ' + st };
    }
  }
  return { ok:false, message:'요청을 찾지 못함' };
}

/* ════════ DB 안전장치: 급감 차단 + 자동 백업 ════════ */
function DB_DROP_BLOCK(curCount, newCount){
  return curCount >= 6 && newCount < curCount && (curCount - newCount) >= Math.max(3, Math.ceil(curCount * 0.05));
}
/* [안전 2단계] 대량 유실 하드 차단 — force(강제)로도 못 넘는다.
 *  70% 넘게 줄거나(=대부분 사라짐) 3개 미만이 되면 무조건 거부.
 *  실수/오래된 캐시로 인한 '센터·강사 전체 날아감'을 원천 차단.
 *  (정상 편집·소수 삭제는 걸리지 않음. 자동백업이 있어 걸려도 데이터는 안전) */
function DB_HARD_WIPE(curCount, newCount){
  return curCount >= 10 && newCount < Math.max(3, Math.ceil(curCount * 0.30));
}
function backupSheetSnapshot_(srcName){
  try{
    const ss = ss_();
    const src = ss.getSheetByName(srcName);
    if(!src) return;
    let bak = ss.getSheetByName(srcName + '_백업');
    if(!bak) bak = ss.insertSheet(srcName + '_백업');
    bak.clearContents();
    const vals = src.getDataRange().getValues();
    if(vals.length && vals[0].length){
      bak.getRange(1,1,vals.length,vals[0].length).setValues(vals);
      bak.getRange(1, vals[0].length + 2).setValue('백업시각: ' + new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}));
    }
  }catch(e){}
}
function dailyBackupDB(){ backupSheetSnapshot_(SHEET_TEACHERS); backupSheetSnapshot_(SHEET_CENTERS); }
function setupBackupTrigger(){
  ScriptApp.getProjectTriggers().forEach(t=>{ if(t.getHandlerFunction()==='dailyBackupDB') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyBackupDB').timeBased().everyDays(1).atHour(3).create();
  Logger.log('일일 DB 백업 트리거 설정 완료');
}
function getDbMeta(){
  const ss = ss_();
  const t = ss.getSheetByName(SHEET_TEACHERS);
  const c = ss.getSheetByName(SHEET_CENTERS);
  return { ok:true,
           teachers: t ? Math.max(0,t.getLastRow()-1) : 0,
           centers:  c ? Math.max(0,c.getLastRow()-1) : 0,
           teachersVersion: dbVersion_('teachers'),   // [속도] 진단용
           centersVersion:  dbVersion_('centers') };
}

function getTeachers(requesterName, isAdmin, clientVer) {
  // [속도] 앱이 가진 버전이 서버와 같으면 시트를 읽지 않는다
  const ver = dbVersion_('teachers');
  if (clientVer && Number(clientVer) === ver) {
    return { ok: true, unchanged: true, version: ver };
  }
  const sheet = getSheet(SHEET_TEACHERS);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { ok: true, data: [], version: ver };
  const isAdminMode = (isAdmin === true || isAdmin === 'true');
  const requester = String(requesterName || '').trim();
  const legacyMode = (!requester && !isAdminMode);
  const teachers = [];
  for (let i = 1; i < values.length; i++) {
    const [name, region, feeType, feeVal, hireDate, raiseDate, account, jsonStr] = values[i];
    if (!name) continue;
    let t;
    if (jsonStr) { try { t = JSON.parse(String(jsonStr)); } catch(e) { t = null; } }
    if (!t) {
      t = { name: String(name), region: String(region||''), feeType: String(feeType||'fixed'), feeVal: Number(feeVal)||0, hireDate: hireDate ? String(hireDate) : '', raiseDate: raiseDate ? String(raiseDate) : '', account: String(account||'') };
    }
    if (!isAdminMode && !legacyMode && t.name !== requester) t.account = '';
    teachers.push(t);
  }
  return { ok: true, data: teachers, version: ver };
}

function syncTeachers(teachers, force) {
  const sheet = getSheet(SHEET_TEACHERS);
  const curCount = Math.max(0, sheet.getLastRow() - 1);
  // [안전 2단계] force로도 못 넘는 대량 유실 하드 차단
  if (DB_HARD_WIPE(curCount, (teachers||[]).length)) {
    return { ok: false, blocked: true, reason: 'wipe', curCount: curCount,
             message: '강사 대량 유실 차단: 현재 '+curCount+'명 → 요청 '+(teachers||[]).length+'명. 자동백업에서 복구 가능하며, 정말 맞다면 잠시 후 다시 시도하세요' };
  }
  if (!force && DB_DROP_BLOCK(curCount, teachers.length)) {
    return { ok: false, blocked: true, reason: 'drop', curCount: curCount,
             message: '강사 급감 차단: 현재 '+curCount+'명 → 요청 '+teachers.length+'명 (정상이면 force로 재요청)' };
  }
  // v15.26: 2건 이상 변경(추가/수정/삭제) 감지 시 차단 → 클라이언트가 목록 확인 후 force 재요청
  if (!force) {
    const v = sheet.getDataRange().getValues(), old = {};
    for (let i = 1; i < v.length; i++) {
      const nm = String(v[i][0]||'').trim(); if (!nm) continue;
      old[nm] = [String(v[i][1]||''), String(v[i][2]||''), String(v[i][3]||0), String(v[i][6]||'')].join('|'); // 지역|급여유형|급여액|계좌
    }
    const ch = [], seen = {};
    (teachers||[]).forEach(t => {
      const nm = String(t.name||'').trim(); if (!nm) return; seen[nm] = true;
      const sig = [String(t.region||''), String(t.feeType||''), String(t.feeVal||0), String(t.account||'')].join('|');
      if (!(nm in old)) ch.push('추가: ' + nm);
      else if (old[nm] !== sig) ch.push('수정: ' + nm);
    });
    Object.keys(old).forEach(nm => { if (!seen[nm]) ch.push('삭제: ' + nm); });
    if (ch.length >= 2) {
      return { ok: false, blocked: true, reason: 'bulk', changeCount: ch.length, changes: ch,
               message: '강사 ' + ch.length + '건 변경 — 확인 필요' };
    }
  }

  const rows = teachers.map(t => [t.name, t.region||'', t.feeType||'fixed', t.feeVal||0, t.hireDate||'', t.raiseDate||'', t.account||'', JSON.stringify(t)]);

  // [속도] 쓸 내용이 지난번과 똑같고 시트 행 수도 그대로면 → 시트 쓰기 자체를 건너뛴다
  const p = props_(), h = contentHash_(rows);
  if (p.getProperty('DBHASH_teachers') === h && String(curCount) === String(p.getProperty('DBROWS_teachers'))) {
    return { ok: true, unchanged: true, version: dbVersion_('teachers'),
             message: '강사 ' + teachers.length + '명 — 변경 없음(건너뜀)' };
  }

  backupSheetSnapshot_(SHEET_TEACHERS);
  try { autoBackupDB(); } catch (_e) {}   // [안전 2단계] 덮어쓰기 직전 버전 백업(복원 지점)
  sheet.clearContents();
  const header = [['강사명','지역','급여유형','급여액','입사일','인상일','계좌정보','JSON전체']];
  const all = header.concat(rows);
  sheet.getRange(1, 1, all.length, 8).setValues(all);
  p.setProperty('DBHASH_teachers', h);
  p.setProperty('DBROWS_teachers', String(rows.length));
  const ver = bumpDbVersion_('teachers');
  return { ok: true, version: ver, message: '강사 ' + teachers.length + '명 동기화 완료' };
}

function saveTeacher(teacher) {
  const sheet = getSheet(SHEET_TEACHERS);
  const values = sheet.getDataRange().getValues();
  const row = [teacher.name, teacher.region||'', teacher.feeType||'fixed', teacher.feeVal||0, teacher.hireDate||'', teacher.raiseDate||'', teacher.account||'', JSON.stringify(teacher)];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === teacher.name) {
      sheet.getRange(i+1,1,1,8).setValues([row]);
      touchDb_('teachers');
      return { ok: true, message: '수정 완료' };
    }
  }
  sheet.appendRow(row);
  touchDb_('teachers');
  return { ok: true, message: '추가 완료' };
}

function deleteTeacher(name) {
  const sheet = getSheet(SHEET_TEACHERS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === name) { sheet.deleteRow(i+1); touchDb_('teachers'); return { ok: true, message: '삭제 완료' }; }
  }
  return { ok: false, message: '해당 강사 없음' };
}

function getCenters(clientVer) {
  // [속도] 앱이 가진 버전이 서버와 같으면 시트를 읽지 않는다 (센터 278행 × 14열 읽기 생략)
  const ver = dbVersion_('centers');
  if (clientVer && Number(clientVer) === ver) {
    return { ok: true, unchanged: true, version: ver };
  }
  const sheet = getSheet(SHEET_CENTERS);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { ok: true, data: [], version: ver };
  const centers = [];
  for (let i = 1; i < values.length; i++) {
    const [name, region, fee, t1, t2, t3, t4, address, source, scheduleJson, phone, email, contactName, jsonStr] = values[i];
    if (!name) continue;
    if (jsonStr) { try { centers.push(JSON.parse(String(jsonStr))); continue; } catch(e) {} }
    const teachers = [t1,t2,t3,t4].map(String).filter(t => t.trim());
    let schedule = [];
    if (scheduleJson) { try { schedule = JSON.parse(String(scheduleJson)); } catch(e) {} }
    centers.push({ name: String(name), region: String(region||''), fee: Number(fee)||0, teachers, address: String(address||''), source: String(source||'수동'), schedule, phone: String(phone||''), email: String(email||''), contactName: String(contactName||'') });
  }
  let tombs = [];
  try { tombs = getCenterTombs().data; } catch (e) {}   // v16.20: 삭제기록 동봉 → 클라이언트가 부활 방지
  return { ok: true, data: centers, version: ver, tombs: tombs };
}

/* ══════ v16.20: 서버 공용 삭제기록(묘비) ══════
 *  어느 기기에서 센터를 삭제하든 서버에 '삭제됨'을 남긴다.
 *  다른 기기는 접속할 때 이 목록을 받아 → 자기 캐시에 남은 그 센터를 부활시키지 않고 조용히 지운다.
 *  (삭제 도장이 삭제한 기기에만 있어 다른 기기가 부활시키던 문제의 근본 해결) */
function _addCenterTombGas(name, region) {
  if (!name) return;
  const sh = getSheet(SHEET_CTOMB);
  const v = sh.getDataRange().getValues();
  const rg = String(region || '');
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][0]) === String(name) && String(v[i][1] || '') === rg) {
      sh.getRange(i + 1, 3).setValue(new Date().toISOString());   // 이미 있으면 시각만 갱신
      return;
    }
  }
  sh.appendRow([String(name), rg, new Date().toISOString()]);
}
function _removeCenterTombGas(name, region) {
  if (!name) return;
  const sh = getSheet(SHEET_CTOMB);
  const v = sh.getDataRange().getValues();
  const rg = String(region || '');
  for (let i = v.length - 1; i >= 1; i--) {   // 뒤에서부터 삭제(행 밀림 방지)
    if (String(v[i][0]) === String(name) && String(v[i][1] || '') === rg) sh.deleteRow(i + 1);
  }
}
function getCenterTombs() {
  const sh = getSheet(SHEET_CTOMB);
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) {
    if (v[i][0]) out.push({ name: String(v[i][0]), region: String(v[i][1] || ''), at: String(v[i][2] || '') });
  }
  return { ok: true, data: out };
}

function saveCenter(center) {
  try { _removeCenterTombGas(center.name, center.region); } catch (e) {}   // v16.20: 다시 추가 → 삭제기록 해제
  const sheet = getSheet(SHEET_CENTERS);
  const values = sheet.getDataRange().getValues();
  const t = center.teachers || [];
  const row = [center.name, center.region||'', center.fee||0, t[0]||'', t[1]||'', t[2]||'', t[3]||'', center.address||'', center.source||'수동', JSON.stringify(center.schedule||[]), center.phone||'', center.email||'', center.contactName||'', JSON.stringify(center)];
  // v16.19: 이름+지역으로 행을 찾는다(동명이센터를 잘못 덮지 않게)
  const rg = String(center.region||'');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(center.name) && String(values[i][1]||'') === rg) {
      sheet.getRange(i+1,1,1,14).setValues([row]);
      touchDb_('centers');
      return { ok: true, message: '수정 완료' };
    }
  }
  sheet.appendRow(row);
  touchDb_('centers');
  return { ok: true, message: '추가 완료' };
}

function deleteCenter(name, region) {
  const sheet = getSheet(SHEET_CENTERS);
  const values = sheet.getDataRange().getValues();
  // v16.19: region 이 오면 이름+지역으로, 없으면(구버전 호출) 이름만으로 매칭
  const hasRg = (region !== undefined && region !== null);
  const rg = String(region||'');
  try { _addCenterTombGas(name, rg); } catch (e) {}   // v16.20: 삭제기록 남김(다른 기기 부활 방지) — 행이 이미 없어도 기록
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(name) && (!hasRg || String(values[i][1]||'') === rg)) {
      sheet.deleteRow(i+1); touchDb_('centers'); return { ok: true, message: '삭제 완료' };
    }
  }
  touchDb_('centers');   // v16.20: 행은 없었어도 삭제기록이 생겼으니 버전 올려 다른 기기가 받아가게
  return { ok: true, message: '삭제기록만 남김(행 없음)' };
}

function syncCenters(centers, force) {
  const sheet = getSheet(SHEET_CENTERS);
  const curCount = Math.max(0, sheet.getLastRow() - 1);
  // [안전 2단계] force로도 못 넘는 대량 유실 하드 차단
  if (DB_HARD_WIPE(curCount, (centers||[]).length)) {
    return { ok: false, blocked: true, reason: 'wipe', curCount: curCount,
             message: '센터 대량 유실 차단: 현재 '+curCount+'개 → 요청 '+(centers||[]).length+'개. 자동백업에서 복구 가능하며, 정말 맞다면 잠시 후 다시 시도하세요' };
  }
  if (!force && DB_DROP_BLOCK(curCount, centers.length)) {
    return { ok: false, blocked: true, reason: 'drop', curCount: curCount,
             message: '센터 급감 차단: 현재 '+curCount+'개 → 요청 '+centers.length+'개 (정상이면 force로 재요청)' };
  }
  // v15.26: 2건 이상 변경(추가/수정/삭제) 감지 시 차단 → 클라이언트가 목록 확인 후 force 재요청
  if (!force) {
    const v = sheet.getDataRange().getValues(), old = {};
    for (let i = 1; i < v.length; i++) {
      const nm = String(v[i][0]||'').trim(); if (!nm) continue;
      const key = nm + '||' + String(v[i][1]||'').trim();
      const tt = [v[i][3],v[i][4],v[i][5],v[i][6]].map(x=>String(x||'').trim()).filter(Boolean).sort().join(',');
      old[key] = [String(v[i][2]||0), tt].join('|'); // 수업료|강사들
    }
    const ch = [], seen = {};
    (centers||[]).forEach(c => {
      const nm = String(c.name||'').trim(); if (!nm) return;
      const key = nm + '||' + String(c.region||'').trim(); seen[key] = true;
      const tt = (c.teachers||[]).map(x=>String(x||'').trim()).filter(Boolean).sort().join(',');
      const sig = [String(c.fee||0), tt].join('|');
      if (!(key in old)) ch.push('추가: ' + nm);
      else if (old[key] !== sig) ch.push('수정: ' + nm);
    });
    Object.keys(old).forEach(key => { if (!seen[key]) ch.push('삭제: ' + key.split('||')[0]); });
    if (ch.length >= 2) {
      return { ok: false, blocked: true, reason: 'bulk', changeCount: ch.length, changes: ch,
               message: '센터 ' + ch.length + '건 변경 — 확인 필요' };
    }
  }

  const rows = centers.map(c => {
    const t = c.teachers || [];
    return [c.name, c.region||'', c.fee||0, t[0]||'', t[1]||'', t[2]||'', t[3]||'', c.address||'', c.source||'수동', JSON.stringify(c.schedule||[]), c.phone||'', c.email||'', c.contactName||'', JSON.stringify(c)];
  });

  // [속도] 쓸 내용이 지난번과 똑같고 시트 행 수도 그대로면 → 시트 쓰기(약 3,900칸) 자체를 건너뛴다
  const p = props_(), h = contentHash_(rows);
  if (p.getProperty('DBHASH_centers') === h && String(curCount) === String(p.getProperty('DBROWS_centers'))) {
    return { ok: true, unchanged: true, version: dbVersion_('centers'),
             message: '센터 ' + centers.length + '개 — 변경 없음(건너뜀)' };
  }

  backupSheetSnapshot_(SHEET_CENTERS);
  try { autoBackupDB(); } catch (_e) {}   // [안전 2단계] 덮어쓰기 직전 버전 백업(복원 지점)
  sheet.clearContents();
  const header = [['센터명','지역','수업료','강사1','강사2','강사3','강사4','주소','출처','스케줄JSON','전화','이메일','담당자','JSON전체']];
  const all = header.concat(rows);
  sheet.getRange(1, 1, all.length, 14).setValues(all);
  p.setProperty('DBHASH_centers', h);
  p.setProperty('DBROWS_centers', String(rows.length));
  const ver = bumpDbVersion_('centers');
  return { ok: true, version: ver, message: '센터 ' + centers.length + '개 동기화 완료' };
}

function submitRecord(data) {
  const sheet = getSheet(SHEET_SUBMISSIONS);
  const histSheet = getSheet(SHEET_HISTORY);
  const teacher = data.name || data.teacher, yearMonth = data.yearMonth;
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const jsonStr = JSON.stringify(data);
  sheet.appendRow([teacher, yearMonth, now, jsonStr, 'N', 0]);
  histSheet.appendRow([teacher, yearMonth, now, jsonStr]);
  return { ok: true, message: '제출 완료', isRevision: false, revCount: 0 };
}

function getSubmissions() {
  const sheet = getSheet(SHEET_SUBMISSIONS);
  const values = sheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    const [teacher, yearMonth, submittedAt, jsonStr, reflected, revCount] = values[i];
    if (reflected === 'Y') continue;
    if (!teacher || !yearMonth) continue;
    try {
      const d = JSON.parse(jsonStr);
      d.submittedAt = submittedAt instanceof Date ? submittedAt.toISOString() : String(submittedAt);
      d.isRevision = revCount > 0;
      d.revCount = revCount;
      d._rowIndex = i + 1;
      result.push(d);
    } catch(e) {}
  }
  return { ok: true, data: result };
}

function deleteSubmission(teacher, yearMonth, submittedAt) {
  const sheet = getSheet(SHEET_SUBMISSIONS);
  const values = sheet.getDataRange().getValues();
  const tz = Session.getScriptTimeZone();
  let deleted = 0;
  for (let i = values.length - 1; i >= 1; i--) {
    const rowTeacher = String(values[i][0]).trim();
    let rowYearMonth = values[i][1];
    if (rowYearMonth instanceof Date) {
      rowYearMonth = Utilities.formatDate(rowYearMonth, tz, "yyyy년 M월");
    } else {
      rowYearMonth = String(rowYearMonth).trim();
    }
    if (rowTeacher === teacher && rowYearMonth === yearMonth) {
      if (submittedAt) {
        const rowAt = values[i][2] instanceof Date ? values[i][2].toISOString() : String(values[i][2]);
        if (!rowAt.includes(submittedAt.slice(0,16))) continue;
      }
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  return deleted > 0 ? { ok: true, deleted: deleted } : { ok: false, message: '해당 데이터 없음' };
}

function signupAccount(teacher, hashedPw) {
  const sheet = getSheet(SHEET_ACCOUNTS);
  const values = sheet.getDataRange().getValues();
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === teacher) { sheet.getRange(i+1,2).setValue(hashedPw); return { ok: true, message: '비밀번호 변경 완료', isChange: true }; }
  }
  sheet.appendRow([teacher, hashedPw, now, now]);
  return { ok: true, message: '가입 완료', isChange: false };
}

function loginCheck(teacher, hashedPw, legacyPw) {
  const sheet = getSheet(SHEET_ACCOUNTS);
  const values = sheet.getDataRange().getValues();
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === teacher) {
      const stored = String(values[i][1]);
      if (stored === hashedPw) { sheet.getRange(i+1,4).setValue(now); return { ok: true, message: '로그인 성공' }; }
      if (legacyPw && stored === legacyPw) {
        sheet.getRange(i+1,2).setValue(hashedPw);
        sheet.getRange(i+1,4).setValue(now);
        return { ok: true, message: '로그인 성공' };
      }
      return { ok: false, message: '비밀번호 불일치' };
    }
  }
  return { ok: false, message: '가입되지 않은 계정' };
}

function getHistory(teacher) {
  const sheet = getSheet(SHEET_HISTORY);
  const values = sheet.getDataRange().getValues();
  const tz = Session.getScriptTimeZone();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    const [name, yearMonth, submittedAt, jsonStr, isFinalized, finalizedAt] = values[i];
    if (!name) continue;
    if (teacher !== '__all__' && name !== teacher) continue;
    try {
      const d = JSON.parse(jsonStr);
      let ymStr = yearMonth instanceof Date ? Utilities.formatDate(yearMonth, tz, "yyyy년 M월") : String(yearMonth);
      let atStr = submittedAt instanceof Date ? submittedAt.toISOString() : String(submittedAt);
      let finalizedAtStr = finalizedAt ? (finalizedAt instanceof Date ? finalizedAt.toISOString() : String(finalizedAt)) : '';
      result.push({
        yearMonth: ymStr,
        submittedAt: atStr,
        teacher: name,
        dayGroups: d.dayGroups || [],
        notes: d.notes ? d.notes : (d.note ? [d.note] : []),
        note: d.note || '',
        notesData: d.notesData || null,
        account: d.account || '',
        lessons: d.lessons || [],
        isFinalized: isFinalized === true || isFinalized === 'Y',
        finalizedAt: finalizedAtStr
      });
    } catch(e) {}
  }
  result.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  return { ok: true, data: result };
}

function uploadReceipt(teacher, yearMonth, fileName, base64, mimeType) {
  try {
    const rootFolder = getReceiptsRoot();
    let tf; const tfs = rootFolder.getFoldersByName(teacher);
    tf = tfs.hasNext() ? tfs.next() : rootFolder.createFolder(teacher);
    let mf; const mfs = tf.getFoldersByName(yearMonth);
    mf = mfs.hasNext() ? mfs.next() : tf.createFolder(yearMonth);
    const decoded = Utilities.base64Decode(base64);
    const blob = Utilities.newBlob(decoded, mimeType, fileName);
    const file = mf.createFile(blob);
    const fileId = file.getId();
    const viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
    const sheet = getSheet(SHEET_RECEIPTS);
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    sheet.appendRow([teacher, yearMonth, fileName, viewUrl, now]);
    return { ok: true, url: viewUrl, fileId };
  } catch(err) { return { ok: false, message: err.toString() }; }
}

function getReceipts(teacher, yearMonth) {
  const sheet = getSheet(SHEET_RECEIPTS);
  const values = sheet.getDataRange().getValues();
  const tz = Session.getScriptTimeZone();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    let [t, ym, fileName, url, uploadedAt] = values[i];
    if (!t) continue;
    if (ym instanceof Date) { ym = Utilities.formatDate(ym, tz, "yyyy년 M월"); } else { ym = String(ym).trim(); }
    if (teacher && String(t).trim() !== String(teacher).trim()) continue;
    if (yearMonth && ym !== String(yearMonth).trim()) continue;
    result.push({ teacher: String(t), yearMonth: ym, fileName: String(fileName), url: String(url), uploadedAt: String(uploadedAt) });
  }
  result.sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return { ok: true, data: result };
}

/* ════════ [속도 2] 월 스냅샷 빠르게 내려주기 ════════
 *  스크립트 속성(달별)
 *   SNAPAT_<달>   : 그 달 서버본의 저장시각 — 앱이 ?since= 로 같은 값을 보내면 '안 바뀜'만 응답
 *   SNAPFILE_<달> : 그 달 파일 ID — 폴더에서 이름으로 찾지 않고 바로 연다
 *   SNAPV_<달>    : 그 달이 저장/삭제/복구될 때마다 +1 → 캐시 이름에 들어가서 옛 캐시는 자동으로 안 쓰임
 *   SNAPLISTV     : 월 목록 캐시 이름용(어느 달이든 저장/삭제되면 +1)
 *  ※ 저장시각(SNAPAT)은 '저장·복구'할 때만 기록한다. 읽는 쪽에서 기록하면, 저장과 동시에 읽던 요청이
 *    옛 저장시각으로 덮어써서 앱이 옛 데이터를 들고 '안 바뀜'을 받을 수 있기 때문.
 *    (그래서 이번 업데이트 전에 저장된 달은 한 번 더 저장되기 전까지는 since 비교 없이 캐시로만 빨라짐 —
 *     바로 적용하려면 편집기에서 initSnapshotMeta 를 한 번 실행) */
const SNAP_CACHE_TTL  = 21600;   // 캐시 보관 6시간(구글 최대값). 저장되면 즉시 새 이름으로 바뀌므로 오래돼도 안전
const SNAP_LIST_TTL   = 1800;    // 월 목록 캐시 30분
const SNAP_CHUNK      = 90000;   // 캐시 한 칸 최대 100KB → 압축본을 9만 글자씩 나눠 담음
const SNAP_MAX_CHUNKS = 40;      // 압축본이 약 3.6MB 넘으면 캐시 안 함(예전 방식으로 읽음)

function snapKey_(ym) { return String(ym || '').replace(/\s/g, '_'); }
function md5hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8)
    .map(function (b) { return ((b & 0xFF) + 0x100).toString(16).slice(1); }).join('');
}
/* 그 달이 새로 저장/삭제/복구됐을 때 — 저장시각·파일ID 기록 + 캐시 버전 올림 */
function markSnapshotChanged_(ym, savedAt, fileId) {
  const p = props_(), k = snapKey_(ym);
  if (savedAt) p.setProperty('SNAPAT_' + k, String(savedAt)); else p.deleteProperty('SNAPAT_' + k);
  if (fileId)  p.setProperty('SNAPFILE_' + k, String(fileId)); else p.deleteProperty('SNAPFILE_' + k);
  p.setProperty('SNAPV_' + k, String((Number(p.getProperty('SNAPV_' + k)) || 0) + 1));
  p.setProperty('SNAPLISTV', String((Number(p.getProperty('SNAPLISTV')) || 0) + 1));
}
/* 큰 문자열을 압축해서 캐시에 여러 칸으로 나눠 담기 / 꺼내기 (실패하면 조용히 넘어감 → 예전 방식) */
function cachePutBig_(key, str) {
  try {
    const gz = Utilities.gzip(Utilities.newBlob(str, 'application/json'));
    const b64 = Utilities.base64Encode(gz.getBytes());
    const n = Math.ceil(b64.length / SNAP_CHUNK);
    if (!n || n > SNAP_MAX_CHUNKS) return;
    const m = {};
    for (let i = 0; i < n; i++) m[key + '_' + i] = b64.substr(i * SNAP_CHUNK, SNAP_CHUNK);
    m[key] = String(n);                       // 조각 수는 맨 마지막에 → 조각이 다 들어간 뒤에만 '있음'으로 보임
    CacheService.getScriptCache().putAll(m, SNAP_CACHE_TTL);
  } catch (e) {}
}
function cacheGetBig_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(key)) || 0;
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + '_' + i);
    const got = cache.getAll(keys);
    let b64 = '';
    for (let i = 0; i < n; i++) { const part = got[key + '_' + i]; if (part == null) return null; b64 += part; }
    return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString('UTF-8');
  } catch (e) { return null; }
}
/* 그 달 파일의 원문(JSON 문자열) 읽기 — 기억한 파일 ID로 먼저, 안 되면 폴더에서 이름으로 */
function readSnapshotFile_(ym) {
  const k = snapKey_(ym), fileName = k + '.json';
  const fid = props_().getProperty('SNAPFILE_' + k);
  if (fid) {
    try {
      const f = DriveApp.getFileById(fid);
      if (!f.isTrashed() && f.getName() === fileName) return f.getBlob().getDataAsString();
    } catch (e) {}
  }
  const files = getSnapshotRoot().getFilesByName(fileName);
  if (!files.hasNext()) return null;
  const f = files.next();
  try { props_().setProperty('SNAPFILE_' + k, f.getId()); } catch (e) {}   // 파일 ID는 이름 확인을 거치므로 읽는 쪽에서 기억해도 안전
  return f.getBlob().getDataAsString();
}
function snapshotPayload_(ym, raw) {
  const parsed = JSON.parse(raw);
  return { ok: true, yearMonth: parsed.yearMonth || ym, savedAt: parsed.savedAt || '', data: parsed.data || parsed };
}
/* doGet(getMonthlySnapshot) 전용 — 응답 문자열을 캐시에서 바로 돌려준다 */
function snapshotOut_(yearMonth, since) {
  try {
    const ym = String(yearMonth || '');
    const p = props_(), k = snapKey_(ym);
    const at = p.getProperty('SNAPAT_' + k) || '';
    // ① 앱이 이미 같은 저장본을 갖고 있으면 데이터 없이 '안 바뀜'만
    if (since && at && String(since) === at) {
      return response({ ok: true, unchanged: true, yearMonth: ym, savedAt: at });
    }
    // ② 캐시에 있으면 드라이브를 안 건드리고 바로
    const ck = 'SNAP_' + md5hex_(k + '|' + (p.getProperty('SNAPV_' + k) || '0'));
    const hit = cacheGetBig_(ck);
    if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    // ③ 없으면 파일을 읽어서 응답하고, 다음을 위해 캐시에 담아둠
    const raw = readSnapshotFile_(ym);
    if (raw === null) return response({ ok: false, message: '저장된 데이터 없음' });
    const out = JSON.stringify(snapshotPayload_(ym, raw));
    cachePutBig_(ck, out);
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  } catch (err) { return response({ ok: false, message: err.toString() }); }
}
/* doGet(listMonthlySnapshots / getMonthlySnapshots) 전용 — 월 목록 캐시 */
function snapshotListOut_() {
  try {
    const ck = 'SNAPLIST_' + (props_().getProperty('SNAPLISTV') || '0');
    const cache = CacheService.getScriptCache();
    const hit = cache.get(ck);
    if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    const res = getMonthlySnapshots();
    const out = JSON.stringify(res);
    if (res && res.ok && out.length < 90000) { try { cache.put(ck, out, SNAP_LIST_TTL); } catch (e) {} }
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  } catch (err) { return response({ ok: false, message: err.toString() }); }
}

/* ════════ 월 스냅샷 — v7.4: 빈 데이터/급감 저장 거부 + 롤링 백업(최근 2개) ════════ */
function saveMonthlySnapshot(yearMonth, data, force, incomingSavedAt) {
  try {
    const teachers = data && data.teachers;
    const newCount = Array.isArray(teachers) ? teachers.length : 0;

    // ① 빈(강사 0명) 스냅샷 저장 거부
    if (!force && newCount === 0) {
      return { ok: false, rejected: true, message: yearMonth + ' 저장 거부: 강사 0명(빈 데이터)' };
    }

    const folder   = getSnapshotRoot();
    const fileName = yearMonth.replace(/\s/g, '_') + '.json';
    const existing = folder.getFilesByName(fileName);
    const oldFile  = existing.hasNext() ? existing.next() : null;

    let oldSavedAt = 0, oldCount = 0;
    if (oldFile) {
      try {
        const old = JSON.parse(oldFile.getBlob().getDataAsString());
        oldCount   = (old.data && Array.isArray(old.data.teachers)) ? old.data.teachers.length : 0;
        oldSavedAt = old.savedAt ? new Date(old.savedAt).getTime() : 0;
      } catch (e) {}
    }

    // ② 단조성: 들어온 저장시각이 서버보다 '오래됐으면' 거부 (오래된 재업로드가 최신본 덮어쓰기 방지)
    if (!force && oldFile && incomingSavedAt) {
      const inMs = new Date(incomingSavedAt).getTime();
      if (inMs && oldSavedAt && inMs < oldSavedAt) {
        return { ok: false, rejected: true, stale: true,
                 message: yearMonth + ' 저장 거부: 서버가 더 최신' };
      }
    }

    // ③ 급감 차단
    if (oldFile && !force && DB_DROP_BLOCK(oldCount, newCount)) {
      return { ok: false, blocked: true, reason: 'drop', curCount: oldCount,
               message: yearMonth + ' 저장 차단: 서버 ' + oldCount + '명 → 요청 ' + newCount + '명 급감' };
    }

    // ④ 롤링 백업: 기존 → .bak1, 이전 .bak1 → .bak2 (월 목록엔 안 나타남)
    if (oldFile) {
      const bak2 = folder.getFilesByName(fileName + '.bak2');
      while (bak2.hasNext()) bak2.next().setTrashed(true);
      const bak1 = folder.getFilesByName(fileName + '.bak1');
      while (bak1.hasNext()) bak1.next().setName(fileName + '.bak2');
      oldFile.setName(fileName + '.bak1');
    }
    const dup = folder.getFilesByName(fileName);
    while (dup.hasNext()) dup.next().setTrashed(true);

    const savedAt = incomingSavedAt || new Date().toISOString();
    const newFile = folder.createFile(fileName, JSON.stringify({ yearMonth, savedAt, data }), 'application/json');
    try { markSnapshotChanged_(yearMonth, savedAt, newFile.getId()); } catch (e) {}   // [속도 2] 저장시각·파일ID 기록, 캐시 교체
    return { ok: true, message: yearMonth + ' 정산 데이터 저장 완료' };
  } catch (err) { return { ok: false, message: err.toString() }; }
}

function getMonthlySnapshot(yearMonth) {
  try {
    const raw = readSnapshotFile_(yearMonth);   // [속도 2] 기억한 파일 ID로 바로 읽기
    if (raw === null) return { ok: false, message: '저장된 데이터 없음' };
    return snapshotPayload_(yearMonth, raw);
  } catch (err) { return { ok: false, message: err.toString() }; }
}

function getMonthlySnapshots() {
  try {
    const folder = getSnapshotRoot();
    const files  = folder.getFiles();
    const list   = [];
    while (files.hasNext()) {
      const f = files.next();
      const name = f.getName();
      if (!name.endsWith('.json')) continue;
      if (/_bak\.json$/.test(name)) continue;
      const yearMonth = name.replace('.json', '').replace(/_/g, ' ');
      list.push({ yearMonth, savedAt: f.getLastUpdated().toISOString(), size: f.getSize() });
    }
    list.sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
    return { ok: true, data: list };
  } catch (err) { return { ok: false, message: err.toString() }; }
}

function deleteMonthlySnapshot(yearMonth) {
  try {
    const folder   = getSnapshotRoot();
    const fileName = yearMonth.replace(/\s/g, '_') + '.json';
    const files    = folder.getFilesByName(fileName);
    let deleted    = 0;
    while (files.hasNext()) { files.next().setTrashed(true); deleted++; }
    try { markSnapshotChanged_(yearMonth, '', ''); } catch (e) {}   // [속도 2] 캐시·기억 지움
    return deleted > 0 ? { ok: true, message: '삭제 완료' } : { ok: false, message: '파일 없음' };
  } catch (err) { return { ok: false, message: err.toString() }; }
}

/* 편집기에서 직접 실행용 — 백업에서 복구. 예) restoreSnapshotBackup('2026년 6월', 1) */
function restoreSnapshotBackup(yearMonth, which) {
  const folder   = getSnapshotRoot();
  const fileName = yearMonth.replace(/\s/g, '_') + '.json';
  const bak = folder.getFilesByName(fileName + '.bak' + (which || 1));
  if (!bak.hasNext()) { Logger.log('백업 파일 없음: ' + fileName + '.bak' + (which || 1)); return; }
  const content = bak.next().getBlob().getDataAsString();
  const cur = folder.getFilesByName(fileName);
  while (cur.hasNext()) cur.next().setName(fileName + '.replaced_' + new Date().getTime());
  const nf = folder.createFile(fileName, content, 'application/json');
  // [속도 2] 복구본 기준으로 저장시각·파일ID·캐시 갱신 (복구본 저장시각을 못 읽으면 since 비교 없이 매번 전체 전송 = 안전)
  let at = '';
  try { at = String(JSON.parse(content).savedAt || ''); } catch (e) {}
  try { markSnapshotChanged_(yearMonth, at, nf.getId()); } catch (e) {}
  Logger.log(yearMonth + ' 백업 복구 완료');
}

/* [속도 2] 편집기에서 한 번 실행(선택) — 이번 업데이트 전에 저장된 달들도 바로 since 비교가 되도록
 *  각 달 파일의 저장시각·파일ID를 기록한다. 저장과 겹치지 않게 저장 잠금을 잡고 실행. 데이터는 그대로. */
function initSnapshotMeta() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const files = getSnapshotRoot().getFiles();
    let n = 0;
    while (files.hasNext()) {
      const f = files.next(), name = f.getName();
      if (!/\.json$/.test(name) || /_bak\.json$/.test(name)) continue;
      const ym = name.replace(/\.json$/, '').replace(/_/g, ' ');
      let at = '';
      try { at = String(JSON.parse(f.getBlob().getDataAsString()).savedAt || ''); } catch (e) {}
      markSnapshotChanged_(ym, at, f.getId());
      n++;
    }
    Logger.log('✅ 월 스냅샷 ' + n + '개 기록 완료');
  } finally { lock.releaseLock(); }
}

/* [속도 2] 문제가 생겼을 때 편집기에서 직접 실행 — 월 스냅샷 캐시를 전부 무효화(다음 요청부터 드라이브에서 다시 읽음). 데이터는 그대로. */
function clearSnapshotCache() {
  const p = props_(), all = p.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('SNAPV_') === 0) p.setProperty(key, String((Number(all[key]) || 0) + 1));
  });
  p.setProperty('SNAPLISTV', String((Number(p.getProperty('SNAPLISTV')) || 0) + 1));
  Logger.log('✅ 월 스냅샷 캐시 무효화 완료');
}

/* [속도] 문제가 생겼을 때 편집기에서 직접 실행 — 버전·지문을 초기화해서
 *  다음 요청부터 무조건 시트를 다시 읽고/다시 쓰게 만든다. (데이터는 그대로) */
function resetDbVersionCache() {
  const p = props_();
  ['teachers','centers'].forEach(function(k){
    p.deleteProperty('DBHASH_' + k);
    p.deleteProperty('DBROWS_' + k);
    p.setProperty('DBVER_' + k, String((Number(p.getProperty('DBVER_' + k) || 0) || 0) + 1));
  });
  Logger.log('DB 버전·지문 초기화 완료 — 강사 v' + dbVersion_('teachers') + ', 센터 v' + dbVersion_('centers'));
}

function getSystemSettings() {
  const ss = ss_();
  let sheet = ss.getSheetByName('시스템설정');
  if (!sheet) return { ok: true, data: {} };
  const values = sheet.getDataRange().getValues();
  const settings = {};
  for (let i = 0; i < values.length; i++) {
    if (values[i][0]) settings[String(values[i][0])] = values[i][1];
  }
  return { ok: true, data: settings };
}

function saveSystemSettings(settings) {
  const ss = ss_();
  let sheet = ss.getSheetByName('시스템설정');
  if (!sheet) sheet = ss.insertSheet('시스템설정');
  const existing = {};
  const vals = sheet.getDataRange().getValues();
  vals.forEach((row, i) => { if (row[0]) existing[String(row[0])] = i + 1; });
  Object.entries(settings).forEach(([k, v]) => {
    if (existing[k]) { sheet.getRange(existing[k], 2).setValue(v); }
    else { sheet.appendRow([k, v]); }
  });
  return { ok: true };
}

function getPresence() {
  // [접속현황 2026-10] 최근 10분만이 아니라 '모든 강사의 마지막 접속 시각'을 돌려준다
  //  → 관리자 화면 오프라인 목록에 '3시간 전·2일 전'처럼 표시. (강사 수만큼이라 몇 KB)
  //  로그아웃한 사람은 out:true (마지막 접속 시각은 그대로 남김)
  const ss = ss_();
  let sheet = ss.getSheetByName(SHEET_PRESENCE);
  if (!sheet) return { ok: true, data: [] };
  const values = sheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    const [teacher, lastSeen, page] = values[i];
    if (!teacher) continue;
    const lastSeenDate = lastSeen instanceof Date ? lastSeen : new Date(lastSeen);
    if (isNaN(lastSeenDate.getTime())) continue;
    const pg = String(page || '');
    result.push({ teacher: String(teacher), lastSeen: lastSeenDate.toISOString(), page: pg, out: pg === '로그아웃' });
  }
  return { ok: true, data: result };
}

function updatePresence(teacher, page) {
  if (!teacher) return { ok: false };
  const ss = ss_();
  let sheet = ss.getSheetByName(SHEET_PRESENCE);
  if (!sheet) { sheet = ss.insertSheet(SHEET_PRESENCE); sheet.appendRow(['강사명', '마지막접속', '페이지']); }
  const now = new Date();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === teacher) { sheet.getRange(i + 1, 2, 1, 2).setValues([[now, page || '']]); return { ok: true }; }
  }
  sheet.appendRow([teacher, now, page || '']);
  return { ok: true };
}

function removePresence(teacher) {
  // [접속현황 2026-10] 줄을 지우지 않고 '로그아웃'으로 표시 → 마지막 접속 시각이 남는다
  if (!teacher) return { ok: false };
  const ss = ss_();
  const sheet = ss.getSheetByName(SHEET_PRESENCE);
  if (!sheet) return { ok: true };
  const values = sheet.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === teacher) { sheet.getRange(i + 1, 2, 1, 2).setValues([[now, '로그아웃']]); return { ok: true }; }
  }
  return { ok: true };
}

function finalizeSettlement(teacher, yearMonth, note, notesData) {
  const sheet = getSheet(SHEET_HISTORY);
  const values = sheet.getDataRange().getValues();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  let targetRow = -1;
  let latestTime = 0;
  for (let i = 1; i < values.length; i++) {
    const [name, ym, submittedAt] = values[i];
    let ymStr = ym instanceof Date ? Utilities.formatDate(ym, tz, "yyyy년 M월") : String(ym);
    if (String(name).trim() !== String(teacher).trim()) continue;
    if (ymStr !== String(yearMonth).trim()) continue;
    const t = submittedAt instanceof Date ? submittedAt.getTime() : new Date(String(submittedAt)).getTime();
    if (t > latestTime) { latestTime = t; targetRow = i; }
  }
  if (targetRow < 0) return { ok: false, message: '해당 제출 이력 없음' };
  const oldJson = values[targetRow][3];
  let data = {};
  try { data = JSON.parse(String(oldJson)); } catch(e) {}
  if (note !== undefined) data.note = note;
  if (notesData !== undefined) data.notesData = notesData;
  const newJson = JSON.stringify(data);
  const row = targetRow + 1;
  sheet.getRange(row, 4).setValue(newJson);
  sheet.getRange(row, 5).setValue('Y');
  sheet.getRange(row, 6).setValue(now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
  return { ok: true, message: teacher + ' ' + yearMonth + ' 정산 완료 처리됨', finalizedAt: now.toISOString() };
}

function getSettlementStatus(teacher) {
  if (!teacher) return { ok: false, message: 'teacher 필요' };
  const sheet = getSheet(SHEET_HISTORY);
  const values = sheet.getDataRange().getValues();
  const tz = Session.getScriptTimeZone();
  const finalized = [];
  for (let i = 1; i < values.length; i++) {
    const [name, yearMonth, , , isFinalized, finalizedAt] = values[i];
    if (String(name).trim() !== String(teacher).trim()) continue;
    if (isFinalized !== true && isFinalized !== 'Y') continue;
    let ymStr = yearMonth instanceof Date ? Utilities.formatDate(yearMonth, tz, "yyyy년 M월") : String(yearMonth);
    let atStr = finalizedAt instanceof Date ? finalizedAt.toISOString() : String(finalizedAt);
    if (!finalized.find(f => f.yearMonth === ymStr)) finalized.push({ yearMonth: ymStr, finalizedAt: atStr });
  }
  return { ok: true, data: finalized };
}


/* ═══════════ [안전망 1단계] 자동 버전 백업 (v1) ═══════════
 *  목적: 정산 기간에도 센터·강사·정산 데이터가 '실질적으로' 사라지지 않게 —
 *        무슨 일이 있어도 되돌릴 수 있는 복원 지점을 자동으로 쌓아둔다.
 *
 *  ★ 안전성: 이 코드는 실데이터를 '읽어서 복사본만' 만든다. 기존 시트/파일을
 *            지우거나 바꾸지 않으므로, 그 자체로는 어떤 손실도 낼 수 없다.
 *            (저장 로직도 전혀 안 건드림 — 옆에서 조용히 스냅샷만 뜬다)
 *
 *  설치(딱 한 번): 편집기에서 함수 목록 → setupAutoBackup 선택 → ▶실행 → 권한 허용.
 *                  이후 '매시간' 자동으로 백업된다.
 *  확인: 구글 드라이브 → 이루리 → 이루리_자동백업 폴더에 backup_날짜시각.json 이 쌓임.
 *  복구: 편집기에서 listBackups() 실행(목록 확인) → restoreFromBackup('파일명') 실행.
 *
 *  ※ 아래 이름들은 기존 Code.gs 의 것을 그대로 씁니다:
 *     ss_(), props_(), getIruriRoot(), getSnapshotRoot(), SHEET_TEACHERS, SHEET_CENTERS
 *     (기존 Code.gs 끝에 이 블록을 붙여넣기만 하면 됩니다) */

const BACKUP_FOLDER = '이루리_자동백업';
const BACKUP_KEEP   = 150;  // 최근 150개 보관(정기+저장직전 백업 포함)

function backupRoot_() {
  const root = getIruriRoot();
  const it = root.getFoldersByName(BACKUP_FOLDER);
  return it.hasNext() ? it.next() : root.createFolder(BACKUP_FOLDER);
}

/* 매시간 트리거가 부르는 함수 — 복사본만 만든다(비파괴) */
function autoBackupDB() {
  try {
    const ss = ss_();
    const pick = (name) => { const sh = ss.getSheetByName(name); return sh ? sh.getDataRange().getValues() : []; };
    const now = new Date();
    const stamp = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd_HHmmss');
    const payload = {
      backedUpAt: now.toISOString(),
      teachers: pick(SHEET_TEACHERS),
      centers:  pick(SHEET_CENTERS)
    };
    // 이번 달 정산 스냅샷도 함께 보관(있으면)
    try {
      const ym = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy년 M월');
      const f = getSnapshotRoot().getFilesByName(ym.replace(/\s/g, '_') + '.json');
      if (f.hasNext()) payload.snapshot = { yearMonth: ym, json: f.next().getBlob().getDataAsString() };
    } catch (e) {}
    const folder = backupRoot_();
    folder.createFile('backup_' + stamp + '.json', JSON.stringify(payload), 'application/json');
    pruneBackups_(folder);
    return { ok: true, file: 'backup_' + stamp };
  } catch (err) {
    return { ok: false, message: err.toString() };
  }
}

/* 오래된 백업 자동 정리(휴지통으로) — 최근 BACKUP_KEEP개만 남김 */
function pruneBackups_(folder) {
  const files = [];
  const all = folder.getFiles();
  while (all.hasNext()) { const f = all.next(); if (/^backup_.*\.json$/.test(f.getName())) files.push(f); }
  files.sort((a, b) => b.getName().localeCompare(a.getName()));   // 최신 먼저
  for (let i = BACKUP_KEEP; i < files.length; i++) files[i].setTrashed(true);
}

/* 설치 — 딱 한 번 실행하면 매시간 자동 백업 */
function setupAutoBackup() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'autoBackupDB') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('autoBackupDB').timeBased().everyHours(1).create();
  const r = autoBackupDB();   // 지금 즉시 1개 만들어 확인
  Logger.log('✅ 자동 백업 설치 완료 — 매시간 실행. 폴더: ' + BACKUP_FOLDER + ' / 첫 백업: ' + JSON.stringify(r));
}

/* ── 복구 도구 (문제 생겼을 때 편집기에서 수동 실행) ── */

/* 백업 목록 보기 */
function listBackups() {
  const folder = backupRoot_();
  const all = folder.getFiles();
  const out = [];
  while (all.hasNext()) {
    const f = all.next();
    if (/^backup_.*\.json$/.test(f.getName()))
      out.push(f.getName() + '   (' + f.getLastUpdated().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ')');
  }
  out.sort().reverse();
  Logger.log(out.length ? ('백업 ' + out.length + '개:\n' + out.join('\n')) : '백업 없음');
  return out;
}

/* 특정 백업으로 되돌리기.
 *   restoreFromBackup('backup_20260830_140000.json')            → 강사·센터 둘 다 복구
 *   restoreFromBackup('backup_20260830_140000.json', 'centers') → 센터만
 *   restoreFromBackup('backup_20260830_140000.json', 'teachers')→ 강사만
 *  ※ 복구 직전에 '지금 상태'도 한 번 더 백업하므로, 복구가 잘못돼도 되돌릴 수 있음. */
function restoreFromBackup(fileName, what) {
  what = what || 'both';
  const folder = backupRoot_();
  const it = folder.getFilesByName(fileName);
  if (!it.hasNext()) { Logger.log('❌ 파일 없음: ' + fileName + '  → listBackups() 로 이름 확인'); return; }
  const data = JSON.parse(it.next().getBlob().getDataAsString());
  autoBackupDB();   // 복구 전에 현재 상태부터 백업(안전)
  const ss = ss_();
  const writeBack = (name, rows) => {
    if (!rows || !rows.length) { Logger.log('⚠️ ' + name + ' 백업 내용이 비어 건너뜀'); return; }
    const sh = ss.getSheetByName(name); if (!sh) return;
    sh.clearContents();
    sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log('↩ ' + name + ' 복구: ' + (rows.length - 1) + '행');
  };
  if (what === 'teachers' || what === 'both') writeBack(SHEET_TEACHERS, data.teachers);
  if (what === 'centers'  || what === 'both') writeBack(SHEET_CENTERS,  data.centers);
  // 앱이 새 데이터를 다시 받아가도록 버전 무효화
  try {
    ['teachers', 'centers'].forEach(k => {
      props_().deleteProperty('DBHASH_' + k);
      props_().deleteProperty('DBROWS_' + k);
      props_().setProperty('DBVER_' + k, String((Number(props_().getProperty('DBVER_' + k) || 0) || 0) + 1));
    });
  } catch (e) {}
  Logger.log('✅ 복구 완료: ' + fileName + ' (' + what + ') — 앱에서 동기화 버튼 누르면 반영됨');
}


/* ════════ 프로그램 일지 누적 (계획서 도구 연동) ════════
 *  드라이브: 이루리/프로그램일지/강사/센터/연도 폴더에 PDF·WORD 저장
 *  시트   : '프로그램일지' 탭에 한 줄씩 기록(센터·강사·년·월·일 + 파일 URL)
 *  같은 고유ID(=년월일_센터_강사)면 줄·파일을 덮어써 중복 방지
 *  ※ 기존 getSheet(), getIruriRoot() 를 그대로 사용 */
function _subFolder_(parent, name) {
  const nm = (name || '미지정').toString().trim() || '미지정';
  const it = parent.getFoldersByName(nm);
  return it.hasNext() ? it.next() : parent.createFolder(nm);
}
function getJournalRoot_() { return _subFolder_(getIruriRoot(), SHEET_JOURNAL); }

function saveJournalRecord(d) {
  if (!d) return { ok:false, message:'저장할 데이터가 없어요' };
  const center = (d.center || '').toString().trim();
  if (!center) return { ok:false, message:'센터명이 비어 있어요' };
  const id = (d.id || ('J' + Date.now())).toString();
  var folderUrl = '', pdfUrl = '', docUrl = '';
  try {
    if (d.files && (d.files.pdf || d.files.doc)) {
      const yf = _subFolder_(_subFolder_(_subFolder_(getJournalRoot_(), d.teacher), center), (d.year || '').toString());
      folderUrl = 'https://drive.google.com/drive/folders/' + yf.getId();
      const saveFile = function (f) {
        if (!f || !f.data) return '';
        const ex = yf.getFilesByName(f.name);
        while (ex.hasNext()) ex.next().setTrashed(true);
        const blob = Utilities.newBlob(Utilities.base64Decode(f.data), f.mime, f.name);
        return 'https://drive.google.com/file/d/' + yf.createFile(blob).getId() + '/view';
      };
      pdfUrl = saveFile(d.files.pdf);
      docUrl = saveFile(d.files.doc);
    }
  } catch (e) {}
  const sheet = getSheet(SHEET_JOURNAL);
  const row = [
    new Date(), center, (d.region || '').toString(), (d.teacher || '').toString(),
    (d.program || '도구 레크레이션').toString(),
    (d.year || '').toString(), (d.month || '').toString(), (d.day || '').toString(), (d.dow || '').toString(),
    (d.dateText || '').toString(), (d.people || '').toString(),
    (d.main || '').toString(), (d.sub1 || '').toString(), (d.sub2 || '').toString(),
    (d.goal || '').toString(), (d.evalText || '').toString(), id,
    folderUrl, pdfUrl, docUrl
  ];
  const last = sheet.getLastRow();
  if (last > 1) {
    const ids = sheet.getRange(2, 17, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if ((ids[i][0] || '').toString() === id) {
        const prev = sheet.getRange(i + 2, 18, 1, 3).getValues()[0];
        if (!folderUrl && prev[0]) row[17] = prev[0];
        if (!pdfUrl    && prev[1]) row[18] = prev[1];
        if (!docUrl    && prev[2]) row[19] = prev[2];
        sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return { ok:true, updated:true, id:id, folderUrl:row[17], pdfUrl:row[18], docUrl:row[19] };
      }
    }
  }
  sheet.appendRow(row);
  return { ok:true, id:id, folderUrl:folderUrl, pdfUrl:pdfUrl, docUrl:docUrl };
}

function getJournalRecords(center, teacher, year, month, region) {
  const sheet = getSheet(SHEET_JOURNAL);
  const last = sheet.getLastRow();
  if (last < 2) return { ok:true, records:[] };
  const vals = sheet.getRange(2, 1, last - 1, 20).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (center  && (r[1] || '').toString() !== center.toString())  continue;
    if (region  && (r[2] || '').toString() !== region.toString())  continue;
    if (teacher && (r[3] || '').toString() !== teacher.toString()) continue;
    if (year    && (r[5] || '').toString() !== year.toString())    continue;
    if (month   && (r[6] || '').toString() !== month.toString())   continue;
    out.push({
      savedAt:r[0], center:r[1], region:r[2], teacher:r[3], program:r[4],
      year:r[5], month:r[6], day:r[7], dow:r[8], dateText:r[9], people:r[10],
      main:r[11], sub1:r[12], sub2:r[13], goal:r[14], evalText:r[15], id:r[16],
      folderUrl:r[17], pdfUrl:r[18], docUrl:r[19]
    });
  }
  return { ok:true, records:out };
}

/* 저장된 프로그램 일지 삭제 — 고유ID로 시트 줄과 드라이브 파일(PDF·WORD)을 함께 지운다. */
function deleteJournalRecord(id) {
  if (!id) return { ok:false, message:'삭제할 ID가 없어요' };
  const sheet = getSheet(SHEET_JOURNAL);
  const last = sheet.getLastRow();
  if (last < 2) return { ok:true, deleted:false };
  const ids = sheet.getRange(2, 17, last - 1, 1).getValues();   // 17번째 열 = 고유ID
  for (let i = 0; i < ids.length; i++) {
    if ((ids[i][0] || '').toString() === id.toString()) {
      try {
        const urls = sheet.getRange(i + 2, 19, 1, 2).getValues()[0];   // 19=PDF, 20=WORD
        [urls[0], urls[1]].forEach(function (u) {
          const m = u && u.toString().match(/\/d\/([^/]+)/);
          if (m) { try { DriveApp.getFileById(m[1]).setTrashed(true); } catch (e) {} }
        });
      } catch (e) { /* 파일 삭제 실패해도 시트 줄은 지운다 */ }
      sheet.deleteRow(i + 2);
      return { ok:true, deleted:true, id:id };
    }
  }
  return { ok:true, deleted:false };
}

/* 체크한 여러 일지의 드라이브 WORD(사진 포함)를 하나의 Word 문서로 합쳐 base64로 반환.
 *  ids: 합칠 일지들의 고유ID 배열(클라이언트가 넘긴 순서대로 이어붙임) */
function combineJournalDocs(ids) {
  if (!ids || !ids.length) return { ok:false, message:'선택된 일지가 없어요' };
  const sheet = getSheet(SHEET_JOURNAL);
  const last = sheet.getLastRow();
  if (last < 2) return { ok:false, message:'저장된 일지가 없어요' };
  const vals = sheet.getRange(2, 1, last - 1, 20).getValues();
  const byId = {};
  for (let i = 0; i < vals.length; i++) byId[String(vals[i][16])] = vals[i];   // 17번째 열 = 고유ID

  let head = '', bodies = [], count = 0, miss = 0;
  ids.forEach(function (id) {
    const r = byId[String(id)];
    if (!r) { miss++; return; }
    const url = r[19];                                   // 20번째 열 = WORD 파일 URL
    const m = url && String(url).match(/\/d\/([^/]+)/);
    if (!m) { miss++; return; }
    let html = '';
    try { html = DriveApp.getFileById(m[1]).getBlob().getDataAsString('UTF-8'); }
    catch (e) { miss++; return; }
    html = html.replace(/^﻿/, '');                                        // BOM 제거
    if (!head) { const hm = html.match(/<head[\s\S]*?<\/head>/i); head = hm ? hm[0] : ''; }  // 스타일은 첫 파일 것 1회만
    const bm = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    bodies.push(bm ? bm[1] : html);
    count++;
  });
  if (!count) return { ok:false, message:'합칠 WORD 파일을 찾지 못했어요(저장 시 WORD가 없었을 수 있어요)' };

  const sep = '<br clear="all" style="mso-special-character:line-break;page-break-before:always">';   // 일지 사이 페이지 나눔
  const combined = '﻿<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">'
    + head + '<body>' + bodies.join(sep) + '</body></html>';
  const b64 = Utilities.base64Encode(combined, Utilities.Charset.UTF_8);
  return { ok:true, count:count, missing:miss, data:b64, mime:'application/msword' };
}

/* 체크한 여러 일지의 WORD(사진 포함)를 '각각 개별 파일'로 둔 채 하나의 .zip으로 묶어 base64 반환.
 *  파일명: 년월일_센터_강사_프로그램일지.doc (중복 시 (2),(3)…) */
function zipJournalDocs(ids) {
  if (!ids || !ids.length) return { ok:false, message:'선택된 일지가 없어요' };
  const sheet = getSheet(SHEET_JOURNAL);
  const last = sheet.getLastRow();
  if (last < 2) return { ok:false, message:'저장된 일지가 없어요' };
  const vals = sheet.getRange(2, 1, last - 1, 20).getValues();
  const byId = {};
  for (let i = 0; i < vals.length; i++) byId[String(vals[i][16])] = vals[i];   // 17번째 열 = 고유ID

  const blobs = [], used = {}; let count = 0, miss = 0;
  ids.forEach(function (id) {
    const r = byId[String(id)];
    if (!r) { miss++; return; }
    const url = r[19];                                   // 20번째 열 = WORD 파일 URL
    const m = url && String(url).match(/\/d\/([^/]+)/);
    if (!m) { miss++; return; }
    var file;
    try { file = DriveApp.getFileById(m[1]); } catch (e) { miss++; return; }
    const y = (r[5] || '').toString(), mo = ('0' + (r[6] || '')).slice(-2), da = ('0' + (r[7] || '')).slice(-2);
    var base = (y + mo + da + '_' + (r[1] || '') + '_' + (r[3] || '') + '_프로그램일지').replace(/[\\/:*?"<>|]/g, '_');
    var name = base + '.doc', n = 2;
    while (used[name]) { name = base + '(' + (n++) + ').doc'; }
    used[name] = 1;
    try { blobs.push(file.getBlob().setName(name)); count++; }
    catch (e) { miss++; }
  });
  if (!count) return { ok:false, message:'압축할 WORD 파일을 찾지 못했어요(저장 시 WORD가 없었을 수 있어요)' };

  const zip = Utilities.zip(blobs, '프로그램일지_모음.zip');
  const b64 = Utilities.base64Encode(zip.getBytes());
  return { ok:true, count:count, missing:miss, data:b64, mime:'application/zip' };
}


/* ════════ 계좌매칭(입금센터매칭) — 매핑 저장/조회 ════════
 *  대표님이 계좌매칭 탭에서 학습한 '취급점→센터' 매핑을 구글시트에 영속한다.
 *  앱: 탭 열 때 getDepositMappings 로 서버 정본을 받고, 매핑이 바뀌면
 *      saveDepositMappings 로 전체 매핑 배열을 통째로 저장(배치 쓰기)한다.
 *  ※ 입금내역은 저장하지 않는다(매달 엑셀 재업로드로 복원 가능). 계좌번호도 없음(민감도 낮음).
 *  ※ 저장 잠금은 doPost 가 이미 처리하므로 여기선 잠그지 않는다(이중잠금 방지).
 *  ※ 이 스크립트는 openById 방식이라 반드시 ss_() 를 쓴다(getActiveSpreadsheet 는 null). */
var DEP_MAP_SHEET = '계좌매칭_매핑';
var DEP_MAP_HEADERS = ['mapId','branchKey','branchRaw','centerName','region','gijaeSamples','isExcluded','note','registeredAt','lastMatchedAt'];

function _depMapSheet() {
  const ss = ss_();
  let sh = ss.getSheetByName(DEP_MAP_SHEET);
  if (!sh) { sh = ss.insertSheet(DEP_MAP_SHEET); sh.getRange(1, 1, 1, DEP_MAP_HEADERS.length).setValues([DEP_MAP_HEADERS]); }
  return sh;
}

function depGetMappings() {
  const sh = _depMapSheet(), vals = sh.getDataRange().getValues(), out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!r[0]) continue;
    out.push({
      mapId: String(r[0]), branchKey: String(r[1]), branchRaw: String(r[2]),
      centerName: String(r[3]), region: String(r[4]),
      gijaeSamples: r[5] ? String(r[5]).split('|').filter(String) : [],
      isExcluded: (r[6] === true || String(r[6]).toLowerCase() === 'true'),
      note: String(r[7] || ''), registeredAt: String(r[8] || ''), lastMatchedAt: String(r[9] || '')
    });
  }
  return { ok: true, data: out };
}

function depSaveMappings(mappings) {
  const sh = _depMapSheet();
  sh.clearContents();
  sh.getRange(1, 1, 1, DEP_MAP_HEADERS.length).setValues([DEP_MAP_HEADERS]);
  mappings = mappings || [];
  if (mappings.length) {
    const rows = mappings.map(function (m) {
      return [ m.mapId || '', m.branchKey || '', m.branchRaw || '', m.centerName || '', m.region || '',
               (m.gijaeSamples || []).join('|'), !!m.isExcluded, m.note || '', m.registeredAt || '', m.lastMatchedAt || '' ];
    });
    sh.getRange(2, 1, rows.length, DEP_MAP_HEADERS.length).setValues(rows);   // 배치 쓰기(한 번에)
  }
  return { ok: true, count: mappings.length };
}


/* ════════ 계좌매칭 — 회차(월) 입금내역 저장/조회 ════════
 *  각 회차(2026-07 등)의 입금내역을 시트에 보관 → 캐시 삭제·기기 변경에도 복원.
 *  저장 시 해당 회차 행만 교체(다른 회차 유지). 잠금은 doPost 가 처리. */
var DEP_REC_SHEET = '계좌매칭_입금내역';
var DEP_REC_HEADERS = ['periodId','account','date','time','summary','depositorName','branchRaw','branchKey','amount','matchStatus','matchedCenterName','region'];

function _depRecSheet() {
  var ss = ss_();
  var sh = ss.getSheetByName(DEP_REC_SHEET);
  if (!sh) { sh = ss.insertSheet(DEP_REC_SHEET); sh.getRange(1,1,1,DEP_REC_HEADERS.length).setValues([DEP_REC_HEADERS]); }
  return sh;
}

function depGetRecords() {
  var sh = _depRecSheet(), v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    if (!r[0] && !r[7]) continue;
    out.push({
      periodId: String(r[0]), account: String(r[1]), date: String(r[2]), time: String(r[3]),
      summary: String(r[4]), depositorName: String(r[5]), branchRaw: String(r[6]), branchKey: String(r[7]),
      amount: Number(r[8]) || 0, matchStatus: String(r[9] || 'unmatched'),
      matchedCenterName: (r[10] === '' ? null : String(r[10])), region: String(r[11] || '')
    });
  }
  return { ok: true, data: out };
}

function depSaveRecords(period, records) {
  var sh = _depRecSheet(), v = sh.getDataRange().getValues(), keep = [];
  for (var i = 1; i < v.length; i++) { if (v[i][0] && String(v[i][0]) !== String(period)) keep.push(v[i]); }  // 다른 회차 보존
  records = records || [];
  var add = records.map(function (m) {
    return [ String(period), m.account || '', m.date || '', m.time || '', m.summary || '', m.depositorName || '',
             m.branchRaw || '', m.branchKey || '', Number(m.amount) || 0, m.matchStatus || 'unmatched',
             m.matchedCenterName || '', m.region || '' ];
  });
  var all = [DEP_REC_HEADERS].concat(keep).concat(add);
  sh.clearContents();
  sh.getRange(1, 1, all.length, DEP_REC_HEADERS.length).setValues(all);  // 전체 재기록(배치)
  return { ok: true, period: String(period), count: add.length };
}
