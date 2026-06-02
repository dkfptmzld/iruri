/* ═══════════════════════════════════════════
   이루리 실버아카데미 — Service Worker v2.0
   전략: 네트워크 우선 (항상 최신 버전)
   + Firebase Cloud Messaging 푸시 알림 지원
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
  const title = payload.notification?.title || '이루리 정산 시스템';
  const body  = payload.notification?.body  || '';
  self.registration.showNotification(title, {
    body,
    icon: '/iruri/icon-192.png',
    badge: '/iruri/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: 'https://dkfptmzld.github.io/iruri/adjustment-system.html' }
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
