// Viajante Pro — Service Worker v2.0
// FIX: fetch handler always returns a valid Response (no undefined returns)

const CACHE_NAME = 'vp-app-v2';
const SHELL = [
  '/viajante-pro/vp-passenger.html',
  '/viajante-pro/vp-guide.html',
  '/viajante-pro/vp-landing.html',
  '/viajante-pro/vp-manifest.json',
  '/core/auth.js',
  '/core/nexia-i18n.js',
];

// Fallback HTML for offline
const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viajante Pro — Offline</title><style>body{background:#0a0c14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}h1{font-size:28px;color:#c4955a;margin-bottom:12px}.icon{font-size:64px;margin-bottom:20px}p{color:#94a3b8;font-size:16px;max-width:300px}</style></head><body><div class="icon">✈️</div><h1>Viajante Pro</h1><p>Você está offline. Seus vouchers e agenda estão disponíveis em cache. Reconecte para sincronizar.</p></body></html>`;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .catch(() => {}) // Don't fail install if assets missing
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  // Skip chrome-extension and non-http requests
  if (!e.request.url.startsWith('http')) return;

  // Skip Firebase / Google APIs — let them go to network
  if (
    e.request.url.includes('firestore.googleapis.com') ||
    e.request.url.includes('firebase.com') ||
    e.request.url.includes('googleapis.com') ||
    e.request.url.includes('netlify.com')
  ) return;

  e.respondWith(
    caches.match(e.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(e.request)
          .then(response => {
            // Only cache valid responses
            if (!response || response.status !== 200 || response.type === 'opaque') {
              return response || new Response('', { status: 200 });
            }
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)).catch(() => {});
            return response;
          })
          .catch(() => {
            // FIX: Always return a valid Response, never undefined
            if (e.request.destination === 'document') {
              return new Response(OFFLINE_HTML, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
              });
            }
            return new Response('', { status: 200, statusText: 'Offline' });
          });
      })
      .catch(() => new Response('', { status: 200 }))
  );
});

// Push notifications
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Viajante Pro', {
      body:  data.body || '',
      icon:  '/viajante-pro/icon-192.png',
      badge: '/viajante-pro/icon-72.png',
      tag:   data.tag || 'vp-notification',
      data:  data,
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:'window' }).then(cl => {
      for (const c of cl) { if (c.url.includes('vp-') && 'focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('/viajante-pro/vp-passenger.html');
    })
  );
});
