const CACHE_NAME = 'pinplay-static-v12';
const STATIC_ASSETS = [
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

    // 1. Browser-Erweiterungen (chrome-extension://) sofort ignorieren
    if (!url.protocol.startsWith('http')) return;

    // 2. HTML-Seitenwechsel (Klicks auf Unterseiten) immer direkt über Nginx ausliefern
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        return;
    }

    // 3. Live-Datenbankabfragen an Supabase nicht im Service Worker cachen
    if (url.hostname.includes('supabase.co') && !url.pathname.includes('/flipper-fotos/')) {
        return;
    }

    // 4. Nur statische Dateien (CSS, JS, Logo, Flipper-Fotos) schnell aus dem Cache liefern
    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const isLocalAsset = url.origin === self.location.origin;

            let cachedResponse = await cache.match(req, {
                ignoreSearch: isLocalAsset
            });

            const networkFetch = fetch(req).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && !networkResponse.redirected) {
                    const cacheKey = isLocalAsset ? url.pathname : req;
                    cache.put(cacheKey, networkResponse.clone());
                }
                return networkResponse;
            }).catch(() => cachedResponse);

            return cachedResponse || networkFetch;
        })
    );
});
