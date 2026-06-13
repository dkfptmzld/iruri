# GAS(Apps Script) 비밀번호 SHA-256 무중단 마이그레이션

클라이언트(adjustment-system.html)는 이미 SHA-256 + 레거시 fallback 으로 수정·배포됐습니다.
아래 **2곳만** Apps Script 편집기("수업기록표" 프로젝트 → `Code.gs`)에서 바꿔주세요.
바꾸고 **배포 → 새 배포(또는 기존 배포 업데이트)** 하면 됩니다.

> 동작 원리: 클라이언트가 로그인 시 `hashedPw`(SHA-256)와 `legacyPw`(옛 해시)를 함께 보냅니다.
> 서버는 ① SHA-256 일치하면 통과, ② 옛 해시가 일치하면 통과시키면서 그 자리에서 비밀번호를
> SHA-256으로 자동 교체합니다. → 기존 강사는 다음 로그인 때 자기도 모르게 전환, 재가입 불필요.

---

## ① `doPost` 안의 loginCheck 라우팅 (1줄)

**기존:**
```javascript
    if (action === 'loginCheck')            return response(loginCheck(body.teacher, body.hashedPw));
```

**변경:**
```javascript
    if (action === 'loginCheck')            return response(loginCheck(body.teacher, body.hashedPw, body.legacyPw));
```

---

## ② `loginCheck` 함수 전체 교체

**기존:**
```javascript
function loginCheck(teacher, hashedPw) {
  const sheet = getSheet(SHEET_ACCOUNTS);
  const values = sheet.getDataRange().getValues();
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === teacher) {
      if (values[i][1] === hashedPw) { sheet.getRange(i+1,4).setValue(now); return { ok: true, message: '로그인 성공' }; }
      return { ok: false, message: '비밀번호 불일치' };
    }
  }
  return { ok: false, message: '가입되지 않은 계정' };
}
```

**변경:**
```javascript
function loginCheck(teacher, hashedPw, legacyPw) {
  const sheet = getSheet(SHEET_ACCOUNTS);
  const values = sheet.getDataRange().getValues();
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === teacher) {
      const stored = String(values[i][1]);
      // 1) 신규 SHA-256 해시 일치
      if (stored === hashedPw) { sheet.getRange(i+1,4).setValue(now); return { ok: true, message: '로그인 성공' }; }
      // 2) 레거시(옛) 해시 일치 → 통과 + SHA-256 으로 지연 업그레이드
      if (legacyPw && stored === legacyPw) {
        sheet.getRange(i+1,2).setValue(hashedPw);   // 비밀번호 컬럼을 SHA-256 으로 교체
        sheet.getRange(i+1,4).setValue(now);
        return { ok: true, message: '로그인 성공' };
      }
      return { ok: false, message: '비밀번호 불일치' };
    }
  }
  return { ok: false, message: '가입되지 않은 계정' };
}
```

> `signupAccount` 는 받은 해시를 그대로 저장하므로 수정 불필요(신규 가입은 클라이언트가 이미 SHA-256 전송).

---

## 배포 순서 (안전)

1. **클라이언트 먼저 배포** (이미 완료 — 이 브랜치 푸시본). 새 클라이언트는 SHA-256+legacy 둘 다 전송.
2. **그 다음 GAS 위 2곳 수정 후 재배포.**
   - 순서가 바뀌어도 무방합니다. GAS만 먼저 바꿔도 `legacyPw` 가 없는 옛 요청은 기존처럼 `hashedPw`(옛 해시) 단순 비교로 동작하므로 깨지지 않습니다.
3. 며칠 지나면 활성 강사 대부분이 SHA-256으로 전환됩니다. (`강사계정` 시트 2열이 64자 길이면 SHA-256으로 전환된 것)

## 참고 — 남은 백엔드 보안 (선택)

- `doPost`/`doGet` 에 토큰 검사가 없습니다. 무단 호출 차단은 `SECURITY-SETUP.md` 2번 참고.
- 관리자 비밀번호는 이번 작업에서 제외(요청에 따라 그대로 유지).
