/* ═══════════════════════════════════════════
   이루리 실버아카데미 — Service Worker
   전략: 네트워크 우선(Network-First)
   - 온라인: 항상 최신 버전 서빙 (GitHub Push 즉시 반영)
   - 오프라인: 캐시에서 서빙
═══════════════════════════════════════════ */
const CACHE_NAME = 'iruri-v1';
const ASSETS = [
  '/iruri/adjustment-system.html',
  '/iruri/manifest.json',
  '/iruri/icon-192.png',
  '/iruri/icon-512.png'
];

/* 설치: 핵심 파일 캐시 */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* 활성화: 이전 캐시 정리 */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* 요청 처리: 네트워크 우선 → 실패 시 캐시 */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  /* Google Apps Script 요청은 캐시 제외 (항상 네트워크) */
  if (e.request.url.includes('script.google.com')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        /* 성공 시 캐시 갱신 */
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
