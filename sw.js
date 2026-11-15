/* Keeps the app itself on the phone so it opens with no signal. Maps and addresses still need a connection. */
const VERSION = 'pc-web-5';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'core.js', 'config.js', 'vendor/leaflet.js', 'vendor/leaflet.css',
  'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest',
  'jobs.js', 'jobs-core.js', 'agreement-template.js', 'vendor/jspdf.umd.min.js', 'badge.jpg', 'badge.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // maps, addresses, sync: straight to the internet
  // Newest version when online, saved copy when not.
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || caches.match('index.html'))));
});
