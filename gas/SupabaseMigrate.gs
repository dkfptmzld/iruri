/* ════════════════════════════════════════════════════════════════════
 *  이루리 → Supabase 원본 복사 (빠짐없이, 원본 그대로)
 *
 *  · 시트: 이 스프레드시트의 '모든 탭'의 '모든 행'을 칸 그대로 복사
 *          (보이는 값 cells + 실제 값 vals, 날짜는 ISO 문자열)
 *  · 드라이브: 영수증 / 정산스냅샷 / 자동백업 / 프로그램일지 폴더의 '모든 파일'(하위 폴더 포함)을
 *          Supabase 저장소에 그대로 올리고, 목록을 legacy_files 에 남김
 *          (정산스냅샷 JSON 은 내용도 함께 저장 → Supabase 안에서 정산 테이블로 정리)
 *  · 원본(시트·드라이브)은 읽기만 함. 아무것도 지우거나 바꾸지 않음.
 *  · 6분 실행 제한 → 4분 30초마다 끊고 1분 뒤 자동으로 이어서 실행(이미 올린 파일은 건너뜀)
 *
 *  준비(한 번만):
 *   1) Apps Script → 프로젝트 설정(톱니바퀴) → 스크립트 속성 추가
 *        SUPABASE_URL = https://lprdtjxdvmqoohvcxzwu.supabase.co
 *        SUPABASE_KEY = (Supabase → Project Settings → API Keys 의 secret 키)
 *      ※ 키는 이 코드나 저장소에 절대 적지 말 것 — 스크립트 속성에만.
 *   2) 이 파일을 Code.gs 옆에 새 파일로 추가하고 저장
 *   3) 함수 선택 → migrateAllToSupabase → 실행 (처음 한 번 권한 허용)
 *   4) 끝나면 legacy_import_log 에 'done' 이 남음 (실행 로그에도 표시)
 * ════════════════════════════════════════════════════════════════════ */

var SB_MIG_BUDGET_MS = 270000;   // 4분 30초
var SB_MIG_STATE = 'SB_MIG_STATE';

