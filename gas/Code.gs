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
 * ── 되돌리려면 ──
 *   깃허브 저장소 gas/Code.gs 파일의 '이전 커밋' 내용을 붙여넣으면 원래대로 돌아갑니다.
 *   버전/지문은 스크립트 속성에만 저장되므로 시트 데이터에는 영향이 없습니다.
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
    if (action === 'getMonthlySnapshot')   return response(getMonthlySnapshot(p.yearMonth));
    if (action === 'getMonthlySnapshots')  return response(getMonthlySnapshots());
    if (action === 'listMonthlySnapshots') return response(getMonthlySnapshots());
    if (action === 'ping')                 return response({ ok: true, message: '이루리 서버 연결됨 v7.5' });
    if (action === 'getSystemSettings')    return response(getSystemSettings());
    if (action === 'getPresence')          return response(getPresence());
    if (action === 'getSettlementStatus')  return response(getSettlementStatus(p.teacher));
    if (action === 'getDbMeta')            return response(getDbMeta());
    if (action === 'getPendingSignups')    return response(getPendingSignups());
    if (action === 'getScheduleRequests')  return response(getScheduleRequests());   // v16.05
    return response({ ok: false, message: '알 수 없는 action' });
  } catch (err) { return response({ ok: false, message: err.toString() }); }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === 'submitRecord')          return response(submitRecord(body.data));
    if (action === 'signupAccount')         return response(signupAccount(body.teacher, body.hashedPw));
    if (action === 'loginCheck')            return response(loginCheck(body.teacher, body.hashedPw, body.legacyPw));
    if (action === 'deleteSubmission')      return response(deleteSubmission(body.teacher, body.yearMonth, body.submittedAt));
    if (action === 'uploadReceipt')         return response(uploadReceipt(body.teacher, body.yearMonth, body.fileName, body.base64, body.mimeType));
    if (action === 'saveTeacher')           return response(saveTeacher(body.teacher));
    if (action === 'deleteTeacher')         return response(deleteTeacher(body.name));
    if (action === 'saveCenter')            return response(saveCenter(body.center));
    if (action === 'deleteCenter')          return response(deleteCenter(body.name));
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
    return response({ ok: false, message: '알 수 없는 action' });
  } catch (err) { return response({ ok: false, message: err.toString() }); }
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

function getIruriRoot() {
  const folders = DriveApp.getRootFolder().getFoldersByName(IRURI_ROOT);
  return folders.hasNext() ? folders.next() : DriveApp.getRootFolder().createFolder(IRURI_ROOT);
}
function getReceiptsRoot() {
  const root = getIruriRoot();
  const folders = root.getFoldersByName(RECEIPTS_FOLDER);
  return folders.hasNext() ? folders.next() : root.createFolder(RECEIPTS_FOLDER);
}
function getSnapshotRoot() {
  const root = getIruriRoot();
  const folders = root.getFoldersByName(SNAPSHOTS_FOLDER);
  return folders.hasNext() ? folders.next() : root.createFolder(SNAPSHOTS_FOLDER);
}

function getSheet(name) {
  const ss = ss_();                     // [속도] openById 재사용
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === SHEET_TEACHERS) sheet.appendRow(['강사명','지역','급여유형','급여액','입사일','인상일','계좌정보','JSON전체']);
    if (name === SHEET_CENTERS)  sheet.appendRow(['센터명','지역','수업료','강사1','강사2','강사3','강사4','주소','출처','스케줄JSON','전화','이메일','담당자','JSON전체']);
    if (name === SHEET_PENDING)  sheet.appendRow(['이름','비번해시','지역','입사일','계좌','과목','신청일','상태']);
    if (name === SHEET_SCHEDREQ) sheet.appendRow(['ID','강사명','지역','변경내용JSON','메시지','요청시각','상태','처리시각']);
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
  const row = [d.name, d.hashedPw, d.region||'', d.hireDate||'', d.account||'', d.subject||'', now, '대기'];
  for(let i=1;i<vals.length;i++){
    if(String(vals[i][0]).trim() === String(d.name).trim()){
      sheet.getRange(i+1,1,1,8).setValues([row]);
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
    const [name,,region,hireDate,account,subject,requestedAt,status] = vals[i];
    if(!name || status === '승인') continue;
    list.push({ name:String(name), region:String(region||''), hireDate:String(hireDate||''),
                account:String(account||''), subject:String(subject||''), requestedAt:String(requestedAt||'') });
  }
  return { ok:true, data:list };
}

