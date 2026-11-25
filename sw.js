/* Service worker : appli disponible hors-ligne + cache des morceaux de carte */
const SHELL = '3v-shell-v1';
const TILES = '3v-tiles';
const API = '3v-api';
const FILES = ['./', 'index.html', 'style.css', 'lib.js', 'app.js', 'manifest.webmanifest',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const TILE_HOSTS = ['data.geopf.fr', 's3.amazonaws.com'];
const API_HOSTS = ['api.open-meteo.com', 'api.camptocamp.org'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('3v-shell') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fichiers de l'appli : réseau d'abord (pour les mises à jour), cache si hors-ligne
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  // Morceaux de carte : cache d'abord
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(TILES).then(c => c.match(req.url).then(hit => hit || fetch(req).then(r => {
      if (r.ok) c.put(req.url, r.clone());
      return r;
    }))));
    return;
  }
  // Données (météo, itinéraires) : réseau d'abord, dernière réponse connue si hors-ligne
  if (API_HOSTS.includes(url.hostname)) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(API).then(c => c.put(req.url, copy)); } return r; })
      .catch(() => caches.open(API).then(c => c.match(req.url)).then(r => r || Response.error())));
  }
});
