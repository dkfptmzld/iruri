/* ═══════════════════════════════════════════
   이루리 실버아카데미 — Service Worker v1.1
   fix: chrome-extension:// URL 캐시 오류 수정
═══════════════════════════════════════════ */
const CACHE_NAME = 'iruri-v1';
const ASSETS = [
  '/iruri/adjustment-system.html',
  '/iruri/manifest.json',
  '/iruri/icon-192.png',
  '/iruri/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // v1.1 fix: http/https 아닌 요청은 모두 무시 (chrome-extension:// 등)
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  // GAS 요청 캐시 제외
  if (url.includes('script.google.com')) return;

  // GET만 처리
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
