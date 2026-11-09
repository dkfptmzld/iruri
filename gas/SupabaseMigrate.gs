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
    summary.push({ sheet: name, rows: vals.length, cols: vals.length ? vals[0].length : 0 });
  }
  sbLog_('sheets', { spreadsheet: ss_().getId().slice(0, 6) + '…', count: sheets.length, sheets: summary });
  return summary;
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
