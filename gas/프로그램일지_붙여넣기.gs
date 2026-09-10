/* ═══════════════════════════════════════════════════════════════
   이루리 · 프로그램 일지 저장 (계획서 도구 연동)  —  GAS 붙여넣기용
   ───────────────────────────────────────────────────────────────
   [붙여넣는 법]
   1) Apps Script 편집기에서 기존 Code.gs 를 연다.
   2) 아래 ②번 "함수 블록"을 Code.gs 맨 아래에 그대로 붙여넣는다.
   3) 아래 ①번 "라우트 2줄"을 doGet / doPost 에 각각 한 줄씩 추가한다.
   4) 오른쪽 위 [배포] → [배포 관리] → 연필(편집) → 버전 "새 버전" → [배포].
      (이 재배포를 꼭 해야 웹앱에 반영됩니다)
   ※ SPREADSHEET_ID 는 기존 파일에 이미 있는 값을 그대로 사용합니다.
      새로 넣을 필요 없습니다.
═══════════════════════════════════════════════════════════════ */


/* ───────── ① 라우트 2줄 (기존 doGet / doPost 안에 추가) ─────────

   ▸ doGet(e) 안, "알 수 없는 action" 을 return 하기 바로 위에 추가:

       if (action === 'getJournalRecords')
         return response(getJournalRecords(p.center, p.teacher, p.year, p.month, p.region));

   ▸ doPost(e) 안, "알 수 없는 action" 을 return 하기 바로 위에 추가:

       if (action === 'saveJournalRecord')
         return response(saveJournalRecord(body.data));

   (doGet 은 e.parameter 를 p 로, doPost 는 JSON.parse(e.postData.contents) 를
    body 로 쓰는 기존 구조를 그대로 따릅니다. response() 도 기존 함수 사용.)
───────────────────────────────────────────────────────────────── */


/* ───────── ② 함수 블록 (Code.gs 맨 아래에 붙여넣기) ───────── */

const SHEET_JOURNAL = '프로그램일지';   // 구글시트 탭 이름 + 드라이브 폴더 이름

// '프로그램일지' 시트 핸들(없으면 헤더와 함께 생성)
function _jSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(SHEET_JOURNAL);
  const header = ['저장시각','센터','지역','강사','프로그램','년','월','일','요일',
                  '진행일시','참여자','메인활동','보조활동①','보조활동②',
                  '활동목표','특이사항/총평','고유ID','폴더URL','PDF','WORD'];
  if (!sh) { sh = ss.insertSheet(SHEET_JOURNAL); sh.appendRow(header); }
  else if (sh.getLastRow() === 0) { sh.appendRow(header); }
  return sh;
}

// 하위 폴더 얻기(없으면 생성)
function _jFolder(parent, name) {
  const nm = (name || '미지정').toString().trim() || '미지정';
  const it = parent.getFoldersByName(nm);
  return it.hasNext() ? it.next() : parent.createFolder(nm);
}

// 내 드라이브 / 이루리 / 프로그램일지
function _jRoot() {
  const iruri = _jFolder(DriveApp.getRootFolder(), '이루리');
  return _jFolder(iruri, SHEET_JOURNAL);
}

// 저장: 드라이브(강사→센터→연도 폴더에 PDF·WORD) + 시트 한 줄 기록
// 같은 고유ID(=년월일_센터_강사)면 시트 줄과 드라이브 파일을 덮어써 중복 방지
function saveJournalRecord(d) {
  if (!d) return { ok:false, message:'저장할 데이터가 없어요' };
  const center = (d.center || '').toString().trim();
  if (!center) return { ok:false, message:'센터명이 비어 있어요' };
  const id = (d.id || ('J' + Date.now())).toString();

  // 1) 드라이브: 이루리/프로그램일지/강사/센터/연도 폴더에 파일 저장
  var folderUrl = '', pdfUrl = '', docUrl = '';
  try {
    if (d.files && (d.files.pdf || d.files.doc)) {
      const yf = _jFolder(_jFolder(_jFolder(_jRoot(), d.teacher), center), (d.year || '').toString());
      folderUrl = 'https://drive.google.com/drive/folders/' + yf.getId();
      const saveFile = function (f) {
        if (!f || !f.data) return '';
        const ex = yf.getFilesByName(f.name);            // 같은 이름 파일은 휴지통(덮어쓰기)
        while (ex.hasNext()) ex.next().setTrashed(true);
        const blob = Utilities.newBlob(Utilities.base64Decode(f.data), f.mime, f.name);
        return 'https://drive.google.com/file/d/' + yf.createFile(blob).getId() + '/view';
      };
      pdfUrl = saveFile(d.files.pdf);
      docUrl = saveFile(d.files.doc);
    }
  } catch (e) { /* 파일 저장 실패해도 시트 기록은 진행 */ }

  // 2) 시트 기록(덮어쓰기)
  const sh = _jSheet();
  const row = [
    new Date(), center, (d.region || '').toString(), (d.teacher || '').toString(),
    (d.program || '도구 레크레이션').toString(),
    (d.year || '').toString(), (d.month || '').toString(), (d.day || '').toString(), (d.dow || '').toString(),
    (d.dateText || '').toString(), (d.people || '').toString(),
    (d.main || '').toString(), (d.sub1 || '').toString(), (d.sub2 || '').toString(),
    (d.goal || '').toString(), (d.evalText || '').toString(), id,
    folderUrl, pdfUrl, docUrl
  ];
  const last = sh.getLastRow();
  if (last > 1) {
    const ids = sh.getRange(2, 17, last - 1, 1).getValues();   // 17번째 열 = 고유ID
    for (let i = 0; i < ids.length; i++) {
      if ((ids[i][0] || '').toString() === id) {
        const prev = sh.getRange(i + 2, 18, 1, 3).getValues()[0];   // 기존 URL 유지
        if (!folderUrl && prev[0]) row[17] = prev[0];
        if (!pdfUrl    && prev[1]) row[18] = prev[1];
        if (!docUrl    && prev[2]) row[19] = prev[2];
        sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return { ok:true, updated:true, id:id, folderUrl:row[17], pdfUrl:row[18], docUrl:row[19] };
      }
    }
  }
  sh.appendRow(row);
  return { ok:true, id:id, folderUrl:folderUrl, pdfUrl:pdfUrl, docUrl:docUrl };
}

// 조회: 센터/강사/년/월/지역으로 걸러 반환(비우면 전체)
function getJournalRecords(center, teacher, year, month, region) {
  const sh = _jSheet();
  const last = sh.getLastRow();
  if (last < 2) return { ok:true, records:[] };
  const vals = sh.getRange(2, 1, last - 1, 20).getValues();
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
