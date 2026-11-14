const CACHE_NAME = 'pinplay-static-v10';
const STATIC_ASSETS = [
    'index.html',
    'detail.html',
    'highscores.html',
    'techniker.html',
    'tech-detail.html',
    'tech-feedback.html',
    'tech-players.html',
    'style.css',
    'app.js',
    'logo.png',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    if (url.hostname.includes('supabase.co') && !url.pathname.includes('/flipper-fotos/')) {
        return;
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const isLocalPageOrAsset = url.origin === self.location.origin;

            // 1. Direkter Treffer im Cache
            let cachedResponse = await cache.match(req, {
                ignoreSearch: isLocalPageOrAsset
            });

            // 2. Falls eine saubere URL ohne ".html" (z.B. /highscores oder /detail?id=1) aufgerufen wird,
            //    automatisch die passende .html-Vorlage aus dem Cache holen
            if (!cachedResponse && isLocalPageOrAsset) {
                let fallbackPath = url.pathname;
                if (fallbackPath.endsWith('/')) {
                    fallbackPath += 'index.html';
                } else if (!fallbackPath.includes('.')) {
                    fallbackPath += '.html';
                }
                cachedResponse = await cache.match(fallbackPath, { ignoreSearch: true });
            }

            const networkFetch = fetch(req).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const cacheKey = isLocalPageOrAsset ? url.pathname : req;
                    cache.put(cacheKey, networkResponse.clone());
                }
                return networkResponse;
            }).catch(() => cachedResponse);

            return cachedResponse || networkFetch;
        })
    );
});