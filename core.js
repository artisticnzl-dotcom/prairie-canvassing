/* Prairie Canvassing — shared logic (no screen code). Mirrors the Android app. */
(function (root) {
  'use strict';

  const OUTCOMES = [
    { key: 'KNOCKED', label: 'Knocked', color: '#146654', mark: 'K' },
    { key: 'NO_ANSWER', label: 'No answer', color: '#52667C', mark: 'N' },
    { key: 'TOOK_CARD', label: 'Took card', color: '#0E7C86', mark: 'T' },
    { key: 'FOLLOW_UP', label: 'Follow up', color: '#A84B13', mark: 'F' },
    { key: 'BOOKED', label: 'Booked', color: '#24539F', mark: 'B' },
    { key: 'COMPLETED', label: 'Completed', color: '#673E96', mark: 'C' },
    { key: 'DO_NOT_KNOCK', label: 'Do not knock', color: '#A42E42', mark: 'D' },
  ];
  const OUT = {};
  OUTCOMES.forEach(o => { OUT[o.key] = o; });

  const CHUNK_ZOOM = 15;

  // ------------------------------------------------------------ geometry
  function tileLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tileLat(y, z) { const n = Math.PI * (1 - 2 * y / Math.pow(2, z)); return Math.atan(Math.sinh(n)) * 180 / Math.PI; }
  function worldX(lon) { return (lon + 180) / 360; }
  function worldY(lat) {
    const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  function chunkX(lon) { return Math.floor(worldX(lon) * (1 << CHUNK_ZOOM)); }
  function chunkY(lat) { return Math.floor(worldY(lat) * (1 << CHUNK_ZOOM)); }
  function chunkBox(x, y) {
    return { n: tileLat(y, CHUNK_ZOOM), s: tileLat(y + 1, CHUNK_ZOOM), w: tileLon(x, CHUNK_ZOOM), e: tileLon(x + 1, CHUNK_ZOOM) };
  }

  function meters(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * 111320;
    const dx = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    return Math.hypot(dx, dy);
  }

  function contains(lats, lons, la, lo) {
    let inside = false;
    const n = lats.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if ((lats[i] > la) !== (lats[j] > la) &&
          lo < (lons[j] - lons[i]) * (la - lats[i]) / (lats[j] - lats[i]) + lons[i]) inside = !inside;
    }
    return inside;
  }

  /** A point inside the outline to put the label/pin on (centroid, or middle of the widest inside stretch). */
  function labelPoint(lats, lons) {
    const n = lats.length;
    let a = 0, cx = 0, cy = 0;
    const ox = lons[0], oy = lats[0];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = lons[i] - ox, yi = lats[i] - oy, xj = lons[j] - ox, yj = lats[j] - oy;
      const f = xj * yi - xi * yj;
      a += f; cx += (xj + xi) * f; cy += (yj + yi) * f;
    }
    let lat, lon;
    if (Math.abs(a) < 1e-14) { lat = lats[0]; lon = lons[0]; } else { lon = cx / (3 * a) + ox; lat = cy / (3 * a) + oy; }
    if (!contains(lats, lons, lat, lon)) {
      let minA = 90, maxA = -90;
      for (let i = 0; i < n; i++) { minA = Math.min(minA, lats[i]); maxA = Math.max(maxA, lats[i]); }
      let best = -1;
      const tries = [lat, .5, .25, .75, .1, .9].map((t, k) => k === 0 ? t : minA + (maxA - minA) * t);
      for (const y of tries) {
        const xs = [];
        for (let i = 0, j = n - 1; i < n; j = i++) {
          if ((lats[i] > y) !== (lats[j] > y)) xs.push((lons[j] - lons[i]) * (y - lats[i]) / (lats[j] - lats[i]) + lons[i]);
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          if (xs[i + 1] - xs[i] > best) { best = xs[i + 1] - xs[i]; lat = y; lon = (xs[i] + xs[i + 1]) / 2; }
        }
      }
    }
    return [lat, lon];
  }

  function makeHouse(key, lats, lons) {
    const h = { key, lats, lons, number: '', street: '', official: false, visit: null };
    if (lats) {
      h.minLat = Math.min(...lats); h.maxLat = Math.max(...lats);
      h.minLon = Math.min(...lons); h.maxLon = Math.max(...lons);
      [h.lat, h.lon] = labelPoint(lats, lons);
    }
    return h;
  }
  function makePoint(key, lat, lon) {
    const h = { key, lats: null, lons: null, lat, lon, number: '', street: '', official: false, visit: null,
      minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
    return h;
  }
  function houseContains(h, la, lo) {
    if (!h.lats || la < h.minLat || la > h.maxLat || lo < h.minLon || lo > h.maxLon) return false;
    return contains(h.lats, h.lons, la, lo);
  }
  function houseAddress(h) {
    if (!h.number) return h.street;
    return h.street ? h.number + ' ' + h.street : h.number;
  }

  // ------------------------------------------------------------ OpenStreetMap outlines (Overpass)
  const NOT_A_DOOR = new Set(['garage', 'garages', 'shed', 'carport', 'roof', 'silo', 'barn', 'farm_auxiliary',
    'greenhouse', 'storage_tank', 'hangar', 'transformer_tower', 'bunker', 'ruins', 'service', 'tower',
    'water_tower', 'grandstand', 'toilets', 'kiosk', 'no']);

  function overpassQuery(b) {
    const bbox = [b.s, b.w, b.n, b.e].map(v => v.toFixed(6)).join(',');
    return '[out:json][timeout:40];(way["building"](' + bbox + ');node["addr:housenumber"](' + bbox + '););out geom qt;';
  }

  function setOsmAddress(h, tags) {
    if (!tags) return;
    const num = tags['addr:housenumber'];
    const street = tags['addr:street'] || tags['addr:place'];
    if (num) h.number = String(num).trim();
    if (street) h.street = String(street).trim();
  }

  function parseOverpass(json) {
    const root = typeof json === 'string' ? JSON.parse(json) : json;
    if (!root || !Array.isArray(root.elements)) throw new Error('No elements');
    const buildings = [], points = [];
    for (const el of root.elements) {
      if (!el) continue;
      const tags = el.tags || {};
      if (el.type === 'way') {
        const b = tags.building;
        if (!b || NOT_A_DOOR.has(b)) continue;
        const g = el.geometry;
        if (!Array.isArray(g) || g.length < 4) continue;
        const la = [], lo = [];
        let ok = true;
        for (const p of g) {
          if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') { ok = false; break; }
          la.push(p.lat); lo.push(p.lon);
        }
        if (!ok) continue;
        const h = makeHouse('w' + el.id, la, lo);
        setOsmAddress(h, tags);
        buildings.push(h);
      } else if (el.type === 'node') {
        if (typeof el.lat !== 'number' || typeof el.lon !== 'number' || !tags['addr:housenumber']) continue;
        points.push(el);
      }
    }
    const out = buildings.slice();
    for (const p of points) {
      const inside = buildings.find(h => houseContains(h, p.lat, p.lon));
      if (inside) { if (!inside.number) setOsmAddress(inside, p.tags); }
      else { const h = makePoint('n' + p.id, p.lat, p.lon); setOsmAddress(h, p.tags); out.push(h); }
    }
    return out;
  }

  // ------------------------------------------------------------ official Kansas 911 address points
  const SOURCES = [
    { name: 'Kansas DASC', s: 36.8, w: -102.2, n: 40.1, e: -94.4,
      url: 'https://services6.arcgis.com/7XhimSpf8B7lHIMy/ArcGIS/rest/services/AddressPoints_NG911_ALL_GCS/FeatureServer/0/query' },
    { name: 'Sedgwick County', s: 37.45, w: -97.83, n: 37.93, e: -97.13,
      url: 'https://gismaps.sedgwickcounty.org/arcgis/rest/services/Map/FS_NG911_BV_Dynamic_SP/MapServer/39/query' },
    { name: 'Kansas KGS', s: 36.8, w: -102.2, n: 40.1, e: -94.4,
      url: 'https://services.kgs.ku.edu/arcgis/rest/services/ORKA/KS_ORKA_Extras/MapServer/0/query' },
  ];
  function covers(src, b) { return b.n > src.s && b.s < src.n && b.e > src.w && b.w < src.e; }
  function inKansas(b) { return b.n > 36.9 && b.s < 40.1 && b.e > -102.1 && b.w < -94.5; }

  const KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'US', 'K', 'KS', 'SR', 'CR', 'II', 'III', 'IV']);
  function titleCase(s) {
    return String(s).trim().split(/\s+/).filter(Boolean).map(w => {
      const u = w.toUpperCase();
      if (KEEP_UPPER.has(u) || (/\d/.test(u) && !/^\d+(ST|ND|RD|TH)$/.test(u))) return u;
      let out = '', start = true;
      for (const c of u.toLowerCase()) {
        out += (start && /[a-z]/.test(c)) ? c.toUpperCase() : c;
        start = !/[a-z0-9]/i.test(c);
      }
      return out;
    }).join(' ');
  }

  function field(a, k) {
    const v = a[k];
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    return String(v).trim();
  }

  function addressQueryUrl(src, b, page) {
    const env = JSON.stringify({ xmin: +b.w.toFixed(6), ymin: +b.s.toFixed(6), xmax: +b.e.toFixed(6), ymax: +b.n.toFixed(6), spatialReference: { wkid: 4326 } });
    return src.url + '?where=1%3D1&geometry=' + encodeURIComponent(env) +
      '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects' +
      '&outFields=*&returnGeometry=true&outSR=4326&resultOffset=' + (page * 1000) + '&resultRecordCount=1000&f=json';
  }

  /** ArcGIS reply → [{id, lat, lon, number, street, city}]; sets result.more if there's another page. */
  function parseAddresses(json) {
    const root = typeof json === 'string' ? JSON.parse(json) : json;
    if (!root) throw new Error('bad reply');
    if (root.error) throw new Error('query refused' + (root.error.message ? ' (' + root.error.message + ')' : ''));
    if (!Array.isArray(root.features)) throw new Error('no features in reply');
    const out = [];
    out.more = root.exceededTransferLimit === true || !!(root.properties && root.properties.exceededTransferLimit);
    let synthetic = 1;
    for (const f of root.features) {
      if (!f || !f.attributes || !f.geometry) continue;
      const a = {};
      for (const k of Object.keys(f.attributes)) a[k.toUpperCase()] = f.attributes[k];
      const lon = f.geometry.x, lat = f.geometry.y;
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      let num = field(a, 'HNO'), hns = field(a, 'HNS');
      let street = ['PRD', 'STP', 'RD', 'STS', 'POD', 'POM'].map(k => field(a, k)).filter(Boolean).join(' ');
      if (!num || !street) {
        const label = field(a, 'LABEL') || field(a, 'FULLADDR') || field(a, 'ADDRESS');
        const m = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(label);
        if (!m) continue;
        num = m[1]; hns = ''; street = m[2];
      }
      if (!num || num === '0') continue;
      if (hns) num = num + (hns.startsWith('1/') ? ' ' : '') + hns;
      let st = titleCase(street);
      const unit = field(a, 'UNIT');
      if (unit && st.indexOf('#') < 0) st += ' #' + unit;
      let id = Number(a.OBJECTID || a.FID || 0);
      if (!id) id = synthetic++;
      out.push({ id, lat, lon, number: num, street: st, city: titleCase(field(a, 'MSAGCO') || field(a, 'POSTCO')),
        zip: (field(a, 'ZIP') || field(a, 'ZIPCODE') || field(a, 'POSTCODE')).replace(/\.0$/, '').slice(0, 10) });
    }
    return out;
  }

  function addAllNew(all, more) {
    for (const a of more) {
      const dup = all.some(b => Math.abs(a.lat - b.lat) < 0.0001 && Math.abs(a.lon - b.lon) < 0.0001 &&
        a.number.toLowerCase() === b.number.toLowerCase() && meters(a.lat, a.lon, b.lat, b.lon) < 6);
      if (!dup) all.push(a);
    }
    return all;
  }

  /** Official points win; second point on one building becomes its own square; OSM guesses near official data are dropped. */
  function merge(osm, official) {
    if (!official.length) return osm;
    const buildings = osm.filter(h => h.lats), osmPoints = osm.filter(h => !h.lats);
    const claimed = new Set();
    const out = buildings.slice();
    for (const a of official) {
      const inside = buildings.find(h => houseContains(h, a.lat, a.lon));
      if (inside && !claimed.has(inside)) {
        claimed.add(inside);
        inside.number = a.number; inside.street = a.street; inside.official = true; inside.city = a.city || ''; inside.zip = a.zip || '';
      } else {
        const p = makePoint('a' + a.id, a.lat, a.lon);
        p.number = a.number; p.street = a.street; p.official = true; p.city = a.city || ''; p.zip = a.zip || '';
        out.push(p);
      }
    }
    for (const p of osmPoints) {
      if (!official.some(a => meters(p.lat, p.lon, a.lat, a.lon) < 40)) out.push(p);
    }
    for (const h of buildings) {
      if (h.official || !h.number) continue;
      if (official.some(a => meters(h.lat, h.lon, a.lat, a.lon) < 60)) { h.number = ''; h.street = ''; }
    }
    return out;
  }

  // ------------------------------------------------------------ search
  const SEARCH_SKIP = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'NORTH', 'SOUTH', 'EAST', 'WEST',
    'ST', 'STREET', 'RD', 'ROAD', 'AVE', 'AV', 'AVENUE', 'CT', 'COURT', 'DR', 'DRIVE', 'LN', 'LANE',
    'BLVD', 'BOULEVARD', 'CIR', 'CIRCLE', 'PL', 'PLACE', 'TER', 'TERRACE', 'WAY', 'PKWY', 'PARKWAY',
    'TRL', 'TRAIL', 'KS', 'KANSAS', 'APT', 'UNIT']);

  function searchWhere(text) {
    const tokens = String(text).toUpperCase().replace(/#/g, ' ').split(/[^A-Z0-9-]+/);
    let number = null;
    const words = [];
    for (let t of tokens) {
      t = t.replace(/^-+|-+$/g, '');
      if (!t) continue;
      if (number === null && !words.length && /^\d{1,6}$/.test(t)) { number = t; continue; }
      if (SEARCH_SKIP.has(t)) continue;
      words.push(t);
    }
    if (!words.length) return null;
    const parts = [];
    if (number !== null) parts.push('HNO = ' + parseInt(number, 10));
    for (const w of words) {
      parts.push("(UPPER(RD) LIKE '%" + w + "%' OR UPPER(MSAGCO) LIKE '%" + w + "%' OR UPPER(POSTCO) LIKE '%" + w + "%')");
    }
    return parts.join(' AND ');
  }

  function parseReverse(json) {
    const root = typeof json === 'string' ? JSON.parse(json) : json;
    const a = root && root.address;
    if (!a) return null;
    const road = a.road || a.hamlet;
    if (!road) return null;
    return a.house_number ? a.house_number + ' ' + road : road;
  }

  // ------------------------------------------------------------ sync rules
  /** Should a door from the shared list replace what this phone has? (newest change wins) */
  function remoteWins(local, remote) {
    if (!local) return true;
    return remote.updated_at >= local.updated_at;
  }
  function toServer(v) {
    return { id: v.id, lat: v.lat, lon: v.lon, visit_time: v.visit_time, outcome: v.outcome,
      address: v.address || '', note: v.note || '', updated_at: v.updated_at, deleted: !!v.deleted };
  }

  // ------------------------------------------------------------ CSV (same format as the Android app)
  function csvCell(s) {
    s = String(s == null ? '' : s);
    if (s && '=+-@\t\r'.indexOf(s[0]) >= 0) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function isoLocal(ms) {
    const d = new Date(ms);
    const pad = n => String(Math.abs(n)).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' +
      pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
  }
  function exportCsv(visits) {
    let out = 'Latitude,Longitude,Outcome,Address,Note,Visit time\r\n';
    for (const v of visits) {
      out += v.lat.toFixed(7) + ',' + v.lon.toFixed(7) + ',' + csvCell(OUT[v.outcome].label) + ',' + csvCell(v.address) + ',' +
        csvCell(v.note) + ',' + csvCell(isoLocal(v.visit_time)) + '\r\n';
    }
    return out;
  }
  function readCsv(text) {
    const rows = []; let row = [], f = '', q = false, any = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      any = true;
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; rows.push(row); row = []; any = false;
      } else f += c;
    }
    if (any || f || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function uncsv(s) { return (s.length > 1 && s[0] === "'" && '=+-@\t\r'.indexOf(s[1]) >= 0) ? s.slice(1) : s; }
  function parseCsv(text) {
    const rows = readCsv(text);
    if (!rows.length || rows[0].length < 6 || rows[0][0].replace('﻿', '').trim().toLowerCase() !== 'latitude') {
      throw new Error('Not a Prairie Canvassing export');
    }
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length < 6) continue;
      const lat = parseFloat(r[0]), lon = parseFloat(r[1]);
      const o = OUTCOMES.find(x => x.label.toLowerCase() === r[2].trim().toLowerCase() || x.key === r[2].trim().toUpperCase());
      const t = Date.parse(r[5].trim());
      if (!o || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !isFinite(t)) continue;
      out.push({ lat, lon, outcome: o.key, address: uncsv(r[3]).trim(), note: uncsv(r[4]).trim(), visit_time: t });
    }
    return out;
  }

  const api = { OUTCOMES, OUT, CHUNK_ZOOM, tileLon, tileLat, worldX, worldY, chunkX, chunkY, chunkBox, meters,
    contains, labelPoint, makeHouse, makePoint, houseContains, houseAddress, overpassQuery, parseOverpass,
    SOURCES, covers, inKansas, titleCase, addressQueryUrl, parseAddresses, addAllNew, merge, searchWhere,
    parseReverse, remoteWins, toServer, exportCsv, parseCsv, isoLocal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PC = api;
})(typeof self !== 'undefined' ? self : this);
