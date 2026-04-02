// Splash Eventos — Service Worker v1.0
const CACHE_NAME = 'splash-app-v1';
const SHELL = [
  '/splash/splash-landing.html',
  '/splash/splash-admin.html',
  '/splash/splash-manifest.json',
  '/core/auth.js',
];
const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Splash Eventos — Offline</title><style>body{background:#0a0c14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}h1{font-size:28px;color:#a855f7;margin-bottom:12px}.icon{font-size:64px;margin-bottom:20px}p{color:#94a3b8;font-size:16px;max-width:300px}</style></head><body><div class="icon">🎉</div><h1>Splash Eventos</h1><p>Você está offline. Seus eventos e reservas estão disponíveis em cache. Reconecte para sincronizar.</p></body></html>`;

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith('http')) return;
  if (e.request.url.includes('googleapis.com') || e.request.url.includes('firebase.com') || e.request.url.includes('netlify.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (!r || r.status !== 200 || r.type === 'opaque') return r || new Response('', {status:200});
        caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone())).catch(() => {});
        return r;
      }).catch(() => {
        if (e.request.destination === 'document') return new Response(OFFLINE_HTML, {status:200, headers:{'Content-Type':'text/html; charset=utf-8'}});
        return new Response('', {status:200});
      });
    }).catch(() => new Response('', {status:200}))
  );
});
