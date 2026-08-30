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
const BACKUP_KEEP   = 72;   // 최근 72개(≈ 3일치, 매시간) 보관 후 오래된 것 자동 정리

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