/* ── 연결 ── */
function sbCfg_() {
  var p = PropertiesService.getScriptProperties();
  var url = (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  var key = p.getProperty('SUPABASE_KEY') || '';
  if (!url || !key) throw new Error('스크립트 속성에 SUPABASE_URL 과 SUPABASE_KEY 를 넣어 주세요');
  return { url: url, key: key };
}
function sbHeaders_(extra) {
  var c = sbCfg_();
  var h = { apikey: c.key };
  if (/^eyJ/.test(c.key)) h.Authorization = 'Bearer ' + c.key;   // 예전 형식(JWT) 키일 때만
  for (var k in (extra || {})) h[k] = extra[k];
  return h;
}
/* JSON 요청 */
function sbJson_(method, path, body, extraHeaders) {
  var c = sbCfg_();
  var opt = { method: method, muteHttpExceptions: true, headers: sbHeaders_(extraHeaders), contentType: 'application/json' };
  if (body !== undefined) opt.payload = JSON.stringify(body);
  var r = sbFetch_(c.url + path, opt);
  var t = r.getContentText();
  return t ? JSON.parse(t) : null;
}
/* 재시도 포함(일시 오류 3번까지) */
function sbFetch_(url, opt) {
  var last = null;
  for (var i = 0; i < 3; i++) {
    try {
      var r = UrlFetchApp.fetch(url, opt);
      var code = r.getResponseCode();
      if (code < 300) return r;
      last = new Error(opt.method + ' ' + url.replace(/^https:\/\/[^/]+/, '') + ' → ' + code + ' ' + r.getContentText().slice(0, 400));
      if (code < 500 && code !== 429) throw last;   // 잘못된 요청은 재시도해도 같음
    } catch (e) { last = e; if (/→ 4\d\d/.test(String(e)) && !/→ 429/.test(String(e))) throw e; }
    Utilities.sleep(1500 * (i + 1));
  }
  throw last;
}
function sbLog_(step, detail) {
  try { sbJson_('post', '/rest/v1/legacy_import_log', { step: step, detail: detail || null }, { Prefer: 'return=minimal' }); } catch (e) {}
  Logger.log(step + ' ' + JSON.stringify(detail || ''));
}

/* ── 1) 시트: 모든 탭 · 모든 행 ── */
function sbCellVal_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return v;
}
function sbMigSheets_() {
  var sheets = ss_().getSheets();
  var summary = [];
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s], name = sh.getName();
    var rng = sh.getDataRange();
    var vals = rng.getValues(), disp = rng.getDisplayValues();
    sbPushSheet_(name, vals, disp);
    summary.push({ sheet: name, rows: vals.length, cols: vals.length ? vals[0].length : 0 });
  }
  sbLog_('sheets', { spreadsheet: ss_().getId().slice(0, 6) + '…', count: sheets.length, sheets: summary });
  return summary;
}
/* 시트 한 탭을 Supabase에 그대로(행 번호 그대로, 줄어든 행은 정리) */
function sbPushSheet_(name, vals, disp) {
    var rows = [];
    for (var i = 0; i < vals.length; i++) {
      rows.push({ sheet: name, row_no: i + 1, cells: disp[i], vals: vals[i].map(sbCellVal_) });
    }
    // 시트가 줄어든 경우(다시 실행할 때) 남은 옛 행 정리 → 항상 시트와 똑같이
    sbJson_('delete', '/rest/v1/legacy_sheet_rows?sheet=eq.' + encodeURIComponent(name) + '&row_no=gt.' + vals.length, undefined, { Prefer: 'return=minimal' });
    // 한 번에 너무 크지 않게 나눠서
    var batch = [], size = 0;
    for (var j = 0; j < rows.length; j++) {
      var len = JSON.stringify(rows[j]).length;
      if (batch.length && (batch.length >= 200 || size + len > 1000000)) {
        sbJson_('post', '/rest/v1/legacy_sheet_rows?on_conflict=sheet,row_no', batch, { Prefer: 'resolution=merge-duplicates,return=minimal' });
        batch = []; size = 0;
      }
      batch.push(rows[j]); size += len;
    }
    if (batch.length) sbJson_('post', '/rest/v1/legacy_sheet_rows?on_conflict=sheet,row_no', batch, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

/* ── 2) 드라이브: 시스템 폴더 4개의 모든 파일 ── */
function sbMigFolders_() {
  var list = [];
  try { list.push({ key: 'receipts',  bucket: 'receipts', folder: getReceiptsRoot(), keepText: false }); } catch (e) {}
  try { list.push({ key: 'snapshots', bucket: 'legacy',   folder: getSnapshotRoot(), keepText: true  }); } catch (e) {}
  try { list.push({ key: 'backups',   bucket: 'legacy',   folder: backupRoot_(),     keepText: false }); } catch (e) {}
  try { list.push({ key: 'journal',   bucket: 'legacy',   folder: getJournalRoot_(), keepText: false }); } catch (e) {}
  return list;
}
/* 하위 폴더까지 전부: [{file, path}] */
function sbWalk_(folder, path, out) {
  var fs = folder.getFiles();
  while (fs.hasNext()) out.push({ file: fs.next(), path: path });
  var ds = folder.getFolders();
  while (ds.hasNext()) { var d = ds.next(); sbWalk_(d, path + '/' + d.getName(), out); }
  return out;
}
/* 이미 올린 파일 id (다시 실행할 때 건너뛰기) */
function sbDoneIds_() {
  var done = {}, from = 0, step = 1000;
  while (true) {
    var part = sbJson_('get', '/rest/v1/legacy_files?select=drive_id&order=drive_id&offset=' + from + '&limit=' + step);
    (part || []).forEach(function (r) { done[r.drive_id] = 1; });
    if (!part || part.length < step) break;
    from += step;
  }
  return done;
}
function sbUploadFile_(f, path, cfgItem) {
  var c = sbCfg_();
  var id = f.getId(), name = f.getName(), mime = f.getMimeType();
  var blob = f.getBlob();                                  // 구글 문서류는 PDF로 받아짐
  var outMime = blob.getContentType() || mime || 'application/octet-stream';
  var m = name.match(/\.([A-Za-z0-9]{1,8})$/);
  var ext = (mime.indexOf('application/vnd.google-apps') === 0) ? '.pdf' : (m ? '.' + m[1].toLowerCase() : '');
  var objPath = cfgItem.key + '/' + id + ext;              // 한글 파일명 대신 드라이브 id 로 저장(원래 이름은 목록에)
  var size = f.getSize();
  if (size > 50 * 1024 * 1024) { sbLog_('skip_large', { id: id, name: name, size: size }); return 'skip'; }
  sbFetch_(c.url + '/storage/v1/object/' + cfgItem.bucket + '/' + objPath, {
    method: 'post', muteHttpExceptions: true, payload: blob.getBytes(), contentType: outMime,
    headers: sbHeaders_({ 'x-upsert': 'true' })
  });
  var content = null;
  if (cfgItem.keepText && /json|text|javascript/.test(outMime + ' ' + mime + ' ' + name)) content = blob.getDataAsString('UTF-8');
  sbJson_('post', '/rest/v1/legacy_files?on_conflict=drive_id', [{
    drive_id: id, name: name, folder: cfgItem.key + (path ? path : ''), mime_type: mime,
    modified_at: f.getLastUpdated().toISOString(), size_bytes: size, content: content,
    storage_path: cfgItem.bucket + '/' + objPath, drive_url: f.getUrl()
  }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
  return 'ok';
}

/* ── 실행 ── */
function migrateAllToSupabase() {
  var t0 = Date.now();
  var p = PropertiesService.getScriptProperties();
  var st = JSON.parse(p.getProperty(SB_MIG_STATE) || '{}');
  if (st.running && Date.now() - st.running < 6 * 60 * 1000) { Logger.log('이미 실행 중이에요'); return; }
  st.running = Date.now(); p.setProperty(SB_MIG_STATE, JSON.stringify(st));
  sbClearTriggers_();
  try {
    if (!st.sheetsDone) {
      sbLog_('start', { at: new Date().toISOString() });
      sbMigSheets_();
      st.sheetsDone = new Date().toISOString();
      p.setProperty(SB_MIG_STATE, JSON.stringify(st));
    }
    var done = sbDoneIds_();
    var folders = sbMigFolders_(), totals = {}, left = 0, uploaded = 0, failed = [];
    for (var a = 0; a < folders.length; a++) {
      var items = sbWalk_(folders[a].folder, '', []);
      totals[folders[a].key] = items.length;
      for (var b = 0; b < items.length; b++) {
        var f = items[b].file;
        if (done[f.getId()]) continue;
        if (Date.now() - t0 > SB_MIG_BUDGET_MS) { left++; continue; }
        try { if (sbUploadFile_(f, items[b].path, folders[a]) === 'ok') uploaded++; done[f.getId()] = 1; }
        catch (e) { failed.push({ id: f.getId(), name: f.getName(), err: String(e).slice(0, 200) }); }
      }
    }
    if (left > 0 || failed.length) {
      sbLog_('progress', { uploaded: uploaded, remaining: left, failed: failed.slice(0, 20), totals: totals });
      if (st.failRounds === undefined) st.failRounds = 0;
      if (left === 0) st.failRounds++;            // 남은 건 없는데 실패만 있으면 몇 번만 다시 시도
      if (left > 0 || st.failRounds <= 3) ScriptApp.newTrigger('migrateAllToSupabase').timeBased().after(60 * 1000).create();
      else sbLog_('stopped_with_failures', { failed: failed });
    } else {
      sbLog_('done', { uploadedThisRun: uploaded, totals: totals, sheetsAt: st.sheetsDone });
      st.finished = new Date().toISOString();
    }
  } catch (e) {
    sbLog_('error', { message: String(e).slice(0, 500) });
    throw e;
  } finally {
    st.running = 0; p.setProperty(SB_MIG_STATE, JSON.stringify(st));
  }
}
/* 시트만 지금 기준으로 다시 복사(언제든 다시 실행해도 안전) */
function migrateSheetsToSupabase() { sbMigSheets_(); }
/* 처음부터 다시(시트 다시 복사 + 파일은 이미 올린 것 건너뜀) */
function migrateResetState() { PropertiesService.getScriptProperties().deleteProperty(SB_MIG_STATE); sbClearTriggers_(); }
/* 연결 확인만 */
function migrateTestConnection() {
  var c = sbCfg_();
  sbJson_('get', '/rest/v1/legacy_import_log?select=id&limit=1');                       // 데이터베이스
  sbFetch_(c.url + '/storage/v1/object/legacy/_test/ping.txt', {                         // 파일 저장소
    method: 'post', muteHttpExceptions: true, payload: 'ping ' + new Date().toISOString(),
    contentType: 'text/plain', headers: sbHeaders_({ 'x-upsert': 'true' }) });
  sbFetch_(c.url + '/storage/v1/object/legacy/_test/ping.txt', { method: 'delete', muteHttpExceptions: true, headers: sbHeaders_() });
  sbLog_('test', { ok: true });
  Logger.log('Supabase 연결 OK (데이터베이스 + 파일 저장소)');
}
function sbClearTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'migrateAllToSupabase') ScriptApp.deleteTrigger(t);
  });
}


