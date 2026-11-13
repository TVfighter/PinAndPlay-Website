const CACHE_NAME = 'pinplay-static-v7';
const STATIC_ASSETS = [
    'index.html',
    'detail.html',
    'highscores.html',
    'techniker.html',
    'tech-detail.html',
    'tech-feedback.html',
    'style.css',
    'app.js',
    'logo.png',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// 1. Beim ersten Start alle HTML-, CSS- und JS-Dateien im Voraus herunterladen
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
});

// 2. Alte Caches aufräumen und sofort die Kontrolle übernehmen
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
        ).then(() => self.clients.claim())
    );
});

// 3. Seitenwechsel abfangen und in 0 ms aus dem lokalen Speicher beantworten
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Datenbank-Abfragen an Supabase NIEMALS im Service Worker abfangen
    // (Ausnahme: öffentliche Flipper-Fotos dürfen gecacht werden)
    if (url.hostname.includes('supabase.co') && !url.pathname.includes('/flipper-fotos/')) {
        return;
    }

    // Für alle eigenen HTML-, CSS- und JS-Dateien sowie das Supabase-Skript:
    // ignoreSearch: true sorgt dafür, dass detail.html?id=5 sofort die gespeicherte detail.html nutzt!
    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const isLocalPageOrAsset = url.origin === self.location.origin;
            const cachedResponse = await cache.match(req, {
                ignoreSearch: isLocalPageOrAsset
            });

            // Im Hintergrund still nach Datei-Updates schauen (falls du am Code arbeitest)
            const networkFetch = fetch(req).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const cacheKey = isLocalPageOrAsset ? url.pathname : req;
                    cache.put(cacheKey, networkResponse.clone());
                }
                return networkResponse;
            }).catch(() => cachedResponse);

            // Wenn schon im Speicher -> SOFORT (0 ms) zurückgeben, sonst auf Netzwerk warten
            return cachedResponse || networkFetch;
        })
    );
});
