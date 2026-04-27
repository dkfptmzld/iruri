/* ═══════════════════════════════════════════
   이루리 실버아카데미 — Service Worker v1.2
   전략: 네트워크 우선 (항상 최신 버전)
   - HTML은 절대 캐시 안 함 (버전 업데이트 즉시 반영)
   - 아이콘/manifest만 캐시
═══════════════════════════════════════════ */
const CACHE_NAME = 'iruri-v2';
const STATIC_ASSETS = [
  '/iruri/icon-192.png',
  '/iruri/icon-512.png',
  '/iruri/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(STATIC_ASSETS))
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

  // http/https만 처리
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  // GAS 요청 캐시 제외
  if (url.includes('script.google.com')) return;

  // GET만 처리
  if (e.request.method !== 'GET') return;

  // HTML 파일은 항상 네트워크 우선 (캐시 저장 안 함)
  // → 새 버전 배포 시 즉시 반영, 임시저장 데이터 유실 방지
  if (url.includes('.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // 아이콘/manifest: 캐시 우선
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
