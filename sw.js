const CACHE_NAME = 'pinplay-static-v21';
const STATIC_ASSETS = [
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

    // 1. Browser-Erweiterungen ignorieren
    if (!url.protocol.startsWith('http')) return;

    // 2. HTML-Seitenwechsel immer direkt über den Server laden
    if (
        req.mode === 'navigate' ||
        req.destination === 'document' ||
        (req.headers.get('accept') || '').includes('text/html')
    ) {
        return;
    }

    // 3. Live-Datenbankabfragen an Supabase niemals cachen
    if (url.hostname.includes('supabase.co') && !url.pathname.includes('/flipper-fotos/')) {
        return;
    }

    const isLocalOrigin = url.origin === self.location.origin;

    // 4. Lokale CSS- & JS-Dateien (style.css, app.js): IMMER Network-First (nie wieder altes Design!)
    if (isLocalOrigin && (url.pathname.endsWith('.css') || url.pathname.endsWith('.js'))) {
        event.respondWith(
            fetch(req, { cache: 'no-cache' })
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, networkResponse.clone()));
                    }
                    return networkResponse;
                })
                .catch(() => caches.match(url.pathname))
        );
        return;
    }

    // 5. Bilder (Logo, Flipper-Fotos) & externe Bibliotheken: Schnell aus dem Cache
    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            let cachedResponse = await cache.match(req, { ignoreSearch: isLocalOrigin });
            if (cachedResponse && cachedResponse.redirected) cachedResponse = null;

            const networkFetch = fetch(req).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && !networkResponse.redirected) {
                    const cacheKey = isLocalOrigin ? url.pathname : req;
                    cache.put(cacheKey, networkResponse.clone());
                }
                return networkResponse;
            }).catch(() => cachedResponse);

            return cachedResponse || networkFetch;
        })
    );
});