function approveSignup(name){
  const sheet = getSheet(SHEET_PENDING);
  const vals = sheet.getDataRange().getValues();
  for(let i=1;i<vals.length;i++){
    if(String(vals[i][0]).trim() === String(name).trim()){
      const [nm, hash, region, hireDate, account, subject] = vals[i];
      saveTeacher({ name:String(nm), region:String(region||''), feeType:'pct', feeVal:0,
                    hireDate:String(hireDate||''), raiseDate:'', account:String(account||''), subject:String(subject||'') });
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
  return { ok: true, data: centers, version: ver };
}

function saveCenter(center) {
  const sheet = getSheet(SHEET_CENTERS);
  const values = sheet.getDataRange().getValues();
  const t = center.teachers || [];
  const row = [center.name, center.region||'', center.fee||0, t[0]||'', t[1]||'', t[2]||'', t[3]||'', center.address||'', center.source||'수동', JSON.stringify(center.schedule||[]), center.phone||'', center.email||'', center.contactName||'', JSON.stringify(center)];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === center.name) {
      sheet.getRange(i+1,1,1,14).setValues([row]);
      touchDb_('centers');
      return { ok: true, message: '수정 완료' };
    }
  }
  sheet.appendRow(row);
  touchDb_('centers');
  return { ok: true, message: '추가 완료' };
}

function deleteCenter(name) {
  const sheet = getSheet(SHEET_CENTERS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === name) { sheet.deleteRow(i+1); touchDb_('centers'); return { ok: true, message: '삭제 완료' }; }
  }
  return { ok: false, message: '해당 센터 없음' };
}

function syncCenters(centers, force) {
  const sheet = getSheet(SHEET_CENTERS);
  const curCount = Math.max(0, sheet.getLastRow() - 1);
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
    folder.createFile(fileName, JSON.stringify({ yearMonth, savedAt, data }), 'application/json');
    return { ok: true, message: yearMonth + ' 정산 데이터 저장 완료' };
  } catch (err) { return { ok: false, message: err.toString() }; }
}

function getMonthlySnapshot(yearMonth) {
  try {
    const folder   = getSnapshotRoot();
    const fileName = yearMonth.replace(/\s/g, '_') + '.json';
    const files    = folder.getFilesByName(fileName);
    if (!files.hasNext()) return { ok: false, message: '저장된 데이터 없음' };
    const parsed = JSON.parse(files.next().getBlob().getDataAsString());
    return { ok: true, yearMonth: parsed.yearMonth || yearMonth,
             savedAt: parsed.savedAt || '', data: parsed.data || parsed };
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
  folder.createFile(fileName, content, 'application/json');
  Logger.log(yearMonth + ' 백업 복구 완료');
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
  const ss = ss_();
  let sheet = ss.getSheetByName(SHEET_PRESENCE);
  if (!sheet) return { ok: true, data: [] };
  const values = sheet.getDataRange().getValues();
  const result = [];
  const now = new Date();
  for (let i = 1; i < values.length; i++) {
    const [teacher, lastSeen, page] = values[i];
    if (!teacher) continue;
    const lastSeenDate = lastSeen instanceof Date ? lastSeen : new Date(lastSeen);
    if (now - lastSeenDate < 10 * 60 * 1000) {
      result.push({ teacher: String(teacher), lastSeen: lastSeenDate.toISOString(), page: String(page||'') });
    }
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
  if (!teacher) return { ok: false };
  const ss = ss_();
  const sheet = ss.getSheetByName(SHEET_PRESENCE);
  if (!sheet) return { ok: true };
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === teacher) sheet.deleteRow(i + 1);
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
