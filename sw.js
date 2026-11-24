const CACHE_NAME = 'pinplay-static-v22';
const PRECACHE = [
    '/logo.png',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (!url.protocol.startsWith('http')) return;

    // HTML-Navigationen & Supabase-API niemals über Cache abfangen
    if (req.mode === 'navigate' || req.destination === 'document') return;
    if (url.hostname.includes('supabase.co') && !url.pathname.includes('/flipper-fotos/')) return;

    const isLocal = url.origin === self.location.origin;

    // Lokales CSS & JS immer Network-First mit no-cache
    if (isLocal && (url.pathname.endsWith('.css') || url.pathname.endsWith('.js'))) {
        e.respondWith(
            fetch(req, { cache: 'no-cache' })
                .then((res) => {
                    if (res && res.status === 200) {
                        caches.open(CACHE_NAME).then((c) => c.put(url.pathname, res.clone()));
                    }
                    return res;
                })
                .catch(() => caches.match(url.pathname))
        );
        return;
    }

    // Bilder & CDN: Cache-First mit Hintergrund-Aktualisierung
    e.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(req, { ignoreSearch: isLocal });
            const net = fetch(req).then((res) => {
                if (res && res.status === 200 && !res.redirected) {
                    cache.put(isLocal ? url.pathname : req, res.clone());
                }
                return res;
            }).catch(() => cached);
            return cached || net;
        })
    );
});