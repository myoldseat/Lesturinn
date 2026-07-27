/* firebase-messaging-sw.js
 * Verður að liggja í rót vefsvæðis (sama scope og appið) svo /firebase-messaging-sw.js sé aðgengilegt.
 * Notar compat-SDK í service worker — það er sjálfstætt samhengi og blandast ekki modular-SDK appsins.
 *
 * Hönnun: við sendum DATA-ONLY skeyti (sjá sendTestPush.js og síðar prod-functions) og
 * BÚUM TIL tilkynninguna hér. Það tryggir eina tilkynningu (engin tvöföldun frá kerfinu)
 * og fulla stjórn á deep-link. Á iOS-PWA er skylda að push-atburður endi í showNotification —
 * þessi handler gerir það alltaf.
 */

importScripts('https://www.gstatic.com/firebasejs/12.11.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.11.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAgTY3Uxd9_ZxixjqLj-sH8V3OhFAzg6DU',
  authDomain: 'lesum-22e85.firebaseapp.com',
  projectId: 'lesum-22e85',
  storageBucket: 'lesum-22e85.firebasestorage.app',
  messagingSenderId: '204392598388',
  appId: '1:204392598388:web:2dbbe3f476cd78d2ffba21'
});

const messaging = firebase.messaging();

// Bakgrunnsskeyti (app lokað eða í bakgrunni)
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || 'UppHátt';
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,          // sama tag => uppfærir í stað þess að stafla
    data: { link: d.link || '/' }
  };
  return self.registration.showNotification(title, options);
});

// Smellur á tilkynningu => opna/fókusa á deep-link (aðeins innan eigin uppruna)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.link) || '/';
  // Origin-vörn: leyfa aðeins slóð innan eigin uppruna. Annars falla á '/'.
  let link = '/';
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin === self.location.origin) link = u.pathname + u.search + u.hash;
  } catch (_) { link = '/'; }
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(link); } catch (_) {} return c.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(link);
  })());
});
