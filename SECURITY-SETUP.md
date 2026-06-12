# 보안 설정 가이드 (콘솔/서버)

이 문서의 항목은 **HTML 코드가 아니라 Firebase·Google Apps Script 콘솔에서 직접 설정**해야 하는
부분입니다. (코드 푸시로는 적용되지 않습니다.)

---

## 1. Firebase API 키 도메인 제한

코드에 노출된 Firebase 키(`AIzaSy...`) 자체는 웹 특성상 공개가 정상이지만,
**우리 도메인에서만 작동**하도록 잠가두면 키 도용을 막을 수 있습니다.

### 설정 방법
1. [Google Cloud Console → API 및 서비스 → 사용자 인증 정보](https://console.cloud.google.com/apis/credentials) 접속
   (프로젝트: **iruri-settlement** 선택)
2. 브라우저 키(`Browser key (auto created by Firebase)`) 클릭
3. **애플리케이션 제한사항** → `HTTP 리퍼러(웹사이트)` 선택
4. **웹사이트 제한사항**에 아래 추가:
   ```
   https://dkfptmzld.github.io/*
   https://iruri-settlement.firebaseapp.com/*
   ```
5. 저장

> ⚠️ 저장 후 실제 사이트에서 로그인·푸시 알림이 정상 동작하는지 한 번 확인하세요.

---

## 2. Google Apps Script(GAS) 무단 호출 차단

서버 주소(`script.google.com/macros/s/...`)가 공개돼 있어, 앱을 거치지 않고도
누구나 직접 호출할 수 있습니다. **공유 토큰(secret)** 을 둬서 정해진 요청만 받도록 막습니다.

### GAS 측 (Apps Script 편집기)
`doPost` / `doGet` 맨 앞에 토큰 검사를 추가합니다:

```javascript
const APP_TOKEN = 'PR옆에붙일_긴_랜덤_문자열_여기에';

function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  if (body.token !== APP_TOKEN) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, message: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // ... 기존 로직 ...
}
```

### 클라이언트 측 (adjustment-system.html)
`gasPost` / `gasGet` 가 보내는 body·params 에 동일한 `token` 을 추가하면 됩니다.
> 이 변경은 GAS 코드를 확인한 뒤 클라이언트와 함께 맞춰 적용하는 것이 안전합니다.
> (현재 비밀번호 해시 강화 작업과 함께 진행 예정)

---

## 3. (예정) 비밀번호 해시 강화 — GAS 코드 필요

현재 비밀번호는 약한 32비트 해시(`simpleHash`)로 저장됩니다.
SHA-256 으로 **무중단 전환**하려면 클라이언트와 GAS 서버를 함께 수정해야 합니다.

진행하려면 Apps Script 의 현재 코드(계정 저장/검증 부분)를 공유해 주세요.
받는 즉시 기존 사용자에게 영향 없이(옛 해시 fallback → 로그인 시 자동 업그레이드)
적용할 수 있는 드롭인 코드를 작성해 드립니다.
