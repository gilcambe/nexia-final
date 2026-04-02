// CES Brasil 2027 — Service Worker v1.0
// Offline-first for executive delegate app

const CACHE_NAME = 'ces-app-v1';
const SHELL = [
  '/ces/ces-app-executivo.html',
  '/ces/ces-landing.html',
  '/ces/ces-manifest.json',
  '/core/auth.js',
  '/core/nexia-i18n.js',
];

const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CES 2027 — Offline</title><style>body{background:#0a0c14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}h1{font-size:28px;color:#00c6ff;margin-bottom:12px}.icon{font-size:64px;margin-bottom:20px}p{color:#94a3b8;font-size:16px;max-width:300px}</style></head><body><div class="icon">⚡</div><h1>CES Brasil 2027</h1><p>Você está offline. Sua agenda e crachá estão disponíveis em cache. Reconecte para ver atualizações.</p></body></html>`;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith('http')) return;
  if (e.request.url.includes('googleapis.com') || e.request.url.includes('firebase.com')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res || new Response('', { status: 200 });
        caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone())).catch(() => {});
        return res;
      }).catch(() => {
        if (e.request.destination === 'document') {
          return new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return new Response('', { status: 200 });
      });
    }).catch(() => new Response('', { status: 200 }))
  );
});

self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'CES Brasil 2027', {
    body: d.body || '', icon: '/ces/ces-icon-192.png', badge: '/ces/ces-icon-72.png',
    tag: d.tag || 'ces-notification', data: d, vibrate: [200, 100, 200]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(cl => {
    for (const c of cl) { if (c.url.includes('ces-') && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('/ces/ces-app-executivo.html');
  }));
});