/* ════════════════════════════════════════════════════════════════════
 *  2단계: 따라 저장(미러) — 전환 전까지 구글 시트·드라이브의 변화를 Supabase에 계속 반영
 *
 *  · 10분마다: 스프레드시트가 바뀌었으면 탭마다 내용 지문(MD5)을 비교해 '바뀐 탭만' 다시 복사
 *             (앱이 바꾼 것 + 시트를 손으로 고친 것 모두), 정산스냅샷 폴더는 이름·수정시각 비교,
 *             영수증·일지 시트가 바뀌면 그 폴더의 새 파일만 올림 → 바뀐 게 있으면 정리 테이블 다시 맞춤
 *  · 매일 새벽 4시: 모든 탭·모든 폴더(자동백업 포함)를 한 번 더 전부 맞춤
 *  · 원본은 읽기만 함. 앱 저장(Code.gs)과 무관하게 돌아가므로 앱 속도에 영향 없음
 *
 *  설치: setupSupabaseMirror 실행(한 번) / 중지: stopSupabaseMirror
 * ════════════════════════════════════════════════════════════════════ */
var SB_MIRROR = 'SB_MIRROR_STATE';

function setupSupabaseMirror() {
  stopSupabaseMirror();
  ScriptApp.newTrigger('supabaseMirrorTick').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('supabaseMirrorNightly').timeBased().everyDays(1).atHour(4).create();
  supabaseMirrorTick();   // 지금 한 번(처음엔 모든 탭 지문을 새로 기록)
  Logger.log('✅ 따라 저장 설치 완료 — 10분마다 + 매일 새벽 4시');
}
function stopSupabaseMirror() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'supabaseMirrorTick' || fn === 'supabaseMirrorNightly') ScriptApp.deleteTrigger(t);
  });
}
function supabaseMirrorNightly() { supabaseMirrorTick(true); }

