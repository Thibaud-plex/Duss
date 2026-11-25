/* lib.js — fonctions de calcul pures (sans accès réseau ni carte), testables séparément */
(function (root) {
  'use strict';
  const L = {};

  // ---------- Zone couverte : les 3 Vallées (Courchevel, Méribel, Belleville / Val Thorens / Orelle)
  L.BBOX = { south: 45.19, west: 6.43, north: 45.47, east: 6.72 };
  L.CENTER = [6.585, 45.345];
  L.MASSIF_BERA_VANOISE = 10;

  // ---------- Géométrie
  const R = 6371008.8;
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;

  L.haversine = function (a, b) {
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  };

  L.bearing = function (a, b) {
    const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
    const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  };

  L.cardinal = function (b) {
    const names = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
    return names[Math.round(b / 45) % 8];
  };

  L.lineLength = function (coords) {
    let d = 0;
    for (let i = 1; i < coords.length; i++) d += L.haversine(coords[i - 1], coords[i]);
    return d;
  };

  // Points régulièrement espacés le long d'une ligne (pas en mètres)
  L.resample = function (coords, step) {
    if (!coords || coords.length < 2) return coords ? coords.slice() : [];
    const out = [coords[0]];
    let carry = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const seg = L.haversine(a, b);
      if (seg === 0) continue;
      let pos = step - carry;
      while (pos <= seg) {
        const t = pos / seg;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        pos += step;
      }
      carry = seg - (pos - step);
    }
    const last = coords[coords.length - 1];
    const prev = out[out.length - 1];
    if (prev[0] !== last[0] || prev[1] !== last[1]) out.push(last);
    return out;
  };

  // Pente max (en degrés) à partir de points et d'altitudes, sur une fenêtre glissante
  // window : distance horizontale minimale (m) sur laquelle on mesure la pente (lisse le bruit du modèle)
  L.slopeStats = function (points, elevs, window) {
    window = window || 40;
    let max = 0, maxIdx = -1, up = 0, down = 0;
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + L.haversine(points[i - 1], points[i]));
    for (let i = 1; i < elevs.length; i++) {
      const dz = elevs[i] - elevs[i - 1];
      if (dz > 0) up += dz; else down -= dz;
    }
    let j = 0;
    for (let i = 0; i < points.length; i++) {
      while (j < points.length && cum[j] - cum[i] < window) j++;
      if (j >= points.length) break;
      const dh = cum[j] - cum[i];
      const dz = Math.abs(elevs[j] - elevs[i]);
      const s = deg(Math.atan2(dz, dh));
      if (s > max) { max = s; maxIdx = i; }
    }
    const valid = elevs.filter(e => Number.isFinite(e));
    return {
      maxSlope: max,
      maxSlopeAt: maxIdx >= 0 ? points[maxIdx] : null,
      up, down,
      top: valid.length ? Math.max(...valid) : null,
      bottom: valid.length ? Math.min(...valid) : null,
      length: cum[cum.length - 1] || 0
    };
  };

  // ---------- Tuiles (Web Mercator)
  L.lngLatToTile = function (lng, lat, z) {
    const n = 2 ** z;
    const x = (lng + 180) / 360 * n;
    const la = rad(lat);
    const y = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n;
    return { x, y };
  };
  L.tileToLngLat = function (x, y, z) {
    const n = 2 ** z;
    const lng = x / n * 360 - 180;
    const lat = deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))));
    return [lng, lat];
  };
  L.tilesForBbox = function (bbox, z) {
    const a = L.lngLatToTile(bbox.west, bbox.north, z), b = L.lngLatToTile(bbox.east, bbox.south, z);
    const list = [];
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
      for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) list.push({ x, y, z });
    return list;
  };
  L.terrariumDecode = (r, g, b) => (r * 256 + g + b / 256) - 32768;

  // EPSG:3857 <-> WGS84 (Camptocamp donne ses géométries en 3857)
  L.mercToLngLat = function (x, y) {
    return [x / 6378137 * 180 / Math.PI, deg(2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2)];
  };
  L.lngLatToMerc = function (lng, lat) {
    return [rad(lng) * 6378137, Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2)) * 6378137];
  };

  // ---------- OpenStreetMap (Overpass) -> GeoJSON
  L.overpassQuery = function (b) {
    const bb = `${b.south},${b.west},${b.north},${b.east}`;
    return `[out:json][timeout:90];(way["piste:type"="downhill"](${bb});way["aerialway"]["aerialway"!~"zip_line|pylon|station|goods"](${bb});way["piste:type"="skitour"](${bb});node["natural"="peak"]["name"](${bb}););out tags geom;`;
  };

  const DIFF = { novice: 'Verte', easy: 'Verte', intermediate: 'Bleue', advanced: 'Rouge', expert: 'Noire', freeride: 'Hors-piste', extreme: 'Hors-piste (extrême)' };
  L.DIFF_LABEL = DIFF;
  const LIFT = {
    cable_car: 'Téléphérique', gondola: 'Télécabine', mixed_lift: 'Télémix', chair_lift: 'Télésiège',
    drag_lift: 'Téléski', 't-bar': 'Téléski (perche double)', 'j-bar': 'Téléski', platter: 'Téléski (perche)',
    rope_tow: 'Fil neige', magic_carpet: 'Tapis', funicular: 'Funiculaire'
  };
  L.LIFT_LABEL = LIFT;

  L.osmToGeoJSON = function (json) {
    const pistes = [], lifts = [], freeride = [];
    const peaks = [];
    for (const el of (json && json.elements) || []) {
      if (el.type === 'node' && el.tags && el.tags.natural === 'peak') {
        const ele = parseFloat(String(el.tags.ele || '').replace(',', '.'));
        peaks.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
          properties: { id: 'osm-n' + el.id, kind: 'peak', name: el.tags.name, ele: Number.isFinite(ele) ? Math.round(ele) : null } });
        continue;
      }
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const t = el.tags || {};
      const coords = el.geometry.map(p => [p.lon, p.lat]);
      const base = { id: 'osm' + el.id, osm: el.id, name: t.name || t.ref || null, ref: t.ref || null };
      if (t.aerialway) {
        lifts.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
          properties: Object.assign(base, { kind: 'lift', liftType: t.aerialway, label: LIFT[t.aerialway] || 'Remontée',
            capacity: t['aerialway:capacity'] || null, occupancy: t['aerialway:occupancy'] || null,
            duration: t['aerialway:duration'] || null, heating: t['aerialway:heating'] || null,
            bubble: t['aerialway:bubble'] || null }) });
      } else {
        const diff = t['piste:difficulty'] || '';
        const off = diff === 'freeride' || diff === 'extreme' || t['piste:grooming'] === 'backcountry' || t['piste:type'] === 'skitour';
        const f = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
          properties: Object.assign(base, { kind: off ? 'freeride' : 'piste', difficulty: diff || null,
            label: DIFF[diff] || (off ? 'Hors-piste' : 'Piste'), grooming: t['piste:grooming'] || null,
            area: t['piste:type'] === 'downhill' && /area/.test(t.area || '') }) };
        (off ? freeride : pistes).push(f);
      }
    }
    return {
      pistes: { type: 'FeatureCollection', features: pistes },
      lifts: { type: 'FeatureCollection', features: lifts },
      freeride: { type: 'FeatureCollection', features: freeride },
      peaks: { type: 'FeatureCollection', features: peaks }
    };
  };

  // ---------- Contour du domaine (enveloppe convexe + marge) et masque « hors zone »
  L.convexHull = function (pts) {
    const p = pts.map(q => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop();
    return lo.concat(up);
  };
  // Agrandit un polygone convexe de « m » mètres (décalage de chaque côté + coins arrondis)
  L.bufferHull = function (hull, m) {
    if (hull.length < 3) return hull;
    const lat0 = hull.reduce((a, q) => a + q[1], 0) / hull.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const P = hull.map(q => [q[0] * kx, q[1] * ky]);
    const out = [];
    const n = P.length;
    for (let i = 0; i < n; i++) {
      const prev = P[(i - 1 + n) % n], cur = P[i], next = P[(i + 1) % n];
      const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
      const n1 = nrm(prev, cur), n2 = nrm(cur, next);
      let a1 = Math.atan2(n1[1], n1[0]), a2 = Math.atan2(n2[1], n2[0]);
      while (a2 < a1) a2 += 2 * Math.PI;
      if (a2 - a1 > Math.PI) { const t = a1; a1 = a2 - 2 * Math.PI; a2 = t; }
      const steps = Math.max(1, Math.ceil((a2 - a1) / (Math.PI / 12)));
      for (let k = 0; k <= steps; k++) { const a = a1 + (a2 - a1) * k / steps; out.push([cur[0] + m * Math.cos(a), cur[1] + m * Math.sin(a)]); }
    }
    return out.map(q => [q[0] / kx, q[1] / ky]);
  };
  L.polyBBox = function (ring) {
    const xs = ring.map(q => q[0]), ys = ring.map(q => q[1]);
    return { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
  };
  L.pointInRing = function (pt, ring) {
    let ins = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  };
  // Polygone « tout le reste du monde » percé de la zone : sert de masque
  L.maskPolygon = function (ring) {
    const r = ring.slice(); if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0]);
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-179, -85], [179, -85], [179, 85], [-179, 85], [-179, -85]], r.reverse()] } };
  };
  L.domainFrom = function (data) {
    const pts = [];
    for (const fc of [data.pistes, data.lifts]) for (const f of fc.features) { const c = f.geometry.coordinates; pts.push(c[0], c[c.length - 1], c[Math.floor(c.length / 2)]); }
    if (pts.length < 10) return null;
    return L.convexHull(pts);
  };

  // ---------- Choix de quelques sommets repères : les plus hauts, espacés d'au moins minSpacing mètres
  L.pickPeaks = function (peaks, ring, n, minSpacing) {
    const list = peaks.filter(f => f.properties.ele && (!ring || L.pointInRing(f.geometry.coordinates, ring)))
      .sort((a, b) => b.properties.ele - a.properties.ele);
    const keep = [];
    for (const f of list) {
      if (keep.length >= n) break;
      if (keep.every(k => L.haversine(k.geometry.coordinates, f.geometry.coordinates) >= minSpacing)) keep.push(f);
    }
    return keep;
  };

  // ---------- Pente et orientation à partir de 4 altitudes voisines (est, ouest, nord, sud) écartées de d mètres
  L.slopeAspect = function (zE, zW, zN, zS, d) {
    const dzdx = (zE - zW) / (2 * d), dzdy = (zN - zS) / (2 * d);
    const slope = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
    // L'orientation = direction vers laquelle la pente « regarde » (sens de la descente)
    const aspect = (Math.atan2(-dzdx, -dzdy) * 180 / Math.PI + 360) % 360;
    return { slope, aspect };
  };

  // ---------- Camptocamp
  L.c2cTitle = function (doc) {
    const locs = doc.locales || [];
    const loc = locs.find(l => l.lang === 'fr') || locs[0] || {};
    const p = loc.title_prefix ? loc.title_prefix + ' : ' : '';
    return (p + (loc.title || 'Itinéraire sans nom')).trim();
  };
  L.parseGeom = function (g) {
    if (!g) return null;
    try { return typeof g === 'string' ? JSON.parse(g) : g; } catch (e) { return null; }
  };
  L.c2cGeomToLngLat = function (geom) {
    const g = L.parseGeom(geom);
    if (!g) return null;
    const conv = c => L.mercToLngLat(c[0], c[1]);
    if (g.type === 'Point') return { type: 'Point', coordinates: conv(g.coordinates) };
    if (g.type === 'LineString') return { type: 'LineString', coordinates: g.coordinates.map(conv) };
    if (g.type === 'MultiLineString') return { type: 'MultiLineString', coordinates: g.coordinates.map(l => l.map(conv)) };
    return null;
  };
  L.c2cListToGeoJSON = function (json) {
    const feats = [];
    for (const d of (json && json.documents) || []) {
      const g = L.c2cGeomToLngLat(d.geometry && d.geometry.geom);
      if (!g || g.type !== 'Point') continue;
      feats.push({ type: 'Feature', geometry: g, properties: {
        id: 'c2c' + d.document_id, c2c: d.document_id, kind: 'route', name: L.c2cTitle(d),
        ski_rating: d.ski_rating || null, ski_exposition: d.ski_exposition || null,
        labande: d.labande_global_rating || null, elevation_max: d.elevation_max || null,
        elevation_min: d.elevation_min || null, height_diff_down: d.height_diff_down || null,
        orientations: (d.orientations || []).join(', '), quality: d.quality || null
      } });
    }
    return { type: 'FeatureCollection', features: feats };
  };

  // Texte lisible des cotations
  L.EXPO = {
    E1: "E1 — pas de gros obstacle en dessous : une chute est sans grande conséquence",
    E2: "E2 — en cas de chute, on peut glisser vers des rochers ou une petite barre",
    E3: "E3 — une chute peut être grave (barres, couloir étroit en dessous)",
    E4: "E4 — une chute est très probablement mortelle"
  };
  L.skiRatingText = function (r) {
    if (!r) return null;
    const m = /^(\d)/.exec(r); const n = m ? +m[1] : 0;
    const t = { 1: 'facile (pentes douces)', 2: 'peu difficile (pentes jusqu’à ~35° sur de courts passages)',
      3: 'assez difficile (pentes longues à ~35°, quelques passages à 40°)', 4: 'difficile (couloirs à 40°, 45° sur de courts passages)',
      5: 'très difficile (pentes de 45° à 50°)' }[n];
    return `${r} — ${t || 'niveau expert'}`;
  };

  // Markdown Camptocamp -> texte simple (on enlève liens internes, balises)
  L.c2cPlain = function (md) {
    if (!md) return '';
    return String(md)
      .replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/[*_`>]/g, '')
      .replace(/\{#\w+\}/g, '')
      .replace(/L#[~=]?\s*\|?/g, '• ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  // ---------- Durée estimée
  const SPEED_KMH = { novice: 14, easy: 14, intermediate: 18, advanced: 20, expert: 16, freeride: 10, extreme: 8 };
  L.descentMinutes = function (lengthM, difficulty) {
    const v = SPEED_KMH[difficulty] || 15;
    return Math.max(1, Math.round(lengthM / 1000 / v * 60));
  };
  const LIFT_MS = { cable_car: 9, gondola: 5, mixed_lift: 5, chair_lift: 2.5, drag_lift: 3, 't-bar': 3, 'j-bar': 3, platter: 3, rope_tow: 1.5, magic_carpet: 0.8, funicular: 8 };
  L.liftMinutes = function (lengthM, liftType, osmDuration) {
    if (osmDuration) {
      const d = String(osmDuration);
      if (/^\d+$/.test(d)) return +d;
      const m = /^(\d+):(\d+)$/.exec(d); if (m) return +m[1] + (+m[2] >= 30 ? 1 : 0);
    }
    return Math.max(1, Math.round(lengthM / (LIFT_MS[liftType] || 4) / 60));
  };

  // ---------- Neige : estimation à partir de la météo des derniers jours (ce n'est PAS une observation)
  L.estimateSnow = function (p) {
    // p: { fresh72, fresh24, tmax, tmin, tnow, windMax, rainOnSnow }
    const out = [];
    let label;
    if (p.rainOnSnow) label = 'Neige mouillée par la pluie — lourde, risque d’avalanches humides';
    else if (p.fresh72 >= 20 && p.tmax <= 0) label = 'Poudreuse fraîche';
    else if (p.fresh72 >= 5 && p.windMax >= 40) label = 'Neige fraîche travaillée par le vent (croûtes, plaques possibles)';
    else if (p.fresh72 >= 5) label = 'Fine couche de neige fraîche';
    else if (p.tmax > 3 && p.tmin < -1) label = 'Neige de printemps (dure et gelée le matin, molle l’après-midi)';
    else if (p.tmax > 3) label = 'Neige humide / lourde';
    else if (p.windMax >= 50) label = 'Neige soufflée, souvent dure ou croûtée';
    else label = 'Neige ancienne tassée (dure, parfois glacée)';
    if (p.fresh72 >= 30) out.push('Plus de 30 cm de neige fraîche en 3 jours : période dangereuse en hors-piste.');
    else if (p.fresh72 >= 15 && p.windMax >= 40) out.push('Neige fraîche + vent : formation de plaques à vent probable.');
    if (p.tnow > 2) out.push('Redoux : les pentes au soleil se ramollissent et deviennent plus instables dans l’après-midi.');
    return { label, notes: out };
  };

  // ---------- Alertes calculées à partir des prévisions
  L.weatherAlerts = function (h) {
    // h: { gustMax, snow5h, visMin, feelsMin, rainOnSnow, fresh72 }
    const a = [];
    if (h.gustMax >= 90) a.push({ lvl: 3, t: `Rafales jusqu’à ${Math.round(h.gustMax)} km/h : tempête, beaucoup de remontées seront fermées.` });
    else if (h.gustMax >= 60) a.push({ lvl: 2, t: `Vent fort (rafales ${Math.round(h.gustMax)} km/h) : risque de fermeture des remontées hautes, plaques à vent.` });
    if (h.snow5h >= 10) a.push({ lvl: 2, t: `Fortes chutes de neige prévues (~${Math.round(h.snow5h)} cm en 5 h).` });
    else if (h.snow5h >= 3) a.push({ lvl: 1, t: `Chutes de neige prévues (~${Math.round(h.snow5h)} cm en 5 h).` });
    if (h.visMin != null && h.visMin < 300) a.push({ lvl: 2, t: 'Visibilité très faible (jour blanc / brouillard) : hors-piste fortement déconseillé.' });
    if (h.feelsMin != null && h.feelsMin <= -20) a.push({ lvl: 2, t: `Froid extrême (ressenti ${Math.round(h.feelsMin)}°C) : risque de gelures.` });
    if (h.rainOnSnow) a.push({ lvl: 3, t: 'Pluie sur la neige prévue : risque d’avalanches de neige humide.' });
    if (h.fresh72 >= 30) a.push({ lvl: 3, t: `${Math.round(h.fresh72)} cm de neige fraîche en 3 jours : manteau neigeux instable.` });
    return a;
  };

  // ---------- Conseils selon le niveau de risque avalanche (échelle européenne 1 à 5)
  L.RISK = {
    1: { name: 'Faible', color: '#c8e66b', advice: 'Conditions plutôt favorables. Restez prudent dans les pentes très raides (> 40°) et les zones à barres.' },
    2: { name: 'Limité', color: '#ffe14d', advice: 'Déclenchements possibles surtout dans les pentes raides indiquées par le bulletin. Une personne à la fois dans les passages raides.' },
    3: { name: 'Marqué', color: '#ff9a2e', advice: 'Niveau où se produisent la plupart des accidents mortels. Évitez les pentes de plus de 30–35° aux orientations citées dans le bulletin. Hors-piste seulement avec de l’expérience ou un guide.' },
    4: { name: 'Fort', color: '#ff3b30', advice: 'Déclenchements probables même par un seul skieur. Restez sur les pistes balisées et ouvertes.' },
    5: { name: 'Très fort', color: '#8b0000', advice: 'Avalanches spontanées nombreuses. Pas de hors-piste. Suivez les consignes des pisteurs.' }
  };

  // ---------- Faune & flore selon l'altitude (Vanoise / Tarentaise)
  L.nature = function (alt) {
    if (alt == null) alt = 2000;
    if (alt < 1700) return {
      zone: 'Forêt de montagne (moins de 1 700 m)',
      flora: 'Épicéas, sapins et quelques hêtres. Sous la neige : myrtilliers, mousses.',
      fauna: 'Chevreuil, cerf, écureuil roux, renard, chouette de Tengmalm, mésanges et pics. Traces fréquentes dans la neige au petit matin.',
      tip: 'Les animaux économisent leur énergie en hiver : si vous en voyez, ne vous approchez pas.'
    };
    if (alt < 2300) return {
      zone: 'Limite de la forêt (1 700 – 2 300 m)',
      flora: 'Mélèzes (sans aiguilles en hiver), pins cembro (arolles), rhododendrons et genévriers cachés sous la neige.',
      fauna: 'Tétras-lyre, lièvre variable (blanc l’hiver), renard, casse-noix moucheté, mésange huppée.',
      tip: 'Le tétras-lyre passe l’hiver enfoui dans des igloos de neige, souvent dans les bosquets clairsemés. Un skieur qui le fait s’envoler peut le condamner : évitez de couper à travers les jeunes forêts et respectez les zones de quiétude signalées.'
    };
    if (alt < 2800) return {
      zone: 'Alpages et pelouses alpines (2 300 – 2 800 m)',
      flora: 'Pelouses alpines sous la neige ; lichens sur les rochers qui dépassent.',
      fauna: 'Chamois, lagopède alpin (blanc, très discret), hermine, aigle royal. Les marmottes hibernent sous vos skis jusqu’en avril.',
      tip: 'Les chamois s’épuisent vite dans la neige profonde : ne les poursuivez jamais, même pour une photo.'
    };
    return {
      zone: 'Haute montagne (plus de 2 800 m)',
      flora: 'Rochers, glaciers, quelques lichens. Presque aucune plante visible en hiver.',
      fauna: 'Bouquetin des Alpes (sur les crêtes au soleil), chocard à bec jaune (autour des gares d’arrivée), parfois le gypaète barbu, réintroduit dans les Alpes.',
      tip: 'Le Parc national de la Vanoise est tout proche : on y trouve l’une des plus grandes populations de bouquetins des Alpes.'
    };
  };

  // ---------- Secteur (approximation pour savoir quel forfait vallée couvre une remontée)
  L.sector = function (lng, lat) {
    if (lng >= 6.605) return 'courchevel';
    if (lat >= 45.335 && lng >= 6.535) return 'meribel';
    if (lat < 45.275) return 'orelle';
    if (lat < 45.315 && lng >= 6.55) return 'valthorens';
    return 'belleville';
  };
  L.SECTOR_LABEL = { courchevel: 'Courchevel / La Tania', meribel: 'Méribel', valthorens: 'Val Thorens', orelle: 'Orelle', belleville: 'Les Menuires / Saint-Martin' };

  // ---------- Message de partage de position
  L.positionMessage = function (pos, who, when) {
    const lat = pos.lat.toFixed(5), lon = pos.lon.toFixed(5);
    const t = when || new Date();
    const hh = String(t.getHours()).padStart(2, '0') + 'h' + String(t.getMinutes()).padStart(2, '0');
    let s = `${who ? 'Position de ' + who : 'Ma position'} à ${hh} : ${lat}, ${lon}`;
    if (pos.alt != null) s += ` (altitude ~${Math.round(pos.alt)} m)`;
    if (pos.acc != null) s += ` — précision ±${Math.round(pos.acc)} m`;
    s += `\nCarte : https://www.google.com/maps?q=${lat},${lon}`;
    return s;
  };
  L.isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
  L.normPhone = function (s) {
    let p = String(s).replace(/[^\d+]/g, '');
    if (/^0\d{9}$/.test(p)) p = '+33' + p.slice(1);
    return p;
  };
  L.smsLink = (phone, body) => `sms:${L.normPhone(phone)}&body=${encodeURIComponent(body)}`;
  L.mailLink = (email, body) => `mailto:${String(email).trim()}?subject=${encodeURIComponent('Ma position en montagne')}&body=${encodeURIComponent(body)}`;

  L.fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m';
  L.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  root.L3V = L;
  if (typeof module !== 'undefined') module.exports = L;
})(typeof self !== 'undefined' ? self : this);
