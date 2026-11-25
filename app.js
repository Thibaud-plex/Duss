/* app.js — 3V Sécurité : carte, détails, météo, alertes, forfaits, partage de position */
(function () {
  'use strict';
  const L = window.L3V;
  const $ = s => document.querySelector(s);
  const esc = L.esc;

  // ------------------------------------------------------------------ Stockage local (sans planter si indisponible)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('3v.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('3v.' + k, JSON.stringify(v)); } catch (e) { /* rien */ } }
  };

  // ------------------------------------------------------------------ Sources de données
  const URLS = {
    ign: (layer, fmt) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${fmt}`,
    dem: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'],
    c2c: 'https://api.camptocamp.org',
    meteo: 'https://api.open-meteo.com/v1/forecast',
    topo: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    bera: id => `https://public-api.meteofrance.fr/public/DPBRA/v1/massif/BRA?id-massif=${id}&format=xml`
  };
  const LAYERS_IGN = {
    plan: URLS.ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'),
    ortho: URLS.ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'),
    slopes: URLS.ign('GEOGRAPHICALGRIDSYSTEMS.SLOPES.MOUNTAIN', 'image/png'),
    traces: URLS.ign('TRACES.RANDO.HIVERNALE', 'image/png')
  };

  // ------------------------------------------------------------------ Prix publics (relevés le 19/11/2026 sur les sites grand public)
  const PRICES = {
    checked: '19 novembre 2026',
    season: 'Domaine 3 Vallées ouvert du 5 décembre 2026 au 18 avril 2027 (Val Thorens dès le 21 novembre).',
    groups: [
      { title: 'Forfait 3 Vallées (tout le domaine)', sectors: ['courchevel', 'meribel', 'valthorens', 'orelle', 'belleville'], rows: [
        ['1 jour adulte', '84,20 €', '75,70 € du 5 au 18 déc. 2026 et du 10 au 18 avr. 2027'],
        ['6 jours adulte', '421 €', '378,50 € en début et fin de saison'],
        ['1 jour le samedi (en ligne)', '67,30 €', 'acheté en ligne avant le vendredi minuit'],
        ['Saison adulte', '1 620 €', 'prix public annoncé pour 2026-2027']
      ], src: [['lesmenuires.com', 'https://lesmenuires.com/en/ski-passes'], ['alti-mag.com', 'https://www.alti-mag.com/tarifs-forfaits-de-ski/tarifs-forfaits-ski-alpes/tarifs-forfaits-ski-alpes-du-nord']] },
      { title: 'Les Menuires / Saint-Martin-de-Belleville', sectors: ['belleville'], rows: [
        ['1 jour adulte', '70 €', '63 € en début et fin de saison'],
        ['6 jours adulte', '350 €', '315 € en début et fin de saison'],
        ['1 jour le samedi (en ligne)', '41 €', '']
      ], src: [['lesmenuires.com', 'https://lesmenuires.com/en/ski-passes']] },
      { title: 'Val Thorens – Orelle', sectors: ['valthorens', 'orelle'], rows: [
        ['1 jour adulte', '73,50 €', 'domaine Val Thorens – Orelle seulement']
      ], src: [['guide-ski.fr', 'https://guide-ski.fr/?p=626']] },
      { title: 'Vallée de Courchevel', sectors: ['courchevel'], rows: [
        ['Forfait vallée', 'voir le site', 'prix 2026-2027 non confirmés au moment de la mise à jour']
      ], src: [['courchevel.com', 'https://www.courchevel.com']] },
      { title: 'Vallée de Méribel', sectors: ['meribel'], rows: [
        ['Forfait vallée', 'voir le site', 'prix 2026-2027 non confirmés au moment de la mise à jour']
      ], src: [['meribel.net', 'https://www.meribel.net']] }
    ]
  };

  // ------------------------------------------------------------------ État
  const state = {
    map: null, data: null, routes: null, pos: null, is3d: false, base: 'relief', slopes: false, layers: {}, domain: null, ring: null, peakMarkers: [],
    slopeSource: 'ign', wx: null, wxAt: null, selected: null
  };

  // ------------------------------------------------------------------ Petits outils d'interface
  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 3500);
  }
  function modal(html, onReady) {
    $('#modalCard').innerHTML = html; $('#modal').classList.remove('hidden');
    if (onReady) onReady($('#modalCard'));
  }
  function closeModal() { $('#modal').classList.add('hidden'); }
  async function fetchJSON(url, opts, timeoutMs) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs || 25000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  // Petit cache de données (Cache API) pour l'usage hors-ligne
  async function cacheGet(key, maxAgeMs) {
    try {
      const c = await caches.open('3v-data'); const r = await c.match('https://3v.local/' + key);
      if (!r) return null;
      const saved = +r.headers.get('x-saved') || 0;
      const json = await r.json();
      return { json, fresh: Date.now() - saved < maxAgeMs, saved };
    } catch (e) { return null; }
  }
  async function cachePut(key, json) {
    try {
      const c = await caches.open('3v-data');
      await c.put('https://3v.local/' + key, new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json', 'x-saved': String(Date.now()) } }));
    } catch (e) { /* rien */ }
  }

  // ------------------------------------------------------------------ Altitude : lecture des tuiles de relief
  const demTiles = new Map();
  function loadDemTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (demTiles.has(key)) return demTiles.get(key);
    const p = (async () => {
      const url = URLS.dem.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error('relief indisponible');
      const bmp = await createImageBitmap(await r.blob());
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
      const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0);
      return cx.getImageData(0, 0, 256, 256).data;
    })();
    p.catch(() => demTiles.delete(key));
    demTiles.set(key, p);
    if (demTiles.size > 300) demTiles.delete(demTiles.keys().next().value);
    return p;
  }
  async function elevAt(lng, lat, z) {
    z = z || 14;
    const t = L.lngLatToTile(lng, lat, z);
    const tx = Math.floor(t.x), ty = Math.floor(t.y);
    const px = Math.min(255, Math.floor((t.x - tx) * 256)), py = Math.min(255, Math.floor((t.y - ty) * 256));
    const d = await loadDemTile(z, tx, ty);
    const i = (py * 256 + px) * 4;
    return L.terrariumDecode(d[i], d[i + 1], d[i + 2]);
  }
  async function elevations(points) {
    return Promise.all(points.map(p => elevAt(p[0], p[1]).catch(() => NaN)));
  }

  // Calque de pentes calculé à partir du relief (secours si la carte des pentes IGN ne répond pas)
  function slopeProtocol(params) {
    const m = /slope:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const z = +m[1], x = +m[2], y = +m[3];
    return loadDemTile(z, x, y).then(d => {
      const lat = L.tileToLngLat(x, y + 0.5, z)[1];
      const res = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z; // m par pixel
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
      const cx = cv.getContext('2d'); const out = cx.createImageData(256, 256);
      const h = (i, j) => { i = Math.max(0, Math.min(255, i)); j = Math.max(0, Math.min(255, j)); const k = (j * 256 + i) * 4; return L.terrariumDecode(d[k], d[k + 1], d[k + 2]); };
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const dzdx = (h(i + 1, j) - h(i - 1, j)) / (2 * res), dzdy = (h(i, j + 1) - h(i, j - 1)) / (2 * res);
        const s = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
        let c = null;
        if (s >= 45) c = [176, 54, 159]; else if (s >= 40) c = [227, 0, 27]; else if (s >= 35) c = [255, 140, 0]; else if (s >= 30) c = [242, 230, 0];
        const k = (j * 256 + i) * 4;
        if (c) { out.data[k] = c[0]; out.data[k + 1] = c[1]; out.data[k + 2] = c[2]; out.data[k + 3] = 150; }
      }
      cx.putImageData(out, 0, 0);
      return new Promise(res2 => cv.toBlob(b => b.arrayBuffer().then(buf => res2({ data: buf })), 'image/png'));
    });
  }

  // ------------------------------------------------------------------ Carte
  // Palette d'altitude (vallées vertes -> alpages -> rochers -> neiges éternelles)
  const HYPSO = ['interpolate', ['linear'], ['elevation'],
    400, '#4f7f35', 1000, '#6f9a3f', 1500, '#9db454', 1900, '#cfc675', 2250, '#dcc38f',
    2600, '#c49c72', 2900, '#a37d5e', 3200, '#948c86', 3450, '#d9dee3', 3800, '#ffffff'];

  function initMap() {
    maplibregl.addProtocol('slope', slopeProtocol);
    // Courbes de niveau calculées à partir du relief, dans un « worker » pour ne pas ralentir
    let contourUrl = null;
    try {
      state.demContour = new mlcontour.DemSource({ url: URLS.dem, encoding: 'terrarium', maxzoom: 14, worker: true, cacheSize: 80 });
      state.demContour.setupMaplibre(maplibregl);
      contourUrl = state.demContour.contourProtocolUrl({
        thresholds: { 10: [200, 1000], 11: [100, 500], 12: [100, 500], 13: [50, 250], 14: [20, 100], 15: [10, 50] },
        elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours'
      });
    } catch (e) { contourUrl = null; }

    const attrIGN = '© <a href="https://www.ign.fr">IGN</a>';
    const dom = store.get('domain', null);
    const map = new maplibregl.Map({
      container: 'map',
      center: L.CENTER, zoom: 11, pitch: 0, maxPitch: 80, minZoom: 9.5,
      maxBounds: dom ? boundsFor(dom, 9000) : [[L.BBOX.west - 0.12, L.BBOX.south - 0.1], [L.BBOX.east + 0.12, L.BBOX.north + 0.1]],
      attributionControl: { compact: true },
      style: {
        version: 8,
        glyphs: URLS.glyphs,
        sky: { 'sky-color': '#7fb0dd', 'horizon-color': '#dfe6ec', 'fog-color': '#dfe6ec', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.55, 'atmosphere-blend': 0 },
        sources: Object.assign({
          plan: { type: 'raster', tiles: [LAYERS_IGN.plan], tileSize: 256, maxzoom: 19, attribution: attrIGN },
          ortho: { type: 'raster', tiles: [LAYERS_IGN.ortho], tileSize: 256, maxzoom: 19, attribution: attrIGN },
          topo: { type: 'raster', tiles: URLS.topo, tileSize: 256, maxzoom: 17, attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' },
          dem: { type: 'raster-dem', tiles: [URLS.dem], tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Relief © AWS Terrain Tiles' },
          demHill: { type: 'raster-dem', tiles: [URLS.dem], tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
          slopesIgn: { type: 'raster', tiles: [LAYERS_IGN.slopes], tileSize: 256, maxzoom: 17, attribution: attrIGN },
          slopesCalc: { type: 'raster', tiles: ['slope://{z}/{x}/{y}'], tileSize: 256, minzoom: 10, maxzoom: 14 },
          traces: { type: 'raster', tiles: [LAYERS_IGN.traces], tileSize: 256, maxzoom: 18, attribution: attrIGN }
        }, contourUrl ? { contours: { type: 'vector', tiles: [contourUrl], maxzoom: 15 } } : {}),
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#dfe6ec' } },
          { id: 'relief', type: 'color-relief', source: 'demHill', paint: { 'color-relief-color': HYPSO, 'color-relief-opacity': 1 } },
          { id: 'plan', type: 'raster', source: 'plan', layout: { visibility: 'none' } },
          { id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
          { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
          { id: 'hill', type: 'hillshade', source: 'demHill', paint: { 'hillshade-exaggeration': 0.75, 'hillshade-shadow-color': '#2e241b', 'hillshade-highlight-color': '#fff7e2', 'hillshade-accent-color': '#4a3b2c', 'hillshade-illumination-direction': 315 } },
          { id: 'slopesIgn', type: 'raster', source: 'slopesIgn', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.62 } },
          { id: 'slopesCalc', type: 'raster', source: 'slopesCalc', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } },
          { id: 'traces', type: 'raster', source: 'traces', layout: { visibility: 'none' } }
        ].concat(contourUrl ? [
          { id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours', paint: {
            'line-color': 'rgba(70,45,20,0.45)', 'line-width': ['match', ['get', 'level'], 1, 1.3, 0.5] } },
          { id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0], minzoom: 12.5,
            layout: { 'symbol-placement': 'line', 'text-size': 12, 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'], 'text-font': ['Noto Sans Regular'] },
            paint: { 'text-color': '#4a3520', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.4 } }
        ] : [])
      }
    });
    state.map = map;
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true });
    map.addControl(geo, 'bottom-right');
    state.geo = geo;
    geo.on('geolocate', e => {
      state.pos = { lat: e.coords.latitude, lon: e.coords.longitude, alt: e.coords.altitude, acc: e.coords.accuracy, t: Date.now() };
      $('#btnLocate').classList.add('on');
    });
    geo.on('trackuserlocationend', () => $('#btnLocate').classList.remove('on'));
    geo.on('error', () => toast('Position GPS indisponible. Autorise la localisation dans Réglages › Confidentialité.'));

    map.on('error', e => {
      if (e && e.sourceId === 'slopesIgn' && state.slopeSource === 'ign') {
        state.slopeSource = 'calc';
        if (state.slopes) setSlopes(true);
      }
    });
    map.on('load', () => {
      addDataLayers();
      if (dom) applyDomain(dom, false);
      loadOSM();
      loadRoutes();
      // Ouverture directement en 3D, cadrée sur le domaine
      setTimeout(() => set3D(true, true), 300);
    });
    map.on('click', onMapClick);
    map.once('movestart', () => { const h = $('#hint'); h.style.opacity = '0'; setTimeout(() => h.classList.add('hidden'), 700); });
    return map;
  }

  function boundsFor(ring, marginM) {
    const b = L.polyBBox(L.bufferHull(ring, marginM));
    return [[b.west, b.south], [b.east, b.north]];
  }

  function addDataLayers() {
    const map = state.map;
    const empty = { type: 'FeatureCollection', features: [] };
    ['mask', 'maskSoft', 'pistes', 'lifts', 'freeride', 'routes', 'selected', 'access'].forEach(id => map.addSource(id, { type: 'geojson', data: empty }));
    // Masque : seul le domaine et ses abords restent visibles
    map.addLayer({ id: 'maskSoft', type: 'fill', source: 'maskSoft', paint: { 'fill-color': '#dfe6ec', 'fill-opacity': 0.55 } });
    map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#dfe6ec', 'fill-opacity': 0.97 } });
    const diffColor = ['match', ['get', 'difficulty'], ['novice', 'easy'], '#1e9e4a', 'intermediate', '#1f6feb', 'advanced', '#e3261b', 'expert', '#111111', '#7a8796'];
    map.addLayer({ id: 'pistes-casing', type: 'line', source: 'pistes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 15, 8], 'line-opacity': 0.85 } });
    map.addLayer({ id: 'pistes', type: 'line', source: 'pistes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': diffColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 15, 5] } });
    map.addLayer({ id: 'freeride', type: 'line', source: 'freeride', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff6a00', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 15, 4.5], 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'lifts', type: 'line', source: 'lifts', paint: { 'line-color': '#101a26', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.3, 15, 3.2] } });
    map.addLayer({ id: 'routes', type: 'circle', source: 'routes', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 11], 'circle-color': '#ff6a00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', filter: ['!=', '$type', 'Point'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#00e5ff', 'line-width': 8, 'line-opacity': 0.8 } });
    map.addLayer({ id: 'access-line', type: 'line', source: 'access', filter: ['!=', '$type', 'Point'], paint: { 'line-color': '#7b2cff', 'line-width': 4, 'line-dasharray': [1, 1.2] } });
    map.addLayer({ id: 'access-pts', type: 'circle', source: 'access', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 9, 'circle-color': ['match', ['get', 'role'], 'start', '#ff6a00', 'pin', '#101a26', '#7b2cff'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  }

  // Contour du domaine -> masque, limites de déplacement
  function applyDomain(hull, fly) {
    const map = state.map;
    state.domain = hull;
    state.ring = L.bufferHull(hull, 2500);
    map.getSource('maskSoft').setData(L.maskPolygon(L.bufferHull(hull, 1200)));
    map.getSource('mask').setData(L.maskPolygon(state.ring));
    map.setMaxBounds(boundsFor(hull, 9000));
    if (fly) frameDomain(state.is3d);
  }
  function frameDomain(threeD) {
    const ring = state.ring || L.bufferHull([[L.BBOX.west, L.BBOX.south], [L.BBOX.east, L.BBOX.south], [L.BBOX.east, L.BBOX.north], [L.BBOX.west, L.BBOX.north]], 0);
    const b = L.polyBBox(ring);
    const cam = state.map.cameraForBounds([[b.west, b.south], [b.east, b.north]], { padding: { top: 90, bottom: 30, left: 10, right: 80 } });
    if (!cam) return;
    const opts = { center: cam.center, zoom: cam.zoom + (threeD ? 0.9 : 0), pitch: threeD ? 62 : 0, bearing: threeD ? 200 : 0, duration: 1200, freezeElevation: true };
    if (threeD && typeof state.map.getCenterElevation === 'function') {
      const g = state.map.queryTerrainElevation(cam.center);
      if (Number.isFinite(g)) opts.elevation = g;
    }
    state.map.easeTo(opts);
  }

  // Quelques sommets repères, affichés comme étiquettes
  function showPeaks() {
    (state.peakMarkers || []).forEach(m => m.remove());
    state.peakMarkers = [];
    if (!state.data || !state.layers.peaks) return;
    const list = L.pickPeaks(state.data.peaks.features, state.ring, 9, 3500);
    for (const f of list) {
      const el = document.createElement('div');
      el.className = 'peak';
      el.innerHTML = `<div class="pl"><b>${esc(f.properties.name)}</b><small>${f.properties.ele.toLocaleString('fr-FR')} m</small></div><div class="tri"></div>`;
      el.addEventListener('click', ev => { ev.stopPropagation(); showPeak(f); });
      state.peakMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom', opacityWhenCovered: '0' }).setLngLat(f.geometry.coordinates).addTo(state.map));
    }
  }

  // ------------------------------------------------------------------ Chargement des pistes, remontées et sommets (OpenStreetMap)
  async function loadOSM() {
    const cached = await cacheGet('osm2', 7 * 864e5);
    if (cached) applyOSM(cached.json);
    if (cached && cached.fresh) return;
    const body = 'data=' + encodeURIComponent(L.overpassQuery(L.BBOX));
    for (const url of URLS.overpass) {
      try {
        const json = await fetchJSON(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 90000);
        if (!json.elements || !json.elements.length) throw new Error('vide');
        await cachePut('osm2', json);
        applyOSM(json);
        return;
      } catch (e) { /* serveur suivant */ }
    }
    if (!cached) toast('Impossible de charger les pistes (réseau ?). Réessaie plus tard.', 6000);
  }
  function applyOSM(json) {
    const d = L.osmToGeoJSON(json);
    state.data = d;
    const map = state.map;
    map.getSource('pistes').setData(d.pistes);
    map.getSource('freeride').setData(d.freeride);
    map.getSource('lifts').setData(d.lifts);
    const hull = L.domainFrom(d);
    if (hull) {
      const first = !store.get('domain', null);
      store.set('domain', hull);
      applyDomain(hull, first);
    }
    showPeaks();
  }

  // ------------------------------------------------------------------ Itinéraires hors-piste (Camptocamp)
  function c2cBbox() {
    const a = L.lngLatToMerc(L.BBOX.west, L.BBOX.south), b = L.lngLatToMerc(L.BBOX.east, L.BBOX.north);
    return [a[0], a[1], b[0], b[1]].map(Math.round).join(',');
  }
  async function loadRoutes() {
    const cached = await cacheGet('c2c-routes', 7 * 864e5);
    if (cached) applyRoutes(cached.json);
    if (cached && cached.fresh) return;
    try {
      const all = { documents: [] };
      for (let off = 0; off < 1000; off += 100) {
        const j = await fetchJSON(`${URLS.c2c}/routes?bbox=${c2cBbox()}&act=skitouring&limit=100&offset=${off}&pl=fr`);
        all.documents.push(...(j.documents || []));
        if (!j.documents || j.documents.length < 100 || all.documents.length >= (j.total || 0)) break;
      }
      await cachePut('c2c-routes', all);
      applyRoutes(all);
    } catch (e) {
      if (!cached) toast('Itinéraires hors-piste indisponibles pour le moment.', 5000);
    }
  }
  function applyRoutes(json) {
    const fc = L.c2cListToGeoJSON(json);
    fc.features = fc.features.filter(f => {
      const [x, y] = f.geometry.coordinates;
      return x >= L.BBOX.west && x <= L.BBOX.east && y >= L.BBOX.south && y <= L.BBOX.north;
    });
    state.routes = fc;
    state.map.getSource('routes').setData(fc);
  }

  // ------------------------------------------------------------------ Toucher la carte -> fiche détail, ou pente du point touché
  function onMapClick(e) {
    const map = state.map;
    const pad = 16; // zone de toucher généreuse (gants)
    const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    const layers = ['routes', 'lifts', 'freeride', 'pistes'].filter(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
    const feats = map.queryRenderedFeatures(box, { layers });
    if (!feats.length) return showPoint([e.lngLat.lng, e.lngLat.lat]);
    const order = { routes: 0, freeride: 1, lifts: 2, pistes: 3 };
    feats.sort((a, b) => order[a.layer.id] - order[b.layer.id]);
    const f = feats[0];
    const p = f.properties;
    let full = null;
    if (p.kind === 'route') full = state.routes.features.find(x => x.properties.id === p.id);
    else if (state.data) full = [...state.data.pistes.features, ...state.data.freeride.features, ...state.data.lifts.features].find(x => x.properties.id === p.id);
    showDetail(full || f);
  }

  // Pente, orientation et altitude à l'endroit touché
  async function showPoint(pt) {
    const id = 'pt' + pt.join(',');
    state.selected = id;
    state.map.getSource('selected').setData({ type: 'FeatureCollection', features: [] });
    state.map.getSource('access').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: { role: 'pin' } }] });
    openSheet('<p class="muted">Calcul de la pente…</p>');
    const d = 20; // mètres
    const dLng = d / (111320 * Math.cos(pt[1] * Math.PI / 180)), dLat = d / 110540;
    const [z0, zE, zW, zN, zS] = await elevations([pt, [pt[0] + dLng, pt[1]], [pt[0] - dLng, pt[1]], [pt[0], pt[1] + dLat], [pt[0], pt[1] - dLat]]);
    if (state.selected !== id) return;
    if (![z0, zE, zW, zN, zS].every(Number.isFinite)) { openSheet('<h2>Point touché</h2><p>Relief indisponible ici (pas de réseau ?).</p>'); return; }
    const sa = L.slopeAspect(zE, zW, zN, zS, d);
    const s = Math.round(sa.slope);
    const col = s >= 45 ? '#b0369f' : s >= 40 ? '#e3001b' : s >= 35 ? '#ff8c00' : s >= 30 ? '#f2e600' : '#cfe8c4';
    const txt = s >= 50
      ? `<div class="note red"><b>Pente de ${s}°</b> : terrain extrême (souvent rocheux ou barres). Une chute y devient une glissade incontrôlable.</div>`
      : s >= 30
      ? `<div class="note ${s >= 35 ? 'red' : ''}"><b>Pente de ${s}°</b> : ${s >= 35 ? 'c’est la zone où partent le plus d’avalanches.' : 'une avalanche peut partir à partir de 30°.'} Compare l'orientation (${L.cardinal(sa.aspect)}) avec celles citées dans le bulletin du jour.</div>`
      : '<p>Pente modérée : peu de risque qu’une avalanche parte <b>ici</b>, mais attention aux pentes raides au-dessus.</p>';
    const r = riskToday();
    openSheet(`<h2>📍 Ici</h2>
      <div class="hero"><div class="num" style="background:${col};color:${s >= 40 ? '#fff' : '#101a26'}">${s}°</div>
        <div><p><b>Altitude ${Math.round(z0).toLocaleString('fr-FR')} m</b></p><p>Pente orientée <b>${L.cardinal(sa.aspect)}</b></p>${r ? `<p class="small">Risque du jour : <b>${r.level}/5</b></p>` : ''}</div></div>
      ${txt}
      <p class="muted small">Calculé sur un modèle de terrain d'environ 30 m : localement, ça peut être plus raide (rochers, corniches).</p>
      ${natureHTML(z0)}`);
  }

  async function showPeak(f) {
    const p = f.properties;
    state.selected = p.id;
    openSheet(`<h2>⛰️ ${esc(p.name)}</h2><div class="stats">${statBox(p.ele.toLocaleString('fr-FR') + ' m', 'Altitude')}</div>${natureHTML(p.ele)}
      <p class="muted small">Sommet repère (OpenStreetMap).</p>`);
  }

  function openSheet(html, tall) {
    $('#sheetBody').innerHTML = html;
    $('#sheet').classList.remove('hidden');
    $('#sheet').classList.toggle('tall', !!tall);
    $('#sheet').scrollTop = 0;
  }
  function closeSheet() {
    $('#sheet').classList.add('hidden');
    const empty = { type: 'FeatureCollection', features: [] };
    state.map.getSource('selected').setData(empty);
    state.map.getSource('access').setData(empty);
    state.selected = null;
  }

  function lineCoords(geom) {
    if (!geom) return [];
    if (geom.type === 'LineString') return geom.coordinates;
    if (geom.type === 'MultiLineString') return geom.coordinates.reduce((a, l) => a.concat(l), []);
    return [];
  }

  async function showDetail(f) {
    const p = f.properties;
    state.selected = p.id;
    if (f.geometry.type !== 'Point') state.map.getSource('selected').setData({ type: 'FeatureCollection', features: [f] });
    state.map.getSource('access').setData({ type: 'FeatureCollection', features: [] });
    if (p.kind === 'lift') return showLift(f);
    if (p.kind === 'route') return showRoute(f);
    return showPiste(f);
  }

  function tagFor(p) {
    const c = { novice: '#1e9e4a', easy: '#1e9e4a', intermediate: '#1f6feb', advanced: '#e3261b', expert: '#111' }[p.difficulty] || '#ff7a00';
    return `<span class="tag" style="background:${c}">${esc(p.label)}</span>`;
  }
  function slopeClass(s) { return s >= 40 ? 'danger' : s >= 30 ? 'warn' : ''; }
  function statBox(val, lbl, cls) { return `<div class="stat ${cls || ''}"><b>${val}</b><span>${lbl}</span></div>`; }

  async function lineProfile(coords) {
    const pts = L.resample(coords, 20).slice(0, 600);
    const el = await elevations(pts);
    const okPts = [], okEl = [];
    pts.forEach((pt, i) => { if (Number.isFinite(el[i])) { okPts.push(pt); okEl.push(el[i]); } });
    if (okPts.length < 3) return null;
    const st = L.slopeStats(okPts, okEl, 40);
    st.points = okPts; st.elevs = okEl;
    return st;
  }

  async function showPiste(f) {
    const p = f.properties;
    const coords = lineCoords(f.geometry);
    const isOff = p.kind === 'freeride';
    const len = L.lineLength(coords);
    openSheet(`<h2>${esc(p.name || (isOff ? 'Itinéraire hors-piste' : 'Piste sans nom'))}</h2>${tagFor(p)}
      <div class="stats" id="pStats">${statBox(L.fmtDist(len), 'Longueur')}${statBox('…', 'Calcul du relief')}</div>
      <div id="pMore"><p class="muted small">Calcul de la pente et de la neige…</p></div>`);
    const prof = await lineProfile(coords).catch(() => null);
    if (state.selected !== p.id) return;
    let html = statBox(L.fmtDist(len), 'Longueur');
    const mins = L.descentMinutes(len, p.difficulty || (isOff ? 'freeride' : ''));
    html += statBox(`~${mins} min`, 'Durée de descente estimée');
    if (prof) {
      html += statBox(`${Math.round(prof.maxSlope)}°`, 'Pente la plus raide', slopeClass(prof.maxSlope));
      html += statBox(`${Math.round(prof.down)} m`, `Dénivelé (de ${Math.round(prof.top)} à ${Math.round(prof.bottom)} m)`);
    }
    $('#pStats').innerHTML = html;
    const top = prof ? prof.points[prof.elevs.indexOf(prof.top)] : coords[0];
    const more = [];
    if (prof && prof.maxSlope >= 30) more.push(`<div class="note ${prof.maxSlope >= 35 ? 'red' : ''}">Passage à ~${Math.round(prof.maxSlope)}° : ${prof.maxSlope >= 35 ? 'pente où les avalanches partent le plus souvent.' : 'pente à partir de laquelle une avalanche peut partir.'} ${isOff ? 'À éviter dès que le risque est marqué (3) ou plus.' : ''}</div>`);
    more.push(`<p class="muted small">Pente calculée sur un modèle de terrain d'environ 30 m : localement, ça peut être plus raide.</p>`);
    $('#pMore').innerHTML = more.join('') + `<div id="snowBox"></div><div id="accessBox"></div>` + natureHTML(prof ? prof.top : null) + (isOff ? notesHTML(p.id) : '') + sourceOSM(p);
    snowFor(top || coords[0], prof ? prof.top : null);
    if (isOff && prof) accessFor(prof.points[prof.elevs.indexOf(prof.top)], prof.top, p.id);
    if (isOff) bindNotes(p.id);
  }

  async function showLift(f) {
    const p = f.properties;
    const c = lineCoords(f.geometry);
    const len = L.lineLength(c);
    const sec = L.sector(c[0][0], c[0][1]);
    openSheet(`<h2>${esc(p.name || 'Remontée')}</h2><span class="tag" style="background:#14202e">${esc(p.label)}</span>
      <div class="stats" id="lStats"></div><div id="lMore"></div>`);
    let elA = NaN, elB = NaN;
    try { [elA, elB] = await elevations([c[0], c[c.length - 1]]); } catch (e) { /* rien */ }
    if (state.selected !== p.id) return;
    let html = statBox(L.fmtDist(len), 'Longueur');
    html += statBox(`~${L.liftMinutes(len, p.liftType, p.duration)} min`, p.duration ? 'Durée du trajet' : 'Durée estimée');
    if (Number.isFinite(elA) && Number.isFinite(elB)) {
      html += statBox(`${Math.round(Math.max(elA, elB))} m`, 'Altitude d’arrivée');
      html += statBox(`${Math.round(Math.abs(elB - elA))} m`, 'Dénivelé');
    }
    if (p.occupancy) html += statBox(`${esc(p.occupancy)} places`, 'Par siège / cabine');
    if (p.capacity) html += statBox(`${esc(p.capacity)} pers/h`, 'Débit');
    $('#lStats').innerHTML = html;
    const extras = [];
    if (p.heating === 'yes') extras.push('sièges chauffants');
    if (p.bubble === 'yes') extras.push('bulle de protection');
    const groups = PRICES.groups.filter(g => g.sectors.includes(sec));
    $('#lMore').innerHTML = (extras.length ? `<p>${extras.join(', ')}</p>` : '') +
      `<div class="block"><h3>🎟️ Forfaits qui donnent accès à cette remontée</h3>
       <p class="muted small">Secteur : ${esc(L.SECTOR_LABEL[sec])}. Il n'y a pas de ticket à l'unité : on paie un forfait.</p>
       ${groups.map(g => `<p><b>${esc(g.title)}</b><br>${g.rows.slice(0, 2).map(r => `${esc(r[0])} : <b>${esc(r[1])}</b>`).join('<br>')}</p>`).join('')}
       <button class="btn secondary block" data-goto="forfaits">Voir tous les prix</button></div>` +
      natureHTML(Number.isFinite(elB) ? Math.max(elA, elB) : null) + sourceOSM(p);
  }

  async function showRoute(f) {
    const p = f.properties;
    const pt = f.geometry.coordinates;
    const link = `https://www.camptocamp.org/routes/${p.c2c}`;
    openSheet(`<h2>${esc(p.name)}</h2><span class="tag" style="background:#ff7a00">Hors-piste / randonnée</span>
      <div class="stats" id="rStats">
        ${p.ski_rating ? statBox(esc(p.ski_rating), 'Difficulté de ski') : ''}
        ${p.ski_exposition ? statBox(esc(p.ski_exposition), 'Exposition (gravité d’une chute)', /E3|E4/.test(p.ski_exposition) ? 'danger' : p.ski_exposition === 'E2' ? 'warn' : '') : ''}
        ${p.elevation_max ? statBox(p.elevation_max + ' m', 'Point le plus haut') : ''}
        ${p.height_diff_down ? statBox(p.height_diff_down + ' m', 'Dénivelé de descente') : ''}
      </div>
      <div class="actions"><button class="btn" id="goAccess">🧭 Y aller</button><button class="btn danger" data-goto="position">📍 Prévenir</button></div>
      <div id="rMore"><p class="muted small">Chargement du tracé et de la description…</p></div>`, true);
    $('#goAccess').onclick = () => { const b = $('#accessBox'); if (b && b.firstChild) b.scrollIntoView({ behavior: 'smooth' }); else toast('Calcul de l\u2019accès en cours…'); };
    let doc = null;
    try { doc = await fetchJSON(`${URLS.c2c}/routes/${p.c2c}?cook=fr`); }
    catch (e) { const c = await cacheGet('c2c-' + p.c2c, 1e12); doc = c && c.json; }
    if (doc) cachePut('c2c-' + p.c2c, doc);
    if (state.selected !== p.id) return;
    const geom = doc && L.c2cGeomToLngLat(doc.geometry && doc.geometry.geom_detail);
    const coords = lineCoords(geom);
    let prof = null;
    if (coords.length > 1) {
      state.map.getSource('selected').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geom, properties: {} }] });
      prof = await lineProfile(coords).catch(() => null);
      if (state.selected !== p.id) return;
      if (prof) $('#rStats').insertAdjacentHTML('beforeend',
        statBox(`${Math.round(prof.maxSlope)}°`, 'Pente la plus raide (calculée)', slopeClass(prof.maxSlope)) +
        statBox(`~${L.descentMinutes(prof.length, 'freeride')} min`, 'Durée de descente estimée'));
    }
    const top = prof ? prof.points[prof.elevs.indexOf(prof.top)] : pt;
    const topAlt = prof ? prof.top : (p.elevation_max || null);
    const parts = [];
    if (p.ski_rating) parts.push(`<p><b>Difficulté :</b> ${esc(L.skiRatingText(p.ski_rating))}</p>`);
    if (p.ski_exposition) parts.push(`<p><b>Exposition :</b> ${esc(L.EXPO[p.ski_exposition] || p.ski_exposition)}</p>`);
    if (p.orientations) parts.push(`<p><b>Orientation des pentes :</b> ${esc(p.orientations)} <span class="muted small">(à comparer avec les orientations dangereuses du bulletin avalanche)</span></p>`);
    if (!coords.length) parts.push(`<p class="muted small">Pas de tracé détaillé publié pour cet itinéraire : le point orange indique seulement le secteur.</p>`);
    let desc = '';
    if (doc) {
      const ck = doc.cooked || {};
      const loc = (doc.locales || []).find(l => l.lang === 'fr') || (doc.locales || [])[0] || {};
      const raw = ck.description || loc.description || '';
      desc = ck.description ? htmlToText(raw) : L.c2cPlain(raw);
      const rem = ck.remarks ? htmlToText(ck.remarks) : L.c2cPlain(loc.remarks || '');
      if (rem) desc += (desc ? '\n\n' : '') + 'Remarques : ' + rem;
    }
    $('#rMore').innerHTML = parts.join('') +
      `<div id="accessBox"></div>` +
      (desc ? `<div class="block"><h3>Description (Camptocamp)</h3><p style="white-space:pre-wrap">${esc(desc.slice(0, 2500))}${desc.length > 2500 ? '…' : ''}</p></div>` : '') +
      `<div id="snowBox"></div>` + natureHTML(topAlt) + notesHTML(p.id) +
      `<div class="block"><p class="small">Fiche complète, photos et sorties récentes : <a href="${link}" target="_blank" rel="noopener">ouvrir sur Camptocamp</a>. Données collaboratives (licence CC BY-SA) : à recouper sur place.</p></div>`;
    bindNotes(p.id);
    snowFor(top, topAlt);
    if (top) accessFor(top, topAlt, p.id);
  }

  function htmlToText(html) {
    const d = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    d.querySelectorAll('br,p,li,h1,h2,h3,h4').forEach(n => n.insertAdjacentText('afterend', '\n'));
    return d.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }
  function sourceOSM(p) {
    return p.osm ? `<p class="muted small" style="margin-top:12px">Tracé : OpenStreetMap (<a href="https://www.openstreetmap.org/way/${p.osm}" target="_blank" rel="noopener">voir</a>).</p>` : '';
  }
  function natureHTML(alt) {
    const n = L.nature(alt);
    return `<div class="block"><h3>🦌 Faune et flore ici — ${esc(n.zone)}</h3>
      <p><b>Plantes :</b> ${esc(n.flora)}</p><p><b>Animaux :</b> ${esc(n.fauna)}</p><p class="muted small">${esc(n.tip)}</p></div>`;
  }
  function notesHTML(id) {
    const notes = store.get('notes', {});
    return `<div class="block"><h3>📝 Mes notes sur cet itinéraire</h3>
      <p class="muted small">Ce que tu as appris sur place (conseil d'un pisteur, repère, piège à éviter). Enregistré sur ce téléphone.</p>
      <textarea id="noteArea" placeholder="ex. : rester rive gauche après le gros rocher, barre rocheuse en bas à droite">${esc(notes[id] || '')}</textarea></div>`;
  }
  function bindNotes(id) {
    const ta = $('#noteArea'); if (!ta) return;
    ta.addEventListener('input', () => { const n = store.get('notes', {}); n[id] = ta.value; store.set('notes', n); });
  }

  // ------------------------------------------------------------------ Comment rejoindre le départ (calculé, pas inventé)
  async function accessFor(start, startAlt, id) {
    const box = $('#accessBox'); if (!box || !state.data || !start) return;
    const lifts = state.data.lifts.features.filter(f => !['magic_carpet', 'rope_tow'].includes(f.properties.liftType));
    // Présélection : extrémités les plus proches
    const cands = lifts.map(f => {
      const c = f.geometry.coordinates; const a = c[0], b = c[c.length - 1];
      return { f, a, b, d: Math.min(L.haversine(a, start), L.haversine(b, start)) };
    }).sort((x, y) => x.d - y.d).slice(0, 8);
    if (!cands.length) return;
    let sAlt = startAlt;
    if (!Number.isFinite(sAlt)) sAlt = await elevAt(start[0], start[1]).catch(() => NaN);
    const scored = [];
    for (const c of cands) {
      const [ea, eb] = await elevations([c.a, c.b]);
      const top = (Number.isFinite(eb) && Number.isFinite(ea) && ea > eb) ? { pt: c.a, alt: ea } : { pt: c.b, alt: eb };
      const dist = L.haversine(top.pt, start);
      const climb = Number.isFinite(sAlt) && Number.isFinite(top.alt) ? sAlt - top.alt : 0;
      scored.push({ f: c.f, top, dist, climb, score: dist + Math.max(0, climb) * 8 });
    }
    scored.sort((x, y) => x.score - y.score);
    if (state.selected !== id) return;
    const best = scored[0];
    const br = L.bearing(best.top.pt, start);
    const name = best.f.properties.name || 'sans nom';
    const steps = [];
    steps.push(`Prends <b>${esc(best.f.properties.label)} « ${esc(name)} »</b> jusqu'à l'arrivée${Number.isFinite(best.top.alt) ? ` (≈ ${Math.round(best.top.alt)} m)` : ''}.`);
    if (best.dist < 80) steps.push('Le départ de l’itinéraire est juste à côté de la gare d’arrivée.');
    else steps.push(`Depuis l'arrivée, le départ est à <b>≈ ${L.fmtDist(best.dist)} vers le ${L.cardinal(br)}</b> (distance à vol d'oiseau, voir le trait violet sur la carte).`);
    if (best.climb > 40) steps.push(`Il faut <b>remonter ≈ ${Math.round(best.climb)} m</b> à pied, en peaux ou par une autre remontée : prévoir le temps et l'équipement.`);
    else if (best.climb < -60) steps.push(`Le départ est ≈ ${Math.round(-best.climb)} m plus bas que l'arrivée : on le rejoint en descendant (souvent par une piste voisine).`);
    steps.push('Sur place, vérifie que la remontée est ouverte et repère les panneaux « danger / hors-piste ». En cas de doute, demande aux pisteurs au sommet.');
    const alt2 = scored[1] && scored[1].f !== best.f ? scored[1] : null;
    box.innerHTML = `<div class="block"><h3>🧭 Comment rejoindre le départ</h3><ol class="steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
      ${alt2 ? `<p class="small muted">Autre possibilité : ${esc(alt2.f.properties.label)} « ${esc(alt2.f.properties.name || 'sans nom')} » (départ à ≈ ${L.fmtDist(alt2.dist)} de son arrivée).</p>` : ''}
      <div class="note">Ces indications sont <b>calculées automatiquement</b> à partir de la carte (remontée la plus proche, distance et direction). Le passage réel peut devoir contourner des rochers ou des barres : regarde la carte des pentes et ne t'engage jamais dans une pente que tu ne vois pas jusqu'en bas.</div>
      <button class="btn block" id="showAccess">🗺️ Voir le trajet sur la carte</button></div>`;
    const accessFC = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [best.top.pt, start] }, properties: {} },
      { type: 'Feature', geometry: { type: 'Point', coordinates: best.top.pt }, properties: { role: 'lift' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: start }, properties: { role: 'start' } }
    ] };
    state.map.getSource('access').setData(accessFC);
    $('#showAccess').onclick = () => {
      const b = new maplibregl.LngLatBounds(best.top.pt, best.top.pt); b.extend(start);
      state.map.fitBounds(b, { padding: { top: 80, bottom: window.innerHeight * 0.5, left: 40, right: 70 }, maxZoom: 15.5, freezeElevation: true });
    };
  }

  // ------------------------------------------------------------------ Météo (Open-Meteo, modèle AROME de Météo-France)
  const wxCache = new Map();
  async function getWeather(lng, lat, alt) {
    const key = `${lng.toFixed(2)},${lat.toFixed(2)},${Math.round((alt || 0) / 100)}`;
    const c = wxCache.get(key);
    if (c && Date.now() - c.t < 20 * 60e3) return c.d;
    const base = `${URLS.meteo}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` + (Number.isFinite(alt) ? `&elevation=${Math.round(alt)}` : '') +
      '&hourly=temperature_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,wind_direction_10m,freezing_level_height' +
      '&minutely_15=precipitation,snowfall,temperature_2m,wind_gusts_10m' +
      '&past_days=3&forecast_days=2&forecast_minutely_15=24&timezone=Europe%2FParis';
    let d;
    try { d = await fetchJSON(base + '&models=meteofrance_seamless'); }
    catch (e) { d = await fetchJSON(base); }
    wxCache.set(key, { t: Date.now(), d });
    cachePut('wx-last', d);
    return d;
  }
  function wxSummary(d) {
    const H = d.hourly; const now = Date.now();
    const idx = H.time.map(t => new Date(t).getTime());
    const cur = Math.max(0, idx.findIndex(t => t > now - 3600e3));
    const sum = (arr, from, to) => arr.slice(Math.max(0, from), to).reduce((a, b) => a + (b || 0), 0);
    const nums = arr => arr.filter(v => v != null);
    const past72 = Math.max(0, cur - 72), past48 = Math.max(0, cur - 48);
    const next = { from: cur, to: Math.min(idx.length, cur + 6) };
    const temps48 = nums(H.temperature_2m.slice(past48, cur + 1));
    const snowSum = H.snowfall ? sum(H.snowfall, next.from, next.to) : 0;
    const rainNext = H.rain ? H.rain.slice(next.from, next.to).some((r, i) => r > 0.2 && (H.temperature_2m[next.from + i] || 0) > 0.5) : false;
    const s = {
      cur, next,
      fresh72: H.snowfall ? sum(H.snowfall, past72, cur) : 0,
      fresh24: H.snowfall ? sum(H.snowfall, Math.max(0, cur - 24), cur) : 0,
      tmax: temps48.length ? Math.max(...temps48) : 0,
      tmin: temps48.length ? Math.min(...temps48) : 0,
      tnow: H.temperature_2m[cur],
      windMax: Math.max(0, ...nums((H.wind_gusts_10m || []).slice(past48, cur + 1))),
      gustMax: Math.max(0, ...nums((H.wind_gusts_10m || []).slice(next.from, next.to))),
      snow5h: snowSum,
      visMin: (() => { const v = nums((H.visibility || []).slice(next.from, next.to)); return v.length ? Math.min(...v) : null; })(),
      feelsMin: (() => { const v = nums((H.apparent_temperature || []).slice(next.from, next.to)); return v.length ? Math.min(...v) : null; })(),
      rainOnSnow: rainNext
    };
    return s;
  }
  const WMO = {
    0: ['☀️', 'Grand beau'], 1: ['🌤️', 'Peu nuageux'], 2: ['⛅', 'Nuageux'], 3: ['☁️', 'Couvert'], 45: ['🌫️', 'Brouillard'], 48: ['🌫️', 'Brouillard givrant'],
    51: ['🌦️', 'Bruine'], 53: ['🌦️', 'Bruine'], 55: ['🌧️', 'Bruine forte'], 56: ['🌧️', 'Bruine verglaçante'], 57: ['🌧️', 'Bruine verglaçante'],
    61: ['🌧️', 'Pluie faible'], 63: ['🌧️', 'Pluie'], 65: ['🌧️', 'Forte pluie'], 66: ['🌧️', 'Pluie verglaçante'], 67: ['🌧️', 'Pluie verglaçante'],
    71: ['🌨️', 'Neige faible'], 73: ['🌨️', 'Neige'], 75: ['❄️', 'Forte neige'], 77: ['🌨️', 'Grains de neige'],
    80: ['🌦️', 'Averses'], 81: ['🌧️', 'Averses'], 82: ['⛈️', 'Fortes averses'], 85: ['🌨️', 'Averses de neige'], 86: ['❄️', 'Fortes averses de neige'],
    95: ['⛈️', 'Orage'], 96: ['⛈️', 'Orage + grêle'], 99: ['⛈️', 'Orage + grêle']
  };
  const arrow = d => d == null ? '' : `<span style="display:inline-block;transform:rotate(${d + 180}deg)">↑</span>`;

  function wxPlace() {
    if (state.pos && Date.now() - state.pos.t < 30 * 60e3) return { lng: state.pos.lon, lat: state.pos.lat, label: 'Ta position' };
    const c = state.map.getCenter();
    return { lng: c.lng, lat: c.lat, label: 'Centre de la carte' };
  }

  async function renderMeteo() {
    const body = $('#meteoBody');
    const pl = wxPlace();
    body.innerHTML = '<p class="muted">Chargement des prévisions…</p>';
    const alt = await elevAt(pl.lng, pl.lat).catch(() => NaN);
    let d, offline = false;
    try { d = await getWeather(pl.lng, pl.lat, alt); }
    catch (e) {
      const c = await cacheGet('wx-last', 1e12);
      if (!c) { body.innerHTML = '<div class="card"><p>Prévisions indisponibles (pas de réseau ?).</p></div>'; return; }
      d = c.json; offline = true;
    }
    state.wx = d; const s = wxSummary(d); state.wxSum = s;
    updateWxChip(d, s);
    const H = d.hourly; const c = s.cur;
    const w0 = WMO[H.weather_code[c]] || ['🌡️', ''];
    const vis = i => H.visibility && H.visibility[i] != null ? (H.visibility[i] >= 10000 ? '> 10 km' : L.fmtDist(H.visibility[i])) : '—';
    let hours = '';
    for (let i = s.next.from + 1; i < Math.min(s.next.to + 1, H.time.length); i++) {
      const w = WMO[H.weather_code[i]] || ['', ''];
      const bad = (H.wind_gusts_10m[i] >= 60) || (H.visibility && H.visibility[i] != null && H.visibility[i] < 300) || (H.snowfall && H.snowfall[i] >= 2);
      hours += `<div class="hour ${bad ? 'bad' : ''}">${new Date(H.time[i]).getHours()}h<div class="e">${w[0]}</div><b>${Math.round(H.temperature_2m[i])}°</b>💨 ${Math.round(H.wind_gusts_10m[i])}<br>${H.snowfall && H.snowfall[i] ? '❄️ ' + H.snowfall[i].toFixed(1).replace('.', ',') : '&nbsp;'}</div>`;
    }
    let bars = '';
    const M = d.minutely_15;
    if (M && M.time) {
      const now = Date.now();
      const ids = M.time.map((t, i) => [new Date(t).getTime(), i]).filter(([t]) => t >= now - 15 * 60e3).slice(0, 20).map(x => x[1]);
      const vals = ids.map(i => (M.snowfall && M.snowfall[i]) || (M.precipitation && M.precipitation[i] / 10) || 0);
      const max = Math.max(0.5, ...vals);
      if (ids.length) bars = `<div class="card"><h3>Neige / pluie, quart d'heure par quart d'heure</h3><div class="bars">${vals.map(v => `<div style="height:${Math.round(v / max * 100)}%"></div>`).join('')}</div>
        <div class="bars-x"><span>maintenant</span><span>+5 h</span></div>
        <p class="muted small">${vals.some(v => v > 0) ? 'Maximum : ' + max.toFixed(1).replace('.', ',') + ' cm de neige en 15 min (ou équivalent en pluie).' : 'Pas de précipitation prévue.'}</p></div>`;
    }
    const snow = L.estimateSnow(s);
    const al = L.weatherAlerts(s);
    body.innerHTML = (offline ? '<div class="note">Hors-ligne : dernières prévisions enregistrées.</div>' : '') +
      (al.length ? `<div class="card" style="border:3px solid #e3261b"><h3>⚠️ À surveiller</h3>${al.map(a => `<div class="alert"><span class="lv" style="background:${['', '#ffe14d', '#ff9a2e', '#e3261b'][a.lvl]}"></span><span>${esc(a.t)}</span></div>`).join('')}</div>` : '') +
      `<div class="card"><div class="now"><span class="ic">${w0[0]}</span><span class="t">${Math.round(H.temperature_2m[c])}°</span>
        <span><b>${esc(w0[1])}</b> · ressenti ${H.apparent_temperature ? Math.round(H.apparent_temperature[c]) + '°' : '—'}</span></div>
        <div class="kv" style="margin-top:12px">
          <span>Vent / rafales</span><b>${Math.round(H.wind_speed_10m[c])} / ${Math.round(H.wind_gusts_10m[c])} km/h ${arrow(H.wind_direction_10m && H.wind_direction_10m[c])}</b>
          <span>Visibilité</span><b>${vis(c)}</b>
          <span>Limite pluie-neige (0°)</span><b>${H.freezing_level_height && H.freezing_level_height[c] != null ? Math.round(H.freezing_level_height[c] / 50) * 50 + ' m' : '—'}</b>
          <span>Neige fraîche 24 h / 3 j</span><b>${s.fresh24.toFixed(0)} / ${s.fresh72.toFixed(0)} cm</b>
        </div>
        <div class="hours">${hours}</div>
        <p class="muted small">📍 ${esc(pl.label)}${Number.isFinite(alt) ? ` — ${Math.round(alt)} m` : ''} · Météo-France (AROME) via Open-Meteo, recalculé à cette altitude. Les cases rouges signalent vent fort, jour blanc ou grosse chute de neige.</p></div>
      ${bars}
      <div class="card"><h3>❄️ Neige probable</h3><p><b>${esc(snow.label)}</b></p>${snow.notes.map(n => `<p class="small">${esc(n)}</p>`).join('')}
      <p class="muted small">Estimation à partir de la météo des derniers jours, pas une observation sur place.</p></div>`;
  }

  function updateWxChip(d, s) {
    const H = d.hourly; const i = s.cur; const w = WMO[H.weather_code[i]] || ['🌡️', ''];
    $('#wxIcon').textContent = w[0];
    $('#wxMain').textContent = `${Math.round(H.temperature_2m[i])}° · ${esc(w[1])}`;
    const al = L.weatherAlerts(s);
    $('#wxSub').textContent = `rafales ${Math.round(H.wind_gusts_10m[i])} km/h` + (al.some(a => a.lvl >= 2) ? ' ⚠️' : '');
    $('#wxIcon').style.background = al.some(a => a.lvl >= 3) ? '#ffd9d6' : al.some(a => a.lvl >= 2) ? '#ffecd2' : '#e3e8ee';
  }

  async function snowFor(pt, alt) {
    const box = $('#snowBox'); if (!box || !pt) return;
    const id = state.selected;
    try {
      const d = await getWeather(pt[0], pt[1], alt);
      if (state.selected !== id) return;
      const s = wxSummary(d); const sn = L.estimateSnow(s);
      const H = d.hourly; const w = WMO[H.weather_code[s.cur]] || ['', ''];
      box.innerHTML = `<div class="block"><h3>❄️ Neige et météo ici</h3>
        <p><b>${esc(sn.label)}</b> <span class="muted small">(estimation d'après la météo des 3 derniers jours)</span></p>
        ${sn.notes.map(n => `<p class="small">${esc(n)}</p>`).join('')}
        <p class="small">Maintenant : ${w[0]} ${Math.round(H.temperature_2m[s.cur])}°C, rafales ${Math.round(H.wind_gusts_10m[s.cur])} km/h · neige fraîche 3 j : ${s.fresh72.toFixed(0)} cm</p></div>`;
    } catch (e) { box.innerHTML = ''; }
  }

  const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  // ------------------------------------------------------------------ Alertes : risque avalanche + météo + sorties récentes
  function riskToday() {
    const r = store.get('risk', null);
    if (!r) return null;
    const today = localDay();
    return r.day === today ? r : null;
  }
  function updateRiskChip() {
    const r = riskToday();
    const num = $('#riskNum');
    if (r && L.RISK[r.level]) {
      num.textContent = r.level; num.style.background = L.RISK[r.level].color; num.style.color = r.level >= 4 ? '#fff' : '#101a26';
      $('#riskName').textContent = `Risque ${L.RISK[r.level].name.toLowerCase()}`;
      $('#riskSub').textContent = r.src && /Bulletin/.test(r.src) ? 'bulletin officiel' : 'saisi aujourd’hui';
    } else {
      num.textContent = '?'; num.style.background = '#e3e8ee'; num.style.color = '#101a26';
      $('#riskName').textContent = 'Avalanche';
      $('#riskSub').textContent = 'saisir le niveau';
    }
  }

  async function fetchBERA() {
    const key = store.get('beraKey', '');
    if (!key) return null;
    const r = await fetch(URLS.bera(L.MASSIF_BERA_VANOISE), { headers: { apikey: key, accept: '*/*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const root = xml.documentElement;
    const risk = xml.querySelector('RISQUE');
    const pente = xml.querySelector('PENTE');
    const dirs = pente ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].filter(k => pente.getAttribute(k) === 'true') : [];
    const txt = sel => { const n = xml.querySelector(sel); return n ? n.textContent.trim() : ''; };
    return {
      date: root.getAttribute('DATEBULLETIN'), valid: root.getAttribute('DATEVALIDITE'),
      max: risk ? +risk.getAttribute('RISQUEMAXI') : null,
      r1: risk ? risk.getAttribute('RISQUE1') : null, loc1: risk ? risk.getAttribute('LOC1') : null,
      r2: risk ? risk.getAttribute('RISQUE2') : null, loc2: risk ? risk.getAttribute('LOC2') : null,
      comment: risk ? (risk.getAttribute('COMMENTAIRE') || '') : '',
      resume: txt('RESUME') || txt('STABILITE TEXTE'), dirs
    };
  }

  async function renderAlertes() {
    const body = $('#alertesBody');
    const r = riskToday();
    const lvl = r ? r.level : null;
    const info = lvl ? L.RISK[lvl] : null;
    body.innerHTML = `
      <div class="card"><h3>🏔️ Risque d'avalanche aujourd'hui (massif de la Vanoise)</h3>
        <div class="hero">${info ? `<div class="num" style="background:${info.color};color:${lvl >= 4 ? '#fff' : '#14202e'}">${lvl}</div><div><b>${info.name}</b>${r.src ? `<br><span class="muted small">${esc(r.src)}</span>` : ''}</div>` : '<div class="num" style="background:#e3e8ee">?</div><div>Pas encore renseigné aujourd’hui.</div>'}</div>
        ${info ? `<p class="small" style="margin-top:10px">${esc(info.advice)}</p>` : ''}
        <div id="beraBox"></div>
        <p class="small" style="margin-top:12px"><b>Saisir le niveau du jour</b> (affiché sur le drapeau en bas des pistes, aux caisses ou dans le bulletin) :</p>
        <div class="risk-pick">${[1, 2, 3, 4, 5].map(n => `<button data-risk="${n}" class="${lvl === n ? 'sel' : ''}" style="background:${L.RISK[n].color};color:${n >= 4 ? '#fff' : '#14202e'}">${n}</button>`).join('')}</div>
        <a class="btn block" href="https://meteofrance.com/meteo-montagne" target="_blank" rel="noopener">Lire le bulletin avalanche officiel (Météo-France)</a>
      </div>
      <div class="card" id="wxAlerts"><h3>🌬️ Alertes météo (5 prochaines heures)</h3><p class="muted small">Chargement…</p></div>
      <div class="card" id="outings"><h3>🧗 Dernières sorties publiées dans le secteur</h3><p class="muted small">Chargement…</p></div>
      <div class="card"><h3>✅ Avant chaque sortie hors-piste</h3>
        <ul class="small" style="padding-left:18px;line-height:1.5;margin:0">
          <li>DVA allumé et testé à plusieurs, <b>pelle et sonde</b> dans le sac.</li>
          <li><b>Jamais seul</b>, et un à la fois dans les pentes raides.</li>
          <li>Dire à quelqu'un où tu vas (bouton <b>Position</b> en bas).</li>
          <li>Lire le bulletin du jour : niveau de risque, <b>orientations et altitudes</b> dangereuses.</li>
          <li>Pour découvrir le secteur : une sortie avec un guide ou un moniteur hors-piste vaut toutes les applis.</li>
        </ul>
        <a class="btn danger block" href="tel:112">Secours : appeler le 112</a>
        <p class="muted small">Le 112 fonctionne même sans forfait mobile et via n'importe quel réseau disponible.</p>
      </div>
      <details class="card"><summary><b>Réglage avancé : bulletin automatique (clé Météo-France)</b></summary>
        <p class="small">Si tu crées un compte gratuit sur <a href="https://portail-api.meteofrance.fr" target="_blank" rel="noopener">portail-api.meteofrance.fr</a> et t'abonnes à l'API « Bulletin de risque d'avalanche », colle ta clé ici : l'appli essaiera de lire le bulletin toute seule.</p>
        <input type="password" id="beraKey" placeholder="clé API" value="${esc(store.get('beraKey', ''))}">
        <button class="btn secondary block" id="beraSave">Enregistrer et tester</button>
        <p class="muted small" id="beraMsg"></p>
      </details>
      <p class="muted small">Il n'existe pas de flux public des accidents ou incidents en temps réel : pour les fermetures de secteurs, regarde les panneaux et écoute les pisteurs.</p>`;
    body.querySelectorAll('[data-risk]').forEach(b => b.onclick = () => {
      store.set('risk', { day: localDay(), level: +b.dataset.risk, src: 'Saisi à la main' });
      updateRiskChip(); renderAlertes();
    });
    $('#beraSave').onclick = async () => {
      store.set('beraKey', $('#beraKey').value.trim());
      $('#beraMsg').textContent = 'Test en cours…';
      try { await showBERA(true); $('#beraMsg').textContent = 'Bulletin récupéré ✔'; }
      catch (e) { $('#beraMsg').textContent = 'Échec (' + e.message + '). La clé est peut-être fausse, ou le service refuse les appels depuis un navigateur. Utilise le lien vers le bulletin officiel.'; }
    };
    showBERA(false).catch(() => {});
    renderWxAlerts();
    renderOutings();
  }

  async function showBERA(throwErr) {
    let b;
    try { b = await fetchBERA(); } catch (e) { if (throwErr) throw e; return; }
    if (!b) return;
    if (b.max) {
      const today = localDay();
      store.set('risk', { day: today, level: b.max, src: 'Bulletin Météo-France' + (b.date ? ' du ' + new Date(b.date).toLocaleDateString('fr-FR') : '') });
      updateRiskChip();
    }
    const box = $('#beraBox'); if (!box) return;
    const nice = { N: 'nord', NE: 'nord-est', E: 'est', SE: 'sud-est', S: 'sud', SW: 'sud-ouest', W: 'ouest', NW: 'nord-ouest' };
    box.innerHTML = `<div class="note blue"><b>Bulletin officiel :</b> risque ${b.r1 || '?'}${b.loc1 ? ' ' + esc(b.loc1) : ''}${b.r2 ? `, ${b.r2} ${esc(b.loc2 || '')}` : ''}.
      ${b.dirs.length ? `<br>Pentes les plus dangereuses : <b>${b.dirs.map(k => nice[k]).join(', ')}</b>.` : ''}
      ${b.resume ? `<br>${esc(b.resume)}` : ''}</div>`;
  }

  async function renderWxAlerts() {
    const box = $('#wxAlerts'); if (!box) return;
    try {
      const pl = wxPlace();
      const alt = await elevAt(pl.lng, pl.lat).catch(() => NaN);
      const d = await getWeather(pl.lng, pl.lat, alt);
      const s = wxSummary(d); const al = L.weatherAlerts(s);
      box.innerHTML = `<h3>🌬️ Alertes météo (5 prochaines heures)</h3>` + (al.length
        ? al.map(a => `<div class="alert"><span class="lv" style="background:${['', '#ffe14d', '#ff9a2e', '#e3261b'][a.lvl]}"></span><span>${esc(a.t)}</span></div>`).join('')
        : '<p class="small">Rien de particulier prévu (vent, neige, visibilité, froid).</p>') +
        `<p class="muted small">Calculé à partir des prévisions pour : ${esc(pl.label.toLowerCase())}${Number.isFinite(alt) ? ' (' + Math.round(alt) + ' m)' : ''}. Vigilances officielles : <a href="https://vigilance.meteofrance.fr/fr" target="_blank" rel="noopener">vigilance.meteofrance.fr</a></p>`;
    } catch (e) { box.innerHTML = '<h3>🌬️ Alertes météo</h3><p class="small">Indisponible (pas de réseau ?).</p>'; }
  }

  async function renderOutings() {
    const box = $('#outings'); if (!box) return;
    try {
      const j = await fetchJSON(`${URLS.c2c}/outings?bbox=${c2cBbox()}&act=skitouring&limit=12&pl=fr`);
      const docs = j.documents || [];
      const cond = { excellent: 'excellentes', good: 'bonnes', average: 'moyennes', poor: 'mauvaises', awful: 'très mauvaises' };
      box.innerHTML = `<h3>🧗 Dernières sorties publiées dans le secteur</h3>` + (docs.length ? docs.map(o => {
        const t = L.c2cTitle(o); const dt = o.date_start ? new Date(o.date_start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
        return `<div class="alert"><span class="lv" style="background:#8ab4ff"></span><span><b>${esc(dt)}</b> — <a href="https://www.camptocamp.org/outings/${o.document_id}" target="_blank" rel="noopener">${esc(t)}</a>${o.condition_rating ? ` · conditions ${esc(cond[o.condition_rating] || o.condition_rating)}` : ''}${o.elevation_max ? ` · ${o.elevation_max} m` : ''}</span></div>`;
      }).join('') : '<p class="small">Aucune sortie récente publiée.</p>') +
        '<p class="muted small">Récits publiés par des skieurs sur Camptocamp : utile pour voir les conditions récentes (neige, coulées observées).</p>';
    } catch (e) { box.innerHTML = '<h3>🧗 Dernières sorties</h3><p class="small">Indisponible pour le moment.</p>'; }
  }

  // ------------------------------------------------------------------ Forfaits
  function renderForfaits() {
    $('#forfaitsBody').innerHTML = `<div class="note blue">Prix publics adultes relevés le ${PRICES.checked} sur les sites grand public. ${esc(PRICES.season)} Les saisonniers ont souvent un forfait saison fourni ou à prix réduit par l'employeur : à demander avant d'acheter.</div>` +
      PRICES.groups.map(g => `<div class="card"><h3>${esc(g.title)}</h3>
        ${g.rows.map(r => `<div class="price-row"><span>${esc(r[0])}${r[2] ? `<br><span class="muted small">${esc(r[2])}</span>` : ''}</span><b>${esc(r[1])}</b></div>`).join('')}
        <p class="muted small">Source : ${g.src.map(s => `<a href="${s[1]}" target="_blank" rel="noopener">${esc(s[0])}</a>`).join(', ')}</p></div>`).join('') +
      `<div class="card"><h3>Sites officiels</h3><div class="grid2">
        <a class="btn secondary" href="https://www.les3vallees.com" target="_blank" rel="noopener">les3vallees.com</a>
        <a class="btn secondary" href="https://www.courchevel.com" target="_blank" rel="noopener">Courchevel</a>
        <a class="btn secondary" href="https://www.meribel.net" target="_blank" rel="noopener">Méribel</a>
        <a class="btn secondary" href="https://www.valthorens.com" target="_blank" rel="noopener">Val Thorens</a>
        <a class="btn secondary" href="https://lesmenuires.com" target="_blank" rel="noopener">Les Menuires</a></div></div>`;
  }

  // ------------------------------------------------------------------ Partage de position
  function getPosition() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('GPS non disponible'));
      navigator.geolocation.getCurrentPosition(p => {
        state.pos = { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude, acc: p.coords.accuracy, t: Date.now() };
        res(state.pos);
      }, e => rej(new Error(e.code === 1 ? 'localisation refusée' : 'position introuvable')), { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
    });
  }

  function renderPosition(msg) {
    const contacts = store.get('contacts', []);
    const me = store.get('me', '');
    $('#positionBody').innerHTML = `
      <a class="sosbig" href="tel:112">🚨 Urgence : appeler le 112</a>
      <div class="card" style="margin-top:12px"><h3>Envoyer ma position</h3>
        <p class="small">Récupère ta position GPS et prépare un message (SMS ou mail) pour les personnes ci-dessous. Le GPS marche sans réseau ; l'envoi du SMS demande un peu de signal.</p>
        <button class="btn ok block" id="sendPos">📍 Préparer le message avec ma position</button>
        <div id="posOut">${msg || ''}</div>
      </div>
      <div class="card"><h3>Personnes à prévenir</h3>
        ${contacts.length ? contacts.map((c, i) => `<div class="contact"><div class="who">${esc(c.name || 'Contact')}<small>${esc(c.to)}</small></div><button class="btn secondary" data-del="${i}">Supprimer</button></div>`).join('') : '<p class="muted small">Aucun contact pour l’instant.</p>'}
        <div style="margin-top:10px"><input type="text" id="cName" placeholder="Nom (ex. Thibaud)" autocomplete="name">
        <div style="height:8px"></div><input type="text" id="cTo" placeholder="Numéro de téléphone ou adresse mail" inputmode="email" autocomplete="off">
        <button class="btn block" id="cAdd">Ajouter</button></div>
      </div>
      <div class="card"><h3>Mon prénom dans le message</h3><input type="text" id="meName" value="${esc(me)}" placeholder="ex. Léo"></div>`;
    $('#meName').onchange = e => store.set('me', e.target.value.trim());
    $('#cAdd').onclick = () => {
      const name = $('#cName').value.trim(), to = $('#cTo').value.trim();
      if (!to) return toast('Entre un numéro ou une adresse mail.');
      const ok = L.isEmail(to) || /^\+?\d{6,15}$/.test(L.normPhone(to));
      if (!ok) return toast('Ce n’est ni un numéro ni une adresse mail valide.');
      const list = store.get('contacts', []); list.push({ name, to }); store.set('contacts', list);
      renderPosition();
    };
    $('#positionBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const list = store.get('contacts', []); list.splice(+b.dataset.del, 1); store.set('contacts', list); renderPosition();
    });
    $('#sendPos').onclick = async () => {
      const out = $('#posOut'); out.innerHTML = '<p class="muted small">Recherche du GPS…</p>';
      try {
        const pos = await getPosition();
        const text = L.positionMessage(pos, store.get('me', ''));
        const list = store.get('contacts', []);
        const btns = list.map(c => L.isEmail(c.to)
          ? `<a class="btn block" href="${L.mailLink(c.to, text)}">✉️ Mail à ${esc(c.name || c.to)}</a>`
          : `<a class="btn block" href="${L.smsLink(c.to, text)}">💬 SMS à ${esc(c.name || c.to)}</a>`).join('');
        out.innerHTML = `<p class="msg">${esc(text)}</p>${btns || '<p class="small">Ajoute un contact ci-dessous pour l’envoyer en un geste.</p>'}
          <div class="row"><button class="btn secondary" id="sharePos">Partager…</button><button class="btn secondary" id="copyPos">Copier</button></div>
          <p class="muted small">Le message s'ouvre dans Messages ou Mail : il faut encore appuyer sur « Envoyer ».</p>`;
        $('#sharePos').onclick = () => { if (navigator.share) navigator.share({ text }).catch(() => {}); else toast('Partage non disponible ici : utilise Copier.'); };
        $('#copyPos').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Copié ✔'), () => toast('Copie impossible'));
        state.map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(state.map.getZoom(), 14), freezeElevation: true });
      } catch (e) {
        out.innerHTML = `<div class="note red">Impossible d'obtenir la position (${esc(e.message)}). Sur iPhone : Réglages › Confidentialité › Service de localisation › Safari (ou l'appli) › « Lorsque l'app est active ».</div>`;
      }
    };
  }

  // ------------------------------------------------------------------ Calques, 3D, navigation
  function setSlopes(on) {
    const map = state.map;
    state.slopes = on;
    map.setLayoutProperty('slopesIgn', 'visibility', on && state.slopeSource === 'ign' ? 'visible' : 'none');
    map.setLayoutProperty('slopesCalc', 'visibility', on && state.slopeSource === 'calc' ? 'visible' : 'none');
    $('#slopeLegend').classList.toggle('hidden', !on);
    $('#btnSlopes').classList.toggle('on', on);
  }

  function set3D(on, frame) {
    const map = state.map;
    state.is3d = on;
    $('#lbl3d').textContent = on ? '3D' : '2D';
    $('#btn3d').classList.toggle('on', on);
    if (on) {
      map.setTerrain({ source: 'dem', exaggeration: 1.5 });
      // On attend que le relief soit chargé, puis on place la caméra au-dessus du sol réel
      let done = false;
      const go = () => {
        if (done) return; done = true;
        if (frame) return frameDomain(true);
        const opts = { pitch: 62, duration: 900, freezeElevation: true };
        const g = map.queryTerrainElevation(map.getCenter());
        if (Number.isFinite(g) && typeof map.getCenterElevation === 'function') opts.elevation = g;
        map.easeTo(opts);
      };
      map.once('idle', go); setTimeout(go, 2500);
    } else {
      const back = { pitch: 0, bearing: 0, duration: 700, freezeElevation: true };
      if (typeof map.getCenterElevation === 'function') back.elevation = 0;
      map.easeTo(back);
      setTimeout(() => { if (!state.is3d) map.setTerrain(null); }, 720);
    }
  }

  const BASES = {
    relief: { i: '🏔️', name: 'Relief', sub: 'couleurs d’altitude + ombres' },
    topo: { i: '🗺️', name: 'Topo', sub: 'carte de randonnée' },
    plan: { i: '🧭', name: 'Plan IGN', sub: 'routes, villages, noms' },
    ortho: { i: '🛰️', name: 'Photo', sub: 'vue aérienne' }
  };
  function setBase(b) {
    const map = state.map;
    state.base = b; store.set('base', b);
    ['plan', 'topo', 'ortho'].forEach(id => map.setLayoutProperty(id, 'visibility', id === b ? 'visible' : 'none'));
    map.setLayoutProperty('relief', 'visibility', b === 'relief' ? 'visible' : 'none');
    map.setPaintProperty('hill', 'hillshade-exaggeration', b === 'relief' ? 0.75 : b === 'ortho' ? 0.15 : 0.35);
    $('#lblBase').textContent = BASES[b].name;
  }
  function setLayer(k, on) {
    const map = state.map;
    state.layers[k] = on; store.set('layers', state.layers);
    const ids = { pistes: ['pistes-casing', 'pistes', 'lifts'], off: ['freeride', 'routes'], contours: ['contours', 'contour-labels'], traces: ['traces'] }[k] || [];
    ids.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); });
    if (k === 'peaks') showPeaks();
  }

  function openLayers() {
    state.selected = 'layers';
    const L2 = state.layers;
    const tog = (k, i, t, sub) => `<button class="opt ${L2[k] ? 'sel' : ''}" data-ly="${k}"><span class="i">${i}</span><span>${t}<small>${sub}</small></span></button>`;
    openSheet(`<h2>Carte</h2>
      <h3 class="sec">Fond de carte</h3>
      <div class="grid2">${Object.entries(BASES).map(([k, v]) => `<button class="opt ${state.base === k ? 'sel' : ''}" data-base="${k}"><span class="i">${v.i}</span><span>${v.name}<small>${v.sub}</small></span></button>`).join('')}</div>
      <h3 class="sec">Afficher</h3>
      <div class="grid2">
        ${tog('pistes', '⛷️', 'Pistes', 'et remontées')}
        ${tog('off', '🟠', 'Hors-piste', 'itinéraires connus')}
        ${tog('peaks', '⛰️', 'Sommets', 'noms et altitudes')}
        ${tog('contours', '〰️', 'Courbes', 'de niveau')}
        ${tog('traces', '🥾', 'Traces IGN', 'itinéraires hivernaux')}
        <button class="opt ${state.slopes ? 'sel' : ''}" data-slopes="1"><span class="i">📐</span><span>Pentes<small>plus de 30°</small></span></button>
      </div>
      <button class="btn secondary block" id="btnFrame">🎯 Recadrer sur le domaine</button>
      <button class="btn secondary block" id="btnOffline">⬇️ Enregistrer la carte pour le hors-ligne</button>
      <p id="offlineStatus" class="muted small"></p>`);
    const body = $('#sheetBody');
    body.querySelectorAll('[data-base]').forEach(b => b.onclick = () => { setBase(b.dataset.base); openLayers(); });
    body.querySelectorAll('[data-ly]').forEach(b => b.onclick = () => { setLayer(b.dataset.ly, !state.layers[b.dataset.ly]); openLayers(); });
    body.querySelector('[data-slopes]').onclick = () => { setSlopes(!state.slopes); openLayers(); };
    $('#btnFrame').onclick = () => { closeSheet(); frameDomain(state.is3d); };
    $('#btnOffline').onclick = offlineDownload;
  }

  function setupControls() {
    $('#btn3d').onclick = () => set3D(!state.is3d, false);
    $('#btnLayers').onclick = () => { if (state.selected === 'layers' && !$('#sheet').classList.contains('hidden')) closeSheet(); else openLayers(); };
    $('#btnSlopes').onclick = () => setSlopes(!state.slopes);
    $('#btnLocate').onclick = () => state.geo.trigger();
  }

  function openTab(name) {
    document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    if (name === 'carte') return;
    $('#panel-' + name).classList.remove('hidden');
    $('#panel-' + name + ' .panel-body').scrollTop = 0;
    if (name === 'meteo') renderMeteo();
    if (name === 'alertes') renderAlertes();
    if (name === 'forfaits') renderForfaits();
    if (name === 'position') renderPosition();
  }

  // ------------------------------------------------------------------ Hors-ligne : enregistrer les tuiles de la zone
  async function offlineDownload() {
    const st = $('#offlineStatus');
    const jobs = [];
    const bbox = state.ring ? L.polyBBox(state.ring) : L.BBOX;
    const add = (tpl, zmin, zmax) => { for (let z = zmin; z <= zmax; z++) L.tilesForBbox(bbox, z).forEach(t => jobs.push(tpl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y))); };
    add(URLS.dem, 9, 14); // le relief suffit pour le fond « Relief », les courbes et les pentes
    if (state.base === 'plan') add(LAYERS_IGN.plan, 10, 15);
    if (state.base === 'ortho') add(LAYERS_IGN.ortho, 10, 15);
    if (state.slopes && state.slopeSource === 'ign') add(LAYERS_IGN.slopes, 13, 15);
    modal(`<h2>Enregistrer la carte ?</h2><p>${jobs.length} morceaux de carte (environ ${Math.max(5, Math.round(jobs.length * 30 / 1024))} Mo). À faire en wifi.</p>
      <p class="small muted">Sans réseau, tu auras la carte en relief, les pentes, les pistes et les itinéraires. La météo et les alertes demandent du réseau.${state.base === 'topo' ? ' Le fond « Topo » ne s’enregistre pas : utilise « Relief » hors-ligne.' : ''}</p>
      <button class="btn ok block" id="dlGo">Enregistrer</button><button class="btn secondary block" id="dlNo">Annuler</button>`, card => {
      card.querySelector('#dlNo').onclick = closeModal;
      card.querySelector('#dlGo').onclick = async () => {
        closeModal();
        let cache; try { cache = await caches.open('3v-tiles'); } catch (e) { toast('Stockage indisponible sur cet appareil.'); return; }
        let done = 0, fail = 0; const total = jobs.length;
        const show = t => { if (st) st.textContent = t; toast(t, 2500); };
        const worker = async () => {
          while (jobs.length) {
            const u = jobs.shift();
            try { if (!(await cache.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await cache.put(u, r); else fail++; } } catch (e) { fail++; }
            done++; if (done % 50 === 0) show(`Enregistrement… ${Math.round(done / total * 100)} %`);
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        show(`Carte enregistrée ✔${fail ? ` (${fail} morceaux manquants)` : ''}`);
      };
    });
  }

  // ------------------------------------------------------------------ Premier lancement
  function welcome() {
    if (store.get('welcomed', false)) return;
    modal(`<h2>⛷️ Avant de commencer</h2>
      <p>Cette appli t'aide à <b>préparer</b> tes sorties : carte des pentes, météo, bulletin avalanche, itinéraires connus.</p>
      <p><b>Elle ne remplace pas :</b></p>
      <ul><li>le DVA, la pelle et la sonde (et savoir s'en servir) ;</li><li>de ne jamais partir seul en hors-piste ;</li>
      <li>le bulletin avalanche du jour et les conseils des pisteurs ;</li><li>une première sortie avec un guide pour découvrir le secteur.</li></ul>
      <p class="small muted">Les itinéraires et indications d'accès viennent de bases collaboratives ou sont calculés : ils peuvent être faux ou dépassés.</p>
      <button class="btn block" id="okWelcome">J'ai compris</button>`, card => {
      card.querySelector('#okWelcome').onclick = () => { store.set('welcomed', true); closeModal(); };
    });
  }

  // ------------------------------------------------------------------ Démarrage
  function start() {
    state.layers = Object.assign({ pistes: true, off: true, peaks: true, contours: true, traces: false }, store.get('layers', {}));
    initMap();
    setupControls();
    $('#sheetClose').onclick = closeSheet;
    document.querySelectorAll('#tabbar button').forEach(b => b.onclick = () => {
      if (b.classList.contains('active')) openTab('carte'); else openTab(b.dataset.tab);
    });
    document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => openTab('carte'));
    $('#riskTile').onclick = () => openTab('alertes');
    $('#wxTile').onclick = () => openTab('meteo');
    document.addEventListener('click', e => {
      const g = e.target.closest('[data-goto]'); if (g) openTab(g.dataset.goto);
    });
    updateRiskChip();
    welcome();
    state.map.once('load', async () => {
      setBase(store.get('base', 'relief'));
      Object.entries(state.layers).forEach(([k, v]) => setLayer(k, v));
      try {
        const c = state.map.getCenter(); const alt = await elevAt(c.lng, c.lat).catch(() => NaN);
        const d = await getWeather(c.lng, c.lat, alt); updateWxChip(d, wxSummary(d));
      } catch (e) { $('#wxMain').textContent = 'Météo'; $('#wxSub').textContent = 'hors-ligne'; }
      showBERA(false).catch(() => {});
    });
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  window.addEventListener('DOMContentLoaded', start);
  window.__3v = { state, L }; // pour le débogage
})();
