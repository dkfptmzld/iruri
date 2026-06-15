# 이루리 정산 시스템 — 작업 규칙

## 버전 업 규칙 (필수)

`adjustment-system.html` 의 **코드를 수정할 때마다 버전을 함께 올린다.** 아무리 작은 수정이라도 예외 없음.

- 기본은 **패치 단위** 증가 (예: `v14.50` → `v14.51` → `v14.52` …).
- 수정과 버전 업을 **같은 커밋/PR** 에 묶는다.
- 버전 문자열은 아래 **4곳을 모두 동일하게** 바꾼다 (하나라도 빠지면 공유 미리보기/표시가 어긋남):

| 위치 | 형태 |
|---|---|
| `<title>` | `<title>수업기록표 정산 시스템 vX.XX</title>` |
| `og:title` (meta) | `<meta property="og:title" content="수업기록표 정산 시스템 vX.XX">` |
| `twitter:title` (meta) | `<meta name="twitter:title" content="수업기록표 정산 시스템 vX.XX">` |
| `SYSTEM_VERSION` (JS 상수) | `const SYSTEM_VERSION='vX.XX';` |

확인: `grep -nE "정산 시스템 v|SYSTEM_VERSION='v" adjustment-system.html` 로 4곳이 같은 버전인지 검증.

## 프로젝트 메모

- 단일 파일 웹앱(`adjustment-system.html`, 약 1.3MB). 백엔드는 **GAS(Google Apps Script)** — `submitRecord`, `getSubmissions`, `saveMonthlySnapshot`, `uploadReceipt`, `sendNotification` 등.
- 데이터는 localStorage 우선 + GAS 동기화(대부분 `.catch`로 백그라운드). 추가/수정은 **즉시 화면 반영 후 GAS 동기화** 패턴을 유지.
- 관리자 모드는 PC/모바일 모두 지원. 모바일 반응형 규칙은 `@media(max-width:600px)` 에 둔다.
- 렌더링 산출물이므로 변경 검증은 **실제 브라우저로 렌더해서 확인**(정적 검사만으로 끝내지 않음).

## 배포 · 보안 (주의)

- **배포:** `main` 병합 → **GitHub Pages 자동 배포** (`https://dkfptmzld.github.io/iruri/`). PWA.
- **비밀번호:** **SHA-256** 해시 사용. 기존 약한 `simpleHash`(32비트)는 legacy fallback으로 두어 다음 로그인 시 자동 전환됨. 이 로그인/해시 흐름(`doLogin`/`doSignup`의 dual-hash)을 **깨뜨리지 말 것**.
- **XSS:** 사용자 입력을 화면에 출력할 때 `esc()`로 이스케이프(`&`,`<`,`>` 처리). 새 출력 경로에도 적용.
- ⚠️ **비밀키 절대 금지:** GAS 쪽 **FCM 개인키** 등 비밀 값은 `adjustment-system.html`이나 공개 저장소에 **절대 넣지 말 것**.
- 콘솔 보안 설정(Firebase API 키 도메인 제한, GAS `doPost`/`doGet` 토큰 검사)은 코드가 아닌 **콘솔 작업** — `SECURITY-SETUP.md` 참고.