function supabaseMirrorTick(force) {
  force = (force === true);
  var p = PropertiesService.getScriptProperties();
  var st = JSON.parse(p.getProperty(SB_MIRROR) || '{}');
  if (st.running && Date.now() - st.running < 6 * 60 * 1000) return;   // 앞 실행이 아직 도는 중
  st.running = Date.now(); p.setProperty(SB_MIRROR, JSON.stringify(st));
  var changed = [], files = 0;
  try {
    // ① 시트: 스프레드시트 수정시각이 바뀌었을 때만 탭별 지문 비교
    var lu = 0; try { lu = DriveApp.getFileById(ss_().getId()).getLastUpdated().getTime(); } catch (e) {}
    if (force || !lu || lu !== st.lu) {
      var hashes = st.h || {};
      ss_().getSheets().forEach(function (sh) {
        var name = sh.getName(), rng = sh.getDataRange();
        var vals = rng.getValues(), disp = rng.getDisplayValues();
        var h = md5hex_(JSON.stringify(disp) + '\u0001' + JSON.stringify(vals.map(function (r) { return r.map(sbCellVal_); })));
        if (force || hashes[name] !== h) { sbPushSheet_(name, vals, disp); hashes[name] = h; changed.push(name); }
      });
      st.h = hashes; st.lu = lu;
    }
    // ② 파일: 정산스냅샷은 매번(작음), 영수증·일지는 그 시트가 바뀌었을 때, 자동백업은 매일 새벽
    var F = {}; sbMigFolders_().forEach(function (c) { F[c.key] = c; });
    if (F.snapshots) files += sbSyncFolder_(F.snapshots, true);
    if (F.receipts && (force || changed.indexOf(SHEET_RECEIPTS) >= 0)) files += sbSyncFolder_(F.receipts, false);
    if (F.journal  && (force || changed.indexOf(SHEET_JOURNAL) >= 0))  files += sbSyncFolder_(F.journal, false);
    if (F.backups  && force) files += sbSyncFolder_(F.backups, false);
    // ③ 바뀐 게 있으면 정리 테이블 다시 맞춤
    if (changed.length || files) {
      var res = sbJson_('post', '/rest/v1/rpc/sb_rebuild', {});
      sbLog_(force ? 'mirror_full' : 'mirror', { sheets: changed, files: files, rebuilt: res });
    }
    st.last = new Date().toISOString(); st.lastError = '';
  } catch (e) {
    st.lastError = String(e).slice(0, 300);
    sbLog_('mirror_error', { message: st.lastError, sheets: changed });
  } finally {
    st.running = 0; p.setProperty(SB_MIRROR, JSON.stringify(st));
  }
}

