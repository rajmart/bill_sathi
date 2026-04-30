'use strict';

/**
 * sw.js — Bill Sathi Service Worker
 * Caches app shell for offline use.
 * Strategy: Cache-first for static assets, network-first for data.
 */

const CACHE_NAME   = 'bill-sathi-v1';
const RUNTIME_CACHE = 'bill-sathi-runtime-v1';

// ─── Assets to cache on install ──────────────────────────────────────────────
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './css/main.css',
  './css/billing.css',
  './css/khata.css',
  './js/storage.js',
  './js/products.js',
  './js/khata.js',
  './js/billing.js',
  './js/voice.js',
  './js/bill-print.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './manifest.json',
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Pre-caching app shell');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed:', err))
  );
});

// ─── Activate — clean up old caches ──────────────────────────────────────────
self.addEventListener('activate', event => {
  const validCaches = [CACHE_NAME, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys()
      .then(cacheNames =>
        Promise.all(
          cacheNames
            .filter(name => !validCaches.includes(name))
            .map(name => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ─── Fetch — cache-first strategy ────────────────────────────────────────────
self.addEventListener('fetch', event => {
  // Only handle GET requests on same origin
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip cross-origin requests (Google Fonts CDN is runtime-cached below)
  if (url.origin !== location.origin && !url.hostname.includes('fonts.')) {
    return;
  }

  // Google Fonts — stale-while-revalidate
  if (url.hostname.includes('fonts.')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request)
            .then(response => {
              cache.put(event.request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // App shell — cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request)
        .then(response => {
          // Cache successful responses
          if (response && response.status === 200 && response.type === 'basic') {
            const toCache = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
          }
          return response;
        })
        .catch(() => {
          // Fallback to index.html for navigation requests
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});

// ─── Message — force update ───────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
