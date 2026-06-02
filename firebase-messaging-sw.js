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
  const { title, body } = payload.notification;
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
      const url = e.notification.data?.url || '/';
      for (const c of list) {
        if (c.url === url && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