/* 폴더 맞추기: 새 파일은 올리고, checkChanged 면 이름·수정시각이 바뀐 파일도 다시 올림(정산스냅샷의 .bak 이름 바뀜 포함) */
function sbSyncFolder_(cfgItem, checkChanged) {
  var have = {}, from = 0, step = 1000;
  while (true) {
    var part = sbJson_('get', '/rest/v1/legacy_files?select=drive_id,name,modified_at&folder=like.' +
      encodeURIComponent(cfgItem.key + '*') + '&order=drive_id&offset=' + from + '&limit=' + step);
    (part || []).forEach(function (r) { have[r.drive_id] = r; });
    if (!part || part.length < step) break;
    from += step;
  }
  var items = sbWalk_(cfgItem.folder, '', []), n = 0;
  items.forEach(function (it) {
    var f = it.file, old = have[f.getId()];
    var need = !old || (checkChanged && (old.name !== f.getName() || Date.parse(old.modified_at) !== f.getLastUpdated().getTime()));
    if (need) { sbUploadFile_(f, it.path, cfgItem); n++; }
  });
  return n;
}


/* ════════════════════════════════════════════════════════════════════
 *  3단계: 매일 밤 백업 — Supabase 의 모든 데이터를 구글 드라이브에 보관
 *
 *  · 매일 새벽 3시: Supabase 모든 테이블(새 테이블 생겨도 자동 포함) + 로그인 계정 + 내부 설정 + 저장소 파일 목록을
 *    파일 하나(…json.gz)로 만들어  이루리/이루리_Supabase백업  폴더에 저장. 최근 60개(약 두 달) 보관
 *  · 테이블마다 '서버의 행 수 = 받은 행 수' 를 확인하고, 다르면 한 번 더 받음(그래도 다르면 실패 처리)
 *  · 앱에서 새로 올린 영수증 사진 등(드라이브에 원본이 없는 파일)은  …/파일  폴더에 한 번씩 복사(지우지 않음)
 *  · 실패하면 구글이 자동으로 실패 알림 메일을 보냄(트리거 실패 알림)
 *  · 매일 Supabase 를 쓰므로, 무료 플랜의 '7일 안 쓰면 일시정지'도 막아 줌
 *  · 전환(따라 저장 중지) 뒤에도 그대로 계속 돌아감
 *
 *  설치: setupSupabaseBackup 실행(한 번, 지금 한 번 바로 백업) / 중지: stopSupabaseBackup
 *  확인: checkSupabaseBackup — 마지막 백업 파일을 열어 지금 Supabase 와 행 수 비교
 *  비상 복구: restoreSupabaseFromBackup — 아래 설명 참고(평소엔 절대 실행하지 말 것)
 * ════════════════════════════════════════════════════════════════════ */
var SB_BACKUP_FOLDER = '이루리_Supabase백업';
var SB_BACKUP_FILES  = '파일';
var SB_BACKUP_KEEP   = 60;
var SB_BACKUP_STATE  = 'SB_BACKUP_STATE';
var SB_BACKUP_PREFIX = 'supabase_백업_';
var SB_BACKUP_FILE_BUDGET_MS = 300000;   // 파일 복사는 5분까지만(남은 건 다음 날 이어서)

