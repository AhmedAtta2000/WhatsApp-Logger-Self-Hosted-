const CACHE_NAME = 'walogger-4.2.3-media2'; // Incremented to trigger an update
const FONT_CACHE = 'walogger-fonts-4.2.3'; // New cache specifically for offline Google Fonts
const ASSETS = [
    './',
    './index.html',
    './icon.svg',
    'https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&display=swap',
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0'
];

self.addEventListener('install', (e) => {
    // skipWaiting ensures the new Service Worker takes control immediately
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
    // Automatically clean up old caches when the new one is activated
    e.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => {
                if (key !== CACHE_NAME && key !== FONT_CACHE) {
                    return caches.delete(key);
                }
            })
        ))
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Dynamic Caching for Google Fonts (CSS & WOFF2 font files) to fix offline icons
    if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
        e.respondWith(
            caches.match(e.request).then(cachedResponse => {
                // Return from cache if we already have it
                if (cachedResponse) {
                    return cachedResponse;
                }
                
                // If it isn't cached yet, fetch it from the network and save it to the FONT_CACHE
                return fetch(e.request).then(networkResponse => {
                    return caches.open(FONT_CACHE).then(cache => {
                        // Put a clone of the response in the cache
                        cache.put(e.request, networkResponse.clone());
                        return networkResponse;
                    });
                }).catch(() => {
                    // Fallback if offline and font not previously cached
                    return new Response('', { status: 404, statusText: 'Offline' });
                });
            })
        );
    } else if (url.origin === self.location.origin && e.request.method === 'GET') {
        // App files: network-first so updates show up on the next load,
        // falling back to the cached copy when offline.
        e.respondWith(
            fetch(e.request, { cache: 'no-cache' }).then(networkResponse => {
                if (networkResponse.ok) {
                    const copy = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy));
                }
                return networkResponse;
            }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
        );
    }
    // Backend requests (API, SSE streams, media) go straight to the network.
});
