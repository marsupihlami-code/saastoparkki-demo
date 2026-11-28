'use strict';
const version = 'turku-zones-1';
const cacheName = 'saastoparkki-' + version;
const versioned = ['app.js', 'style.css', 'leaflet.js', 'leaflet.css', 'manifest.webmanifest', 'places-turku-street.json', 'places-tampere-street.json', 'turku-parking-zones.geojson'];
const shell = ['./', ...versioned.map(file => file + '?v=' + version), 'possu.png', 'inva.webp',
  'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('saastoparkki-') && key !== cacheName)
    .map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(request.mode === 'navigate' ? './' : request) || Response.error();
  }));
});