function setupSupabaseBackup() {
  stopSupabaseBackup();
  ScriptApp.newTrigger('supabaseNightlyBackup').timeBased().everyDays(1).atHour(3).create();
  supabaseNightlyBackup();
  Logger.log('✅ 매일 밤 백업 설치 완료 — 매일 새벽 3시, 폴더: 이루리/' + SB_BACKUP_FOLDER);
}
function stopSupabaseBackup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'supabaseNightlyBackup') ScriptApp.deleteTrigger(t);
  });
}

function sbBackupRoot_() {
  var root = getIruriRoot(), it = root.getFoldersByName(SB_BACKUP_FOLDER);
  return it.hasNext() ? it.next() : root.createFolder(SB_BACKUP_FOLDER);
}
function sbBackupFilesFolder_() {
  var root = sbBackupRoot_(), it = root.getFoldersByName(SB_BACKUP_FILES);
  return it.hasNext() ? it.next() : root.createFolder(SB_BACKUP_FILES);
}

/* 서버의 행 수(정확한 값) */
function sbCount_(table, firstPk) {
  var c = sbCfg_();
  var r = sbFetch_(c.url + '/rest/v1/' + table + '?select=' + encodeURIComponent(firstPk || '*') + '&limit=1', {
    method: 'get', muteHttpExceptions: true, headers: sbHeaders_({ Prefer: 'count=exact' })
  });
  var h = r.getHeaders(), cr = h['Content-Range'] || h['content-range'] || '';
  var m = /\/(\d+)\s*$/.exec(cr);
  if (!m) throw new Error(table + ' 행 수를 알 수 없음: ' + cr);
  return Number(m[1]);
}
/* 한 테이블 전부(1000행씩) */
function sbFetchTable_(table, pk) {
  var rows = [], from = 0, step = 1000;
  var order = pk ? '&order=' + encodeURIComponent(pk) : '';
  while (true) {
    var part = sbJson_('get', '/rest/v1/' + table + '?select=*' + order + '&offset=' + from + '&limit=' + step) || [];
    for (var i = 0; i < part.length; i++) rows.push(part[i]);
    if (part.length < step) break;
    from += step;
  }
  return rows;
}
function sbBackupTableChecked_(t) {
  var first = t.pk ? t.pk.split(',')[0] : '';
  for (var attempt = 0; attempt < 2; attempt++) {
    var rows = sbFetchTable_(t.table, t.pk);
    var n = sbCount_(t.table, first);
    if (rows.length === n) return rows;
    if (attempt === 1) throw new Error(t.table + ' 행 수 불일치: 받은 ' + rows.length + ' / 서버 ' + n);
    Utilities.sleep(3000);   // 백업 중에 누가 저장했을 수 있음 → 한 번 더
  }
}

