// App-shell service worker: makes the PAGE load offline. Data never goes through here —
// API responses are not cached by the worker (they live in the encrypted local store instead).
const SHELL = 'shell-v1';
const FILES = [
  '/', '/index.html', '/style.css', '/app.js',
  '/lib/backends.js', '/lib/crypto.js', '/lib/emitter.js', '/lib/http.js',
  '/lib/local-store.js', '/lib/sync.js', '/lib/tasks.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so edits show up during development), cache as the offline fallback.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(SHELL).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit ?? caches.match('/index.html'))));
});
