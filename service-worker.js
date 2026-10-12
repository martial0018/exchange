const CACHE_NAME = 'exchange-app-shell-v5';
const APP_SHELL = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/app-icon-192.png',
    '/app-icon-512.png',
    '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => Promise.all(
                cacheNames
                    .filter((cacheName) => cacheName.startsWith('exchange-app-shell-') && cacheName !== CACHE_NAME)
                    .map((cacheName) => caches.delete(cacheName))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const requestUrl = new URL(request.url);
    if (request.method !== 'GET'
        || requestUrl.origin !== self.location.origin
        || requestUrl.pathname.startsWith('/api/')
        || request.mode !== 'navigate') return;

    event.respondWith(
        fetch(request).catch(async () => {
            const cachedPage = await caches.match(request) || await caches.match('/index.html');
            if (cachedPage) return cachedPage;
            return new Response('Exchange is unavailable offline. Reconnect to the internet and try again.', {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        })
    );
});