function supabaseNightlyBackup() {
  var p = PropertiesService.getScriptProperties();
  var st = JSON.parse(p.getProperty(SB_BACKUP_STATE) || '{}');
  if (st.running && Date.now() - st.running < 6 * 60 * 1000) return;   // 앞 실행이 아직 도는 중
  st.running = Date.now(); p.setProperty(SB_BACKUP_STATE, JSON.stringify(st));
  var t0 = Date.now();
  try {
    // ① 데이터: 모든 테이블 + 로그인 계정·설정·파일 목록
    var tables = sbJson_('post', '/rest/v1/rpc/sb_backup_tables', {}) || [];
    if (!tables.length) throw new Error('테이블 목록이 비어 있음');
    var out = {
      format: 'iruri-supabase-backup', formatVersion: 1,
      backedUpAt: new Date().toISOString(), project: sbCfg_().url,
      counts: {}, tables: {}, extra: null
    };
    tables.forEach(function (t) {
      var rows = sbBackupTableChecked_(t);
      out.tables[t.table] = { pk: t.pk, rows: rows };
      out.counts[t.table] = rows.length;
    });
    out.extra = sbJson_('post', '/rest/v1/rpc/sb_backup_extra', {});
    out.counts.auth_users = (out.extra.auth_users || []).length;
    out.counts.storage_objects = (out.extra.storage_objects || []).length;

    // ② 파일 하나로 저장(압축)
    var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd_HHmmss');
    var name = SB_BACKUP_PREFIX + stamp + '.json';
    var json = JSON.stringify(out);
    var gz = Utilities.gzip(Utilities.newBlob(json, 'application/json', name), name + '.gz');
    var folder = sbBackupRoot_();
    var file = folder.createFile(gz);
    // 저장한 파일을 다시 열어 확인
    var back = JSON.parse(Utilities.ungzip(file.getBlob().setContentType('application/x-gzip')).getDataAsString());
    if (back.backedUpAt !== out.backedUpAt || Object.keys(back.tables).length !== tables.length)
      throw new Error('저장한 백업 파일을 다시 열어 보니 내용이 다름');

    // ③ 오래된 백업 정리(최근 SB_BACKUP_KEEP 개만)
    var removed = sbPruneBackups_(folder);

    // ④ 드라이브에 원본이 없는 저장소 파일 복사
    var copied = sbBackupStorageFiles_(out.extra.storage_objects || [], t0);

    st.last = out.backedUpAt; st.lastFile = file.getName(); st.lastSize = file.getSize();
    st.counts = out.counts; st.filesCopied = copied; st.lastError = '';
    sbLog_('backup', { file: file.getName(), bytes: file.getSize(), rawBytes: json.length, counts: out.counts,
                       filesCopied: copied, pruned: removed, sec: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    st.lastError = String(e).slice(0, 300);
    sbLog_('backup_error', { message: st.lastError });
    throw e;   // 트리거 실패 → 구글이 실패 알림 메일 보냄
  } finally {
    st.running = 0; p.setProperty(SB_BACKUP_STATE, JSON.stringify(st));
  }
}

function sbListBackups_(folder) {
  var list = [], it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(SB_BACKUP_PREFIX) === 0) list.push(f);
  }
  list.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });   // 최신 먼저
  return list;
}
function sbPruneBackups_(folder) {
  var list = sbListBackups_(folder), n = 0;
  for (var i = SB_BACKUP_KEEP; i < list.length; i++) { list[i].setTrashed(true); n++; }   // 휴지통(30일간 되살리기 가능)
  return n;
}

/* 드라이브에 원본이 없는 파일 = 'legacy' 저장소가 아니고, 드라이브에서 옮겨 온 'receipts/…' 도 아닌 것
 * (앱에서 새로 올린 영수증 사진 등). 이름: 저장소__경로(/ 는 __ 로). 한 번 복사하면 다시 복사하지 않음 */
