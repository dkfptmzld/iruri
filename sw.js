/* ═══════════════════════════════════════════
   이루리 실버아카데미 — Service Worker v2.1
   전략: 네트워크 우선 (항상 최신 버전)
   + Firebase Cloud Messaging 푸시 알림 지원
═══════════════════════════════════════════ */
const CACHE_NAME = 'iruri-v20';
const STATIC_ASSETS = [
  '/iruri/icon-192.png',
  '/iruri/icon-512.png',
  '/iruri/logo.png',
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
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;
  if (url.includes('script.google.com')) return;
  if (e.request.method !== 'GET') return;
  if (url.includes('.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
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

/* ═══ Firebase Cloud Messaging ═══ */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyB7Ek_fy1kQX10bMgU-c-wl15cQ8qsPxDw",
  authDomain: "iruri-settlement.firebaseapp.com",
  projectId: "iruri-settlement",
  storageBucket: "iruri-settlement.firebasestorage.app",
  messagingSenderId: "34878096416",
  appId: "1:34878096416:web:7cafa9e7faf45376092845"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  // data 페이로드 우선, notification 필드는 폴백
  const title = payload.data?.title || payload.notification?.title || '이루리 정산 시스템';
  const body  = payload.data?.body  || payload.notification?.body  || '';

  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    const foreground = clientList.filter(c => c.visibilityState === 'visible');
    if (foreground.length > 0) {
      // 앱 열려있음(포그라운드) → postMessage로 앱에 전달, 시스템 알림 생략
      foreground.forEach(c => c.postMessage({ type: 'FCM_FOREGROUND', title, body }));
      return;
    }
    // 백그라운드/종료 → 시스템 알림 1개만
    self.registration.showNotification(title, {
      body,
      icon: '/iruri/icon-192.png',
      badge: '/iruri/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: 'https://dkfptmzld.github.io/iruri/adjustment-system.html' }
    });
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const url = e.notification.data?.url || 'https://dkfptmzld.github.io/iruri/adjustment-system.html';
      for (const c of list) {
        if (c.url === url && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