function sbStorageBackupName_(o) { return o.bucket_id + '__' + String(o.name).replace(/\//g, '__'); }
function sbBackupStorageFiles_(objects, t0) {
  var need = objects.filter(function (o) {
    return o.bucket_id !== 'legacy' && !(o.bucket_id === 'receipts' && /^receipts\//.test(o.name));
  });
  if (!need.length) return 0;
  var folder = sbBackupFilesFolder_(), have = {}, it = folder.getFiles();
  while (it.hasNext()) have[it.next().getName()] = 1;
  var c = sbCfg_(), n = 0;
  for (var i = 0; i < need.length; i++) {
    var o = need[i], nm = sbStorageBackupName_(o);
    if (have[nm]) continue;
    if (Date.now() - t0 > SB_BACKUP_FILE_BUDGET_MS) break;   // 남은 건 다음 날
    var path = String(o.name).split('/').map(encodeURIComponent).join('/');
    var r = sbFetch_(c.url + '/storage/v1/object/' + o.bucket_id + '/' + path,
                     { method: 'get', muteHttpExceptions: true, headers: sbHeaders_() });
    folder.createFile(r.getBlob().setName(nm));
    n++;
  }
  return n;
}

/* 확인: 마지막 백업 파일을 열어 지금 Supabase 와 행 수 비교(아무것도 바꾸지 않음) */
function checkSupabaseBackup() {
  var st = JSON.parse(PropertiesService.getScriptProperties().getProperty(SB_BACKUP_STATE) || '{}');
  Logger.log('마지막 백업: ' + (st.last || '없음') + ' / 파일: ' + (st.lastFile || '-') + ' / 오류: ' + (st.lastError || '없음'));
  var list = sbListBackups_(sbBackupRoot_());
  if (!list.length) { Logger.log('백업 파일이 아직 없어요 — setupSupabaseBackup 을 먼저 실행하세요'); return; }
  var b = sbReadBackup_(list[0]);
  Logger.log('백업 파일 ' + list.length + '개 보관 중. 가장 최근: ' + list[0].getName());
  var tables = sbJson_('post', '/rest/v1/rpc/sb_backup_tables', {}) || [];
  tables.forEach(function (t) {
    var now = sbCount_(t.table, t.pk ? t.pk.split(',')[0] : '');
    var inB = b.tables[t.table] ? b.tables[t.table].rows.length : '(없음)';
    Logger.log((now === inB ? '  ' : '≠ ') + t.table + ': 백업 ' + inB + ' / 지금 ' + now);
  });
  Logger.log('로그인 계정: 백업 ' + b.extra.auth_users.length + '명');
}
function sbReadBackup_(file) {
  var b = JSON.parse(Utilities.ungzip(file.getBlob().setContentType('application/x-gzip')).getDataAsString());
  if (b.format !== 'iruri-supabase-backup') throw new Error('이루리 Supabase 백업 파일이 아님: ' + file.getName());
  return b;
}

/* ── 비상 복구(평소엔 실행 금지) ──
 *  Supabase 데이터가 잘못 지워지거나 망가졌을 때만. 실행하기 전에 꼭 담당자와 상의.
 *  1) 아래 RESTORE_FILE 에 되살릴 백업 파일 이름(예: supabase_백업_20261201_030012.json.gz)을 적고
 *  2) RESTORE_TABLES 에 되살릴 테이블 이름들(예: ['centers'])을 적거나, 전부면 ['*']
 *  3) RESTORE_REPLACE: false = 백업에 있는 행만 되돌림(지금 있는 다른 행은 그대로, 안전)
 *                      true  = 테이블을 백업 시점과 똑같이(백업 뒤에 생긴 행은 지워짐)
 *  4) restoreSupabaseFromBackup 실행. 테이블마다 한 번에(전부 되거나 전혀 안 되거나) 처리됨
 *  ※ 로그인 계정은 '없어진 계정만' 다시 만들고, 있는 계정·비밀번호는 건드리지 않음 */
var RESTORE_FILE = '';
var RESTORE_TABLES = [];
var RESTORE_REPLACE = false;

function restoreSupabaseFromBackup() {
  if (!RESTORE_FILE || !RESTORE_TABLES.length) throw new Error('RESTORE_FILE 과 RESTORE_TABLES 를 먼저 적어 주세요(설명은 코드 위 주석)');
  var it = sbBackupRoot_().getFilesByName(RESTORE_FILE);
  if (!it.hasNext()) throw new Error('백업 파일을 찾을 수 없음: ' + RESTORE_FILE);
  var b = sbReadBackup_(it.next());
  var all = RESTORE_TABLES.length === 1 && RESTORE_TABLES[0] === '*';
  var names = all ? Object.keys(b.tables) : RESTORE_TABLES.slice();
  names.forEach(function (n) { if (!b.tables[n]) throw new Error('백업에 없는 테이블: ' + n); });
  // 계정 → 강사 → 나머지 순서(서로 이어진 테이블 때문)
  var rank = { teachers: 1, teacher_accounts: 2, profiles: 0 };
  names.sort(function (x, y) { return (rank[x] !== undefined ? rank[x] : 9) - (rank[y] !== undefined ? rank[y] : 9) || (x < y ? -1 : 1); });
  if (all || names.indexOf('profiles') >= 0) {
    var ra = sbJson_('post', '/rest/v1/rpc/sb_restore_auth', { p_users: b.extra.auth_users, p_identities: b.extra.auth_identities });
    sbLog_('restore_auth', ra);
  }
  names.forEach(function (n) {
    var res = sbJson_('post', '/rest/v1/rpc/sb_restore_table', { p_table: n, p_rows: b.tables[n].rows, p_replace: RESTORE_REPLACE === true });
    sbLog_('restore_table', { file: RESTORE_FILE, replace: RESTORE_REPLACE === true, result: res });
  });
  Logger.log('✅ 복구 끝 — ' + names.join(', ') + ' (백업 시각 ' + b.backedUpAt + ')');
}
