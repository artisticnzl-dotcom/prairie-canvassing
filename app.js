/* Prairie Canvassing — iPhone / web version. Shares doors with the Android app through Supabase. */
(function () {
  'use strict';
  const CFG = window.PC_CONFIG || {};
  const OUT = PC.OUT, OUTCOMES = PC.OUTCOMES;
  const HOME = [38.1383, -97.4314];
  const HOUSE_ZOOM = 16, MARK_ZOOM = 17;
  const FRESH_MS = 21 * 24 * 3600 * 1000;
  const NAVY = '#102d37', ORANGE = '#fea853';
  const $ = id => document.getElementById(id);

  // ================================================================ small helpers
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  let toastTimer = 0;
  function toast(text, long) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, long ? 4000 : 2200);
  }
  function dialog(title, text, buttons) {
    $('dialogTitle').textContent = title;
    $('dialogText').textContent = text;
    const box = $('dialogButtons');
    box.innerHTML = '';
    const close = () => { $('dialog').hidden = true; $('dialogBack').hidden = true; };
    (buttons || [{ label: 'OK' }]).forEach(b => {
      const btn = el('button', 'plain' + (b.cls ? ' ' + b.cls : ''), b.label);
      btn.onclick = () => { close(); if (b.run) b.run(); };
      box.appendChild(btn);
    });
    $('dialog').hidden = false;
    $('dialogBack').hidden = false;
    $('dialogBack').onclick = close;
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  const fmtDate = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }

  async function fetchText(url, opts, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 20000);
    try {
      const r = await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal }));
      if (!r.ok) throw new Error('server said ' + r.status);
      return await r.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('timed out');
      if (e instanceof TypeError) throw new Error('couldn’t connect');
      throw e;
    } finally { clearTimeout(t); }
  }

  // ================================================================ storage on this phone (IndexedDB)
  const Store = {
    db: null, mem: { visits: new Map(), meta: new Map(), chunks: new Map() },
    open() {
      return new Promise(res => {
        let req;
        try { req = indexedDB.open('prairie-canvassing', 1); } catch (e) { res(false); return; }
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('visits', { keyPath: 'id' });
          d.createObjectStore('meta');
          d.createObjectStore('chunks');
        };
        req.onsuccess = () => { Store.db = req.result; res(true); };
        req.onerror = () => res(false);
        req.onblocked = () => res(false);
      });
    },
    _tx(store, mode, fn) {
      return new Promise((res, rej) => {
        const t = Store.db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        const r = fn(s);
        if (r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    },
    async all(store) { return this.db ? this._tx(store, 'readonly', s => s.getAll()) : [...this.mem[store].values()]; },
    async get(store, key) { return this.db ? this._tx(store, 'readonly', s => s.get(key)) : this.mem[store].get(key); },
    async set(store, key, val) {
      if (this.db) return this._tx(store, 'readwrite', s => s.put(val, key));
      this.mem[store].set(key, val);
    },
    async putVisits(list) {
      if (!list.length) return;
      if (this.db) return this._tx('visits', 'readwrite', s => { list.forEach(v => s.put(v)); });
      list.forEach(v => this.mem.visits.set(v.id, v));
    },
  };

  // ================================================================ doors (visits)
  const byId = new Map();   // every door, deleted ones too (so phones learn about deletions)
  let visits = [];          // shown doors, newest first

  function rebuild() {
    visits = [...byId.values()].filter(v => !v.deleted).sort((a, b) => b.visit_time - a.visit_time || (a.id < b.id ? 1 : -1));
    Overlay.matchDirty = true;
    updateSummary();
    Overlay.redraw();
    if (!$('historyPanel').hidden) buildHistory();
    updateSyncUi();
  }
  function applyLocal(list) { list.forEach(v => byId.set(v.id, v)); rebuild(); }

  async function saveVisit(old, lat, lon, outcome, address, note, keepTime) {
    const now = Date.now();
    const v = {
      id: old ? old.id : uuid(), lat, lon,
      visit_time: old && keepTime ? old.visit_time : now,
      outcome, address, note,
      updated_at: Math.max(now, old ? old.updated_at + 1 : 0),
      deleted: false, dirty: true,
    };
    try {
      await Store.putVisits([v]);
      applyLocal([v]);
      toast(OUT[outcome].label + (address ? ' · ' + address : ''));
      Sync.soon();
    } catch (e) { toast('Couldn’t save this door.', true); }
  }
  async function deleteVisit(v) {
    const d = Object.assign({}, v, { deleted: true, dirty: true, updated_at: Math.max(Date.now(), v.updated_at + 1) });
    await Store.putVisits([d]);
    applyLocal([d]);
    Sync.soon();
  }
  function nearestVisit(lat, lon, m) {
    let best = null, bd = m;
    for (const v of visits) { const d = PC.meters(lat, lon, v.lat, v.lon); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  function updateSummary() {
    const today = startOfToday();
    let doors = 0, booked = 0, done = 0;
    for (const v of visits) {
      if (v.visit_time < today) continue;
      doors++;
      if (v.outcome === 'BOOKED') booked++;
      if (v.outcome === 'COMPLETED') done++;
    }
    $('summary').textContent = 'Today: ' + doors + (doors === 1 ? ' door' : ' doors') + ' · ' + booked + ' booked · ' + done + ' completed (' + visits.length + ' total)';
  }

  // ================================================================ sharing (Supabase)
  const Sync = {
    session: null, cursor: 0, busy: false, lastOk: 0, lastError: '', timer: 0, soonTimer: 0,
    get configured() { return !!(CFG.supabaseUrl && CFG.supabaseKey); },
    base() { return String(CFG.supabaseUrl).replace(/\/+$/, ''); },
    async load() {
      this.session = (await Store.get('meta', 'session')) || null;
      this.cursor = (await Store.get('meta', 'cursor')) || 0;
    },
    async auth(grant, body) {
      let r;
      try {
        r = await fetch(this.base() + '/auth/v1/token?grant_type=' + grant, {
          method: 'POST', headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } catch (e) { const err = new Error('No connection. Try again when you have signal.'); err.offline = true; throw err; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(j.error_description || j.msg || j.message || ('Sign-in failed (' + r.status + ')'));
        err.rejected = r.status >= 400 && r.status < 500;
        throw err;
      }
      return { access_token: j.access_token, refresh_token: j.refresh_token,
        expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: (j.user && j.user.email) || '' };
    },
    async signIn(email, password) {
      this.session = await this.auth('password', { email, password });
      await Store.set('meta', 'session', this.session);
      updateSyncUi();
      await this.run();
    },
    async signOut() {
      const s = this.session;
      this.session = null;
      await Store.set('meta', 'session', null);
      updateSyncUi();
      if (s) fetch(this.base() + '/auth/v1/logout', { method: 'POST', headers: { apikey: CFG.supabaseKey, Authorization: 'Bearer ' + s.access_token } }).catch(() => {});
    },
    async token() {
      if (!this.session) throw new Error('signed out');
      if (Date.now() > this.session.expires_at - 60000) {
        try {
          const s = await this.auth('refresh_token', { refresh_token: this.session.refresh_token });
          s.email = s.email || this.session.email;
          this.session = s;
          await Store.set('meta', 'session', s);
        } catch (e) {
          if (e.rejected) { await this.signOut(); throw new Error('Please sign in again.'); }
          throw e;
        }
      }
      return this.session.access_token;
    },
    async rest(path, opts) {
      const tok = await this.token();
      let r;
      try {
        r = await fetch(this.base() + '/rest/v1/' + path, Object.assign({}, opts, {
          headers: Object.assign({ apikey: CFG.supabaseKey, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}),
        }));
      } catch (e) { throw new Error('offline'); }
      if (r.status === 401) { this.session.expires_at = 0; throw new Error('sign-in expired, retrying'); }
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('server said ' + r.status + (t ? ': ' + t.slice(0, 160) : '')); }
      return r;
    },
    async pull() {
      const since = Math.max(0, this.cursor - 30000); // small overlap so nothing slips between phones
      let cursor = this.cursor;
      for (let page = 0; page < 50; page++) {
        const r = await this.rest('visits?select=id,lat,lon,visit_time,outcome,address,note,updated_at,deleted,synced_at' +
          '&synced_at=gt.' + since + '&order=synced_at.asc,id.asc&limit=1000&offset=' + (page * 1000));
        const rows = await r.json();
        const changed = [];
        for (const row of rows) {
          const local = byId.get(row.id);
          const v = { id: row.id, lat: +row.lat, lon: +row.lon, visit_time: +row.visit_time,
            outcome: OUT[row.outcome] ? row.outcome : 'KNOCKED', address: row.address || '', note: row.note || '',
            updated_at: +row.updated_at, deleted: !!row.deleted, dirty: false };
          if (PC.remoteWins(local, v) && (!local || local.dirty || local.updated_at !== v.updated_at || local.deleted !== v.deleted)) changed.push(v);
          cursor = Math.max(cursor, +row.synced_at || 0);
        }
        if (changed.length) { await Store.putVisits(changed); applyLocal(changed); }
        if (rows.length < 1000) break;
      }
      this.cursor = cursor;
      await Store.set('meta', 'cursor', cursor);
    },
    async push() {
      const dirty = [...byId.values()].filter(v => v.dirty);
      for (let i = 0; i < dirty.length; i += 500) {
        const part = dirty.slice(i, i + 500);
        await this.rest('visits?on_conflict=id', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(part.map(PC.toServer)),
        });
        const clean = [];
        for (const v of part) {
          const cur = byId.get(v.id);
          if (cur && cur.dirty && cur.updated_at === v.updated_at) { cur.dirty = false; clean.push(cur); }
        }
        await Store.putVisits(clean);
      }
    },
    waiting() { let n = 0; byId.forEach(v => { if (v.dirty) n++; }); return n; },
    async run() {
      if (!this.configured || !this.session || this.busy || !navigator.onLine) { updateSyncUi(); return; }
      this.busy = true;
      updateSyncUi();
      try {
        const crew = await (await this.rest('rpc/am_i_crew', { method: 'POST', body: '{}' })).json();
        if (crew !== true) throw new Error('This login isn’t on the crew list yet. Ask your crew lead to add it.');
        await this.pull();   // newer doors from the crew first, so an old edit here can't win
        await this.push();
        this.lastOk = Date.now();
        this.lastError = '';
      } catch (e) {
        this.lastError = e.message || String(e);
      } finally {
        this.busy = false;
        updateSyncUi();
      }
    },
    soon() { clearTimeout(this.soonTimer); this.soonTimer = setTimeout(() => this.run(), 1500); },
    start() {
      clearInterval(this.timer);
      this.timer = setInterval(() => { if (document.visibilityState === 'visible') this.run(); }, 20000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.run(); });
      window.addEventListener('online', () => this.run());
      window.addEventListener('offline', updateSyncUi);
      this.run();
    },
  };

  function updateSyncUi() {
    const dot = $('syncDot'), text = $('syncText');
    const waiting = Sync.waiting();
    let cls = 'off', t = 'Not shared';
    if (Sync.configured && Sync.session) {
      if (!navigator.onLine) { cls = 'wait'; t = waiting ? 'Offline · ' + waiting + ' waiting' : 'Offline'; }
      else if (Sync.lastError) { cls = 'err'; t = /crew list/.test(Sync.lastError) ? 'Not on crew list' : 'Sync problem'; }
      else if (Sync.busy) { cls = 'wait'; t = 'Syncing…'; }
      else if (waiting) { cls = 'wait'; t = waiting + ' waiting'; }
      else if (Sync.lastOk) { cls = 'ok'; t = 'Shared'; }
      else { cls = 'wait'; t = 'Connecting…'; }
    }
    dot.className = 'dot ' + cls;
    text.textContent = t;
    if (!$('account').hidden) buildAccount(false);
  }

  // ================================================================ houses (outlines + official addresses)
  const Houses = {
    chunks: new Map(), byKey: new Map(), complete: new Set(), official: new Map(), retryAt: new Map(),
    loading: false, failures: 0, lastError: '',
    key(x, y) { return x + '_' + y; },
    get(x, y) { return this.chunks.get(this.key(x, y)) || []; },
    isLoaded(x, y) { return this.chunks.has(this.key(x, y)); },
    officialState(x, y) { return this.official.get(this.key(x, y)) || 'unknown'; },
    publish(k, list) {
      const uniq = list.map(h => {
        const have = this.byKey.get(h.key);
        if (!have) { this.byKey.set(h.key, h); return h; }
        if (h.official || !have.number) { have.number = h.number; have.street = h.street; have.official = h.official; }
        return have;
      });
      this.chunks.set(k, uniq);
    },
    async cached(name) {
      try {
        const c = await Store.get('chunks', name);
        return c && Date.now() - c.t < FRESH_MS ? c.v : null;
      } catch (e) { return null; }
    },
    async loadOfficial(x, y, b) {
      const name = 'ks2_' + PC.CHUNK_ZOOM + '_' + x + '_' + y;
      const c = await this.cached(name);
      if (c) return c;
      let all = [], answered = 0;
      const why = [];
      for (let i = 0; i < PC.SOURCES.length; i++) {
        const src = PC.SOURCES[i];
        if (!PC.covers(src, b)) continue;
        try {
          const got = [];
          for (let page = 0; page < 20; page++) {
            const part = PC.parseAddresses(await fetchText(PC.addressQueryUrl(src, b, page), null, 25000));
            got.push(...part);
            if (!part.more) break;
          }
          got.forEach(a => { a.id = a.id * 4 + i; });
          answered++;
          PC.addAllNew(all, got);
        } catch (e) { why.push(src.name + ': ' + e.message); }
      }
      if (!answered) { this.lastError = why.join('\n'); throw new Error(this.lastError); }
      this.lastError = '';
      Store.set('chunks', name, { t: Date.now(), v: all }).catch(() => {});
      return all;
    },
    async loadOsm(x, y, b) {
      const name = 'osm_' + PC.CHUNK_ZOOM + '_' + x + '_' + y;
      let text = await this.cached(name);
      if (!text) {
        const body = 'data=' + encodeURIComponent(PC.overpassQuery(b));
        let last;
        for (const server of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
          try {
            text = await fetchText(server, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 45000);
            PC.parseOverpass(text); // make sure it's good before keeping it
            Store.set('chunks', name, { t: Date.now(), v: text }).catch(() => {});
            break;
          } catch (e) { last = e; text = null; }
        }
        if (!text) throw last || new Error('no server');
      }
      return PC.parseOverpass(text);
    },
    want(x, y) {
      const k = this.key(x, y);
      if (this.complete.has(k) || this.loading) return;
      const r = this.retryAt.get(k);
      if (r && r > Date.now()) return;
      this.loading = true;
      (async () => {
        const b = PC.chunkBox(x, y);
        let official = [], state = 'none';
        if (PC.inKansas(b)) {
          try { official = await this.loadOfficial(x, y, b); state = 'ok'; } catch (e) { state = 'failed'; }
        }
        this.official.set(k, state);
        const early = PC.merge([], official);
        if (!this.chunks.has(k) || early.length) this.publish(k, early);
        housesChanged();
        let full = null;
        try { full = PC.merge(await this.loadOsm(x, y, b), official); } catch (e) { /* outlines are optional */ }
        if (full) this.publish(k, full);
        if (full && state !== 'failed') { this.complete.add(k); this.retryAt.delete(k); this.failures = 0; }
        else { this.failures++; this.retryAt.set(k, Date.now() + Math.min(120000, 15000 * this.failures)); }
        this.loading = false;
        housesChanged();
      })();
    },
  };
  function housesChanged() { Overlay.matchDirty = true; Overlay.redraw(); updateHint(); }

  // ================================================================ map
  const view = lsGet('pc-view', { lat: HOME[0], lon: HOME[1], zoom: 16 });
  const map = L.map('map', { zoomControl: false, attributionControl: false, maxZoom: 21, minZoom: 3,
    tapHold: true, doubleClickZoom: true, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 }).setView([view.lat, view.lon], view.zoom);

  const layers = {
    STREET: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 21 }),
    SATELLITE: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 19, maxZoom: 21 }),
  };
  layers.SATELLITE.on('tileerror', e => {
    if (e.tile.dataset.fallback) return;
    e.tile.dataset.fallback = '1';
    e.tile.src = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + e.coords.z + '/' + e.coords.y + '/' + e.coords.x;
  });
  const ATTRIB = {
    STREET: '© OpenStreetMap contributors · Addresses Kansas 911 (DASC)',
    SATELLITE: 'Imagery USGS · Esri, Maxar · Houses © OpenStreetMap · Addresses Kansas 911 (DASC)',
  };
  let layerName = lsGet('pc-layer', 'STREET');
  if (!layers[layerName]) layerName = 'STREET';
  layers[layerName].addTo(map);
  function setLayer(name) {
    map.removeLayer(layers[layerName]);
    layerName = name;
    layers[name].addTo(map);
    lsSet('pc-layer', name);
    $('layerBtn').textContent = name === 'SATELLITE' ? 'Street map' : 'Satellite';
    $('attribution').textContent = ATTRIB[name];
    Overlay.redraw();
  }

  // One canvas over the map for houses, doors, your location and the selection.
  const Overlay = {
    canvas: null, ctx: null, matchDirty: true, frame: 0, houseOf: new Map(), sel: null, gps: null,
    init() {
      const pane = map.createPane('pcOverlay');
      pane.style.zIndex = 450;
      pane.style.pointerEvents = 'none';
      this.canvas = L.DomUtil.create('canvas', '', pane);
      this.ctx = this.canvas.getContext('2d');
      map.on('move resize zoomend viewreset', () => this.redraw());
      map.on('zoomstart', () => { this.canvas.style.visibility = 'hidden'; });
      map.on('zoomend', () => { this.canvas.style.visibility = ''; });
    },
    redraw() {
      if (!this.canvas || this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => { this.pending = false; this.draw(); });
    },
    // fast lat/lon → screen
    prep() {
      const z = map.getZoom();
      this.scale = 256 * Math.pow(2, z);
      const origin = map.getPixelOrigin();
      const pane = L.DomUtil.getPosition(map.getPane('mapPane')) || L.point(0, 0);
      this.ox = -origin.x + pane.x;
      this.oy = -origin.y + pane.y;
      this.z = z;
    },
    sx(lon) { return PC.worldX(lon) * this.scale + this.ox; },
    sy(lat) { return PC.worldY(lat) * this.scale + this.oy; },
    visibleChunks() {
      const b = map.getBounds(), n = 1 << PC.CHUNK_ZOOM;
      return { x0: PC.chunkX(b.getWest()), x1: PC.chunkX(b.getEast()),
        y0: Math.max(0, PC.chunkY(b.getNorth())), y1: Math.min(n - 1, PC.chunkY(b.getSouth())) };
    },
    match() {
      this.matchDirty = false;
      this.houseOf.clear();
      const touched = new Set();
      for (const v of visits) {
        const cx = PC.chunkX(v.lon), cy = PC.chunkY(v.lat);
        let found = null;
        for (const h of Houses.get(cx, cy)) {
          if (h.lats ? PC.houseContains(h, v.lat, v.lon) : (Math.abs(h.lat - v.lat) < 0.00002 && Math.abs(h.lon - v.lon) < 0.00002)) { found = h; break; }
        }
        if (!found) continue;
        this.houseOf.set(v.id, found);
        if (!touched.has(found)) { touched.add(found); found.visit = v; }
      }
      Houses.byKey.forEach(h => { if (!touched.has(h)) h.visit = null; });
    },
    badgeShown(v) { const h = this.houseOf.get(v.id); return !h || h.visit === v; },
    draw() {
      const size = map.getSize(), r = window.devicePixelRatio || 1, c = this.canvas, ctx = this.ctx;
      if (c.width !== Math.round(size.x * r) || c.height !== Math.round(size.y * r)) {
        c.width = Math.round(size.x * r); c.height = Math.round(size.y * r);
        c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      }
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      ctx.setTransform(r, 0, 0, r, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      this.prep();
      this.frame++;
      if (this.matchDirty) this.match();
      const sat = layerName === 'SATELLITE';
      const zoom = this.z;
      if (zoom >= HOUSE_ZOOM - 0.5) this.drawHouses(ctx, size, sat, zoom);
      if (this.gps) this.drawGps(ctx);
      const big = zoom >= 16.5;
      for (let i = visits.length - 1; i >= 0; i--) {
        const v = visits[i];
        if (!this.badgeShown(v)) continue;
        const x = this.sx(v.lon), y = this.sy(v.lat);
        if (x < -40 || x > size.x + 40 || y < -40 || y > size.y + 40) continue;
        this.badge(ctx, x, y, OUT[v.outcome], big);
      }
      if (this.sel && !(this.sel.house && this.sel.house.lats)) this.drawSel(ctx);
    },
    path(ctx, h) {
      ctx.beginPath();
      ctx.moveTo(this.sx(h.lons[0]), this.sy(h.lats[0]));
      for (let i = 1; i < h.lats.length; i++) ctx.lineTo(this.sx(h.lons[i]), this.sy(h.lats[i]));
      ctx.closePath();
    },
    drawHouses(ctx, size, sat, zoom) {
      const vc = this.visibleChunks(), n = 1 << PC.CHUNK_ZOOM;
      const want = zoom >= HOUSE_ZOOM, labels = zoom >= 18;
      if (want) Houses.want(((PC.chunkX(map.getCenter().lng) % n) + n) % n, PC.chunkY(map.getCenter().lat));
      ctx.lineJoin = 'round';
      ctx.font = 'bold 11px -apple-system, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const fillU = sat ? 'rgba(255,255,255,.15)' : 'rgba(254,168,83,.25)';
      const lineU = sat ? 'rgba(255,255,255,.85)' : '#e0892f';
      for (let x = vc.x0; x <= vc.x1; x++) {
        for (let y = vc.y0; y <= vc.y1; y++) {
          const wx = ((x % n) + n) % n;
          if (want && !Houses.complete.has(Houses.key(wx, y))) Houses.want(wx, y);
          for (const h of Houses.get(wx, y)) {
            if (h.stamp === this.frame) continue;
            h.stamp = this.frame;
            if (!h.lats) {
              const px = this.sx(h.lon), py = this.sy(h.lat);
              if (px < -20 || px > size.x + 20 || py < -20 || py > size.y + 20 || h.visit) continue;
              ctx.fillStyle = '#fff'; ctx.fillRect(px - 6, py - 6, 12, 12);
              ctx.fillStyle = '#e0892f'; ctx.fillRect(px - 5, py - 5, 10, 10);
              if (labels && h.number) this.label(ctx, h.number, px, py - 13, sat);
              continue;
            }
            const x0 = this.sx(h.minLon), x1 = this.sx(h.maxLon), y0 = this.sy(h.maxLat), y1 = this.sy(h.minLat);
            if (x1 < 0 || x0 > size.x || y1 < 0 || y0 > size.y) continue;
            this.path(ctx, h);
            if (h.visit) { const o = OUT[h.visit.outcome]; ctx.fillStyle = o.color + 'b3'; ctx.strokeStyle = o.color; }
            else { ctx.fillStyle = fillU; ctx.strokeStyle = lineU; }
            ctx.fill();
            ctx.lineWidth = zoom >= 18 ? 1.6 : 1.1;
            ctx.stroke();
            if (labels && !h.visit && h.number && x1 - x0 > 18) this.label(ctx, h.number, this.sx(h.lon), this.sy(h.lat), sat);
          }
        }
      }
      const s = this.sel && this.sel.house;
      if (s && s.lats) {
        this.path(ctx, s);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.stroke();
        ctx.strokeStyle = ORANGE; ctx.lineWidth = 3.5; ctx.stroke();
      }
    },
    label(ctx, s, x, y, sat) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = sat ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.9)';
      ctx.strokeText(s, x, y);
      ctx.fillStyle = sat ? '#fff' : NAVY;
      ctx.fillText(s, x, y);
    },
    badge(ctx, x, y, o, big) {
      const r = big ? 11 : 6;
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.arc(x, y + 1, r + 2, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.fill();
      ctx.fillStyle = o.color; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      if (big) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 12.5px -apple-system, Roboto, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(o.mark, x, y + 0.5);
      }
    },
    drawSel(ctx) {
      const x = this.sx(this.sel.lon), y = this.sy(this.sel.lat);
      ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.stroke();
      ctx.lineWidth = 3.5; ctx.strokeStyle = ORANGE; ctx.stroke();
      ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
    },
    drawGps(ctx) {
      const g = this.gps, x = this.sx(g.lon), y = this.sy(g.lat);
      const acc = Math.min(360, g.acc * this.scale / (Math.cos(g.lat * Math.PI / 180) * 40075017));
      ctx.fillStyle = 'rgba(35,105,220,.19)'; ctx.beginPath(); ctx.arc(x, y, Math.max(9, acc), 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill();
      ctx.fillStyle = '#2369dc'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill();
    },
    // ---- what's under a tap
    visitAt(p) {
      this.prep();
      let best = 20, hit = null;
      for (const v of visits) {
        if (!this.badgeShown(v)) continue;
        const d = Math.hypot(p.x - this.sx(v.lon), p.y - this.sy(v.lat));
        if (d < best) { best = d; hit = v; }
      }
      return hit;
    },
    houseAt(p, la, lo) {
      if (map.getZoom() < HOUSE_ZOOM) return null;
      this.prep();
      const cx = PC.chunkX(lo), cy = PC.chunkY(la), n = 1 << PC.CHUNK_ZOOM;
      let pointHit = null, inside = null, best = 22;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const h of Houses.get((((cx + dx) % n) + n) % n, cy + dy)) {
          if (!h.lats) {
            const d = Math.hypot(p.x - this.sx(h.lon), p.y - this.sy(h.lat));
            if (d < best) { best = d; pointHit = h; }
          } else if (!inside && PC.houseContains(h, la, lo)) inside = h;
        }
      }
      if (pointHit && (best < 14 || !inside)) return pointHit;
      if (inside) return inside;
      let near = null, nd = Infinity;
      for (const h of Houses.get(cx, cy)) {
        if (!h.lats) continue;
        const x0 = this.sx(h.minLon) - 10, x1 = this.sx(h.maxLon) + 10, y0 = this.sy(h.maxLat) - 10, y1 = this.sy(h.minLat) + 10;
        if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
        const d = Math.hypot(p.x - this.sx(h.lon), p.y - this.sy(h.lat));
        if (d < nd) { nd = d; near = h; }
      }
      return near;
    },
    nearestAddress(la, lo, maxM) {
      const cx = PC.chunkX(lo), cy = PC.chunkY(la), n = 1 << PC.CHUNK_ZOOM;
      let best = null, bd = maxM;
      for (let pass = 0; pass < 2 && !best; pass++) {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          for (const h of Houses.get((((cx + dx) % n) + n) % n, cy + dy)) {
            if (!h.number || (pass === 0 && !h.official)) continue;
            const d = PC.houseContains(h, la, lo) ? 0 : PC.meters(la, lo, h.lat, h.lon);
            if (d < bd) { bd = d; best = h; }
          }
        }
      }
      return best;
    },
  };

  function chunkOf(la, lo) { const n = 1 << PC.CHUNK_ZOOM; return [((PC.chunkX(lo) % n) + n) % n, PC.chunkY(la)]; }
  function addressesSettled(la, lo) { const [x, y] = chunkOf(la, lo); return Houses.officialState(x, y) !== 'unknown'; }
  function addressesFailed(la, lo) { const [x, y] = chunkOf(la, lo); return Houses.officialState(x, y) === 'failed'; }

  function houseStatus() {
    if (map.getZoom() < HOUSE_ZOOM) return 'Zoom in to see and tap houses';
    const vc = Overlay.visibleChunks(), n = 1 << PC.CHUNK_ZOOM;
    let count = 0, allComplete = true, pending = false, failed = false;
    for (let x = vc.x0; x <= vc.x1; x++) for (let y = vc.y0; y <= vc.y1; y++) {
      const wx = ((x % n) + n) % n;
      if (!Houses.complete.has(Houses.key(wx, y))) allComplete = false;
      count += Houses.get(wx, y).length;
      const st = Houses.officialState(wx, y);
      if (st === 'unknown') pending = true;
      if (st === 'failed') failed = true;
    }
    if (pending && Houses.loading) return 'Loading addresses…';
    if (failed) return 'Couldn’t reach county addresses — tap for details';
    if (!allComplete && Houses.loading) return 'Loading house outlines…';
    if (!allComplete && Houses.failures) return 'Couldn’t load outlines — tap any roof to mark it';
    if (!count && allComplete) return 'No houses mapped here — tap a roof to mark it';
    return 'Tap a house to log it · hold to drop a pin';
  }
  function updateHint() { $('hint').textContent = houseStatus(); }

  // ---- taps
  // A single tap waits a moment so a double-tap (zoom) or long press doesn't also open a door.
  let tapTimer = 0, lastHold = 0;
  map.on('dblclick', () => clearTimeout(tapTimer));
  map.on('click', e => {
    clearTimeout(tapTimer);
    if (Date.now() - lastHold < 700) return;
    tapTimer = setTimeout(() => handleTap(e), 260);
  });
  function handleTap(e) {
    const p = e.containerPoint, la = e.latlng.lat, lo = e.latlng.lng;
    const v = Overlay.visitAt(p);
    if (v) { openSheet({ visit: v }); return; }
    const h = Overlay.houseAt(p, la, lo);
    if (h) { houseTapped(h); return; }
    if (map.getZoom() < MARK_ZOOM) {
      map.setZoomAround(e.latlng, Math.max(MARK_ZOOM, Math.min(18, map.getZoom() + 2)));
      return;
    }
    const near = nearestVisit(la, lo, 12);
    if (near) { openSheet({ visit: near }); return; }
    openSheet({ lat: la, lon: lo, lookup: true });
  }
  map.on('contextmenu', e => {
    clearTimeout(tapTimer);
    lastHold = Date.now();
    if (navigator.vibrate) navigator.vibrate(20);
    openSheet({ lat: e.latlng.lat, lon: e.latlng.lng, lookup: true });
  });

  function houseTapped(h) {
    if (h.visit) { openSheet({ visit: h.visit, house: h }); return; }
    if (h.number && (h.official || addressesSettled(h.lat, h.lon))) {
      openSheet({ house: h, lat: h.lat, lon: h.lon, address: PC.houseAddress(h), source: sourceNote(h) });
    } else openSheet({ house: h, lat: h.lat, lon: h.lon, lookup: true });
  }
  function sourceNote(h) { return h.official ? '✓ County 911 address' : 'From OpenStreetMap — check the number'; }

  let following = false, userMoved = false;
  map.on('dragstart', () => { userMoved = true; });
  map.on('moveend', () => {
    if (userMoved && following) { following = false; $('locateBtn').classList.remove('follow'); }
    userMoved = false;
    const c = map.getCenter();
    lsSet('pc-view', { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    updateHint();
  });

  // ================================================================ door sheet
  let sheetToken = 0;
  function closeSheet() {
    sheetToken++;
    $('sheet').hidden = true;
    $('sheetBack').hidden = true;
    Overlay.sel = null;
    Overlay.redraw();
    if (document.activeElement) document.activeElement.blur();
  }
  $('sheetBack').onclick = closeSheet;

  function setSource(text) {
    const s = $('addrSource');
    s.textContent = text || '';
    s.hidden = !text;
    s.className = 'source' + (/^✓/.test(text) ? ' ok' : /^(⚠|Couldn|From)/.test(text) ? ' warn' : '');
  }

  function openSheet(o) {
    const visit = o.visit || null;
    const lat = visit ? visit.lat : o.lat, lon = visit ? visit.lon : o.lon;
    const token = ++sheetToken;
    Overlay.sel = { lat, lon, house: o.house || null };
    Overlay.redraw();
    const addr = $('addr'), note = $('note');
    addr.value = visit ? visit.address : (o.address || '');
    note.value = visit ? visit.note : '';
    setSource(o.lookup && !visit ? 'Looking up address…' : (o.source || ''));
    const last = $('lastVisit');
    if (visit) {
      const oc = OUT[visit.outcome];
      last.innerHTML = '';
      const pill = el('span', 'pill', oc.label);
      pill.style.background = oc.color;
      last.append(pill, document.createTextNode(fmtDate(visit.visit_time)));
      last.hidden = false;
    } else last.hidden = true;
    $('outcomeLabel').textContent = visit ? 'Tap a result to update' : 'Tap the result to save';
    const box = $('outcomes');
    box.innerHTML = '';
    for (const oc of OUTCOMES) {
      const b = el('button', 'outcome' + (visit && visit.outcome === oc.key ? ' current' : ''), oc.label);
      b.style.background = oc.color;
      b.setAttribute('aria-label', 'Save as ' + oc.label);
      b.onclick = () => { closeSheet(); saveVisit(visit, lat, lon, oc.key, addr.value.trim(), note.value.trim(), false); };
      box.appendChild(b);
    }
    const acts = $('sheetActions');
    acts.innerHTML = '';
    if (visit) {
      const sn = el('button', 'plain', 'Save notes');
      sn.onclick = () => { closeSheet(); saveVisit(visit, lat, lon, visit.outcome, addr.value.trim(), note.value.trim(), true); };
      acts.appendChild(sn);
    }
    const dir = el('button', 'plain', 'Directions');
    dir.onclick = () => { window.open('https://maps.apple.com/?daddr=' + lat.toFixed(7) + ',' + lon.toFixed(7), '_blank'); };
    acts.appendChild(dir);
    if (visit && !$('historyPanel').hidden) {
      const show = el('button', 'plain', 'Show on map');
      show.onclick = () => { closeSheet(); goTo(lat, lon); };
      acts.appendChild(show);
    }
    if (visit) {
      const del = el('button', 'plain danger', 'Delete');
      del.onclick = () => {
        closeSheet();
        dialog('Delete this visit?', visit.address || (lat.toFixed(5) + ', ' + lon.toFixed(5)),
          [{ label: 'Keep' }, { label: 'Delete', cls: 'danger', run: () => deleteVisit(visit) }]);
      };
      acts.appendChild(del);
    }
    $('sheet').hidden = false;
    $('sheetBack').hidden = false;
    $('sheet').scrollTop = 0;

    if (!visit && o.lookup) lookUpAddress(token, lat, lon, o.house || null);
  }

  /** Wait for the county's official addresses before falling back to a street-name guess. */
  function lookUpAddress(token, lat, lon, house) {
    const started = Date.now();
    Houses.want(...chunkOf(lat, lon));
    const attempt = () => {
      if (token !== sheetToken) return;
      const addr = $('addr');
      if (addr.value.trim()) { if ($('addrSource').textContent === 'Looking up address…') setSource(''); return; }
      const near = house && house.number && house.official ? house : Overlay.nearestAddress(lat, lon, 35);
      if (near && (near.official || addressesSettled(lat, lon))) {
        addr.value = PC.houseAddress(near);
        setSource(near.official ? ((near === house || PC.houseContains(near, lat, lon)) ? '✓ County 911 address' : '✓ Nearest county 911 address — check it') : sourceNote(near));
        return;
      }
      if (!addressesSettled(lat, lon) && Date.now() - started < 12000) { setTimeout(attempt, 400); return; }
      const unreachable = addressesFailed(lat, lon);
      fetchText('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=' + lat.toFixed(7) + '&lon=' + lon.toFixed(7), null, 10000)
        .then(t => PC.parseReverse(t)).catch(() => null).then(found => {
          if (token !== sheetToken || addr.value.trim()) return;
          if (!found) { setSource('Couldn’t find this address — type it in'); return; }
          addr.value = ' ' + found.replace(/^\d+[A-Za-z]?(-\d+)?\s+/, '');
          setSource(unreachable ? '⚠ Type the house number — couldn’t reach county records' : '⚠ Type the house number — no county record found here');
        });
    };
    attempt();
  }

  function goTo(lat, lon) {
    showTab(false);
    following = false;
    $('locateBtn').classList.remove('follow');
    map.setView([lat, lon], Math.max(18.5, map.getZoom()));
    Houses.want(...chunkOf(lat, lon));
  }

  // ================================================================ history
  let filter = 'ALL';
  function showTab(history) {
    $('tabMap').classList.toggle('on', !history);
    $('tabHistory').classList.toggle('on', history);
    $('mapPanel').hidden = history;
    $('historyPanel').hidden = !history;
    if (history) buildHistory(); else setTimeout(() => map.invalidateSize(), 0);
  }
  $('tabMap').onclick = () => showTab(false);
  $('tabHistory').onclick = () => showTab(true);

  function buildHistory() {
    const chips = $('chips');
    chips.innerHTML = '';
    const counts = {};
    visits.forEach(v => { counts[v.outcome] = (counts[v.outcome] || 0) + 1; });
    const chip = (key, label, color) => {
      const on = filter === key;
      const c = el('button', 'chip', label);
      c.style.color = on ? '#fff' : color;
      c.style.background = on ? (key === 'ALL' || key === 'TODAY' ? NAVY : color) : '#fff';
      if (on) c.style.borderColor = 'transparent';
      c.onclick = () => { filter = key; buildHistory(); };
      chips.appendChild(c);
    };
    chip('ALL', 'All', '#193942');
    chip('TODAY', 'Today', '#193942');
    OUTCOMES.forEach(o => chip(o.key, counts[o.key] ? o.label + '  ' + counts[o.key] : o.label, o.color));
    $('exportBtn').disabled = !visits.length;

    const list = $('historyList');
    list.innerHTML = '';
    const today = startOfToday(), yesterday = today - 86400000;
    let lastDay = null, shown = 0, matching = 0;
    for (const v of visits) {
      if (filter === 'TODAY' ? v.visit_time < today : (filter !== 'ALL' && v.outcome !== filter)) continue;
      matching++;
      if (shown >= 500) continue;
      const day = v.visit_time >= today ? 'Today' : v.visit_time >= yesterday ? 'Yesterday'
        : new Date(v.visit_time).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      if (day !== lastDay) { lastDay = day; list.appendChild(el('div', 'day', day)); }
      list.appendChild(visitRow(v, OUT[v.outcome].label + ' · ' + fmtTime(v.visit_time), () => openSheet({ visit: v })));
      shown++;
    }
    if (matching > shown) list.appendChild(el('p', 'muted', 'Showing the latest ' + shown + ' of ' + matching + '. Export CSV to see them all.'));
    if (!shown) {
      const e = el('div', 'empty');
      e.append(el('h3', '', visits.length ? 'Nothing here yet' : 'No doors saved yet'),
        el('p', '', visits.length ? 'Pick another filter to see more visits.' : 'Go to the Map tab and tap a house to log your first knock.'));
      list.appendChild(e);
    }
  }
  function visitRow(v, sub, onTap) {
    const oc = OUT[v.outcome];
    const row = el('button', 'row');
    const b = el('div', 'badge', oc.mark);
    b.style.background = oc.color;
    const col = el('div', 'col');
    const s = el('div', 's', sub);
    s.style.color = oc.color;
    col.append(el('div', 't', v.address || (v.lat.toFixed(5) + ', ' + v.lon.toFixed(5))), s);
    if (v.note) col.appendChild(el('div', 'n', v.note));
    row.append(b, col);
    row.onclick = onTap;
    return row;
  }

  $('exportBtn').onclick = () => {
    const blob = new Blob([PC.exportCsv(visits)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Prairie-Canvassing-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  $('importInput').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const rows = PC.parseCsv(await f.text());
      const add = [];
      for (const r of rows) {
        const dup = visits.some(v => Math.abs(v.lat - r.lat) < 5e-7 && Math.abs(v.lon - r.lon) < 5e-7 && Math.abs(v.visit_time - r.visit_time) < 1000);
        if (dup) continue;
        add.push(Object.assign({ id: uuid(), updated_at: Date.now(), deleted: false, dirty: true }, r));
      }
      await Store.putVisits(add);
      applyLocal(add);
      Sync.soon();
      toast('Imported ' + add.length + (add.length === 1 ? ' visit' : ' visits') + (rows.length > add.length ? ' (' + (rows.length - add.length) + ' already here)' : '') + '.', true);
    } catch (err) { toast('That file isn’t a Prairie Canvassing CSV export.', true); }
  };

  // ================================================================ search
  let searchSeq = 0, searchTimer = 0;
  $('searchBtn').onclick = () => {
    $('search').hidden = false;
    $('searchInput').value = '';
    $('searchResults').innerHTML = '';
    $('searchStatus').textContent = 'Type a house number and street.';
    setTimeout(() => $('searchInput').focus(), 50);
  };
  $('searchClose').onclick = () => { $('search').hidden = true; $('searchInput').blur(); };
  $('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 600); });
  $('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); $('searchInput').blur(); } });

  async function runSearch() {
    const seq = ++searchSeq, t = $('searchInput').value.trim(), out = $('searchResults'), status = $('searchStatus');
    out.innerHTML = '';
    if (t.length < 3) { status.textContent = 'Type a house number and street.'; return; }
    const words = t.toLowerCase().split(/\s+/);
    let saved = 0;
    for (const v of visits) {
      const hay = (v.address + ' ' + v.note).toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
      if (!saved) out.appendChild(el('div', 'day', 'Your saved doors'));
      out.appendChild(visitRow(v, OUT[v.outcome].label + ' · ' + fmtDate(v.visit_time), () => {
        $('search').hidden = true; goTo(v.lat, v.lon); openSheet({ visit: v });
      }));
      if (++saved >= 10) break;
    }
    const where = PC.searchWhere(t);
    if (!where) { status.textContent = saved ? '' : 'Add a street name, e.g. 459 Ridge.'; return; }
    status.textContent = 'Searching county addresses…';
    const c = map.getCenter();
    let found = null;
    const why = [];
    for (const src of PC.SOURCES) {
      if (src.n - src.s < 3 && !PC.covers(src, { s: c.lat - .3, n: c.lat + .3, w: c.lng - .3, e: c.lng + .3 })) continue;
      const base = src.url + '?where=' + encodeURIComponent(where) + '&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=200&f=json';
      try {
        if (!/^HNO/.test(where)) {
          const env = JSON.stringify({ xmin: c.lng - .45, ymin: c.lat - .36, xmax: c.lng + .45, ymax: c.lat + .36, spatialReference: { wkid: 4326 } });
          found = PC.parseAddresses(await fetchText(base + '&geometry=' + encodeURIComponent(env) +
            '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects', null, 20000));
          if (found.length) break;
        }
        found = PC.parseAddresses(await fetchText(base, null, 20000));
        break;
      } catch (e) { why.push(src.name + ': ' + e.message); found = null; }
    }
    if (seq !== searchSeq || $('search').hidden) return;
    if (!found) { status.textContent = 'Couldn’t reach county addresses (' + why.join('; ') + '). Try again in a minute.'; return; }
    found.sort((a, b) => PC.meters(c.lat, c.lng, a.lat, a.lon) - PC.meters(c.lat, c.lng, b.lat, b.lon));
    const uniq = PC.addAllNew([], found).slice(0, 40);
    status.textContent = uniq.length ? '' : 'No county address matches “' + t + '”.';
    if (uniq.length) out.appendChild(el('div', 'day', 'County addresses'));
    for (const a of uniq) {
      const mi = PC.meters(c.lat, c.lng, a.lat, a.lon) / 1609.34;
      const row = el('button', 'row');
      const sq = el('div', 'badge square');
      sq.style.background = '#e0892f';
      const col = el('div', 'col');
      col.append(el('div', 't', a.number + ' ' + a.street),
        el('div', 'n', (a.city ? a.city + ' · ' : '') + (mi < 0.1 ? 'on screen' : (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi away')));
      row.append(sq, col);
      row.onclick = () => {
        $('search').hidden = true;
        goTo(a.lat, a.lon);
        const near = nearestVisit(a.lat, a.lon, 12);
        if (near) openSheet({ visit: near });
        else openSheet({ lat: a.lat, lon: a.lon, address: a.number + ' ' + a.street, source: '✓ County 911 address' });
      };
      out.appendChild(row);
    }
  }

  // ================================================================ account / sharing screen
  $('syncBtn').onclick = () => { $('account').hidden = false; buildAccount(true); };
  $('accountClose').onclick = () => { $('account').hidden = true; };
  function buildAccount(force) {
    const body = $('accountBody');
    // Never wipe a sign-in form someone is typing into; status updates only refresh the signed-in view.
    if (!force && body.dataset.view === 'form' && Sync.configured && !Sync.session) return;
    body.innerHTML = '';
    body.dataset.view = '';
    if (!Sync.configured) {
      body.append(el('p', '', 'Sharing isn’t set up yet. Doors are saved on this phone only.'));
      return;
    }
    if (!Sync.session) {
      body.dataset.view = 'form';
      body.append(el('p', '', 'Sign in with the email and password from your crew lead. Doors you mark will show up on every crew phone — Android and iPhone — and theirs on yours.'));
      const email = el('input', 'field');
      email.type = 'email'; email.placeholder = 'Email'; email.autocomplete = 'username'; email.autocapitalize = 'off';
      email.name = 'email'; email.setAttribute('autocorrect', 'off'); email.spellcheck = false; email.enterKeyHint = 'next';
      email.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pw.focus(); } });
      const pw = el('input', 'field');
      pw.type = 'password'; pw.placeholder = 'Password'; pw.autocomplete = 'current-password';
      pw.name = 'password'; pw.enterKeyHint = 'go';
      const go = el('button', 'plain primary', 'Sign in');
      const msg = el('p', '', '');
      go.onclick = async () => {
        if (!email.value.trim() || !pw.value) { msg.textContent = 'Enter your email and password.'; return; }
        go.disabled = true; go.textContent = 'Signing in…';
        try {
          await Sync.signIn(email.value.trim(), pw.value);
          toast('Signed in — your doors are now shared.');
        } catch (e) {
          msg.textContent = /invalid login/i.test(e.message) ? 'That email and password didn’t match.' : e.message;
          go.disabled = false; go.textContent = 'Sign in';
        }
      };
      pw.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
      body.append(email, pw, go, msg);
      return;
    }
    const waiting = Sync.waiting();
    body.append(el('p', '', 'Signed in as ' + (Sync.session.email || 'crew member') + '.'));
    body.append(el('p', '', !navigator.onLine ? 'You’re offline. ' + (waiting ? waiting + ' door' + (waiting === 1 ? '' : 's') + ' will upload when you’re back online.' : 'Everything here is saved on the phone.')
      : Sync.lastError ? 'Last try didn’t work: ' + Sync.lastError
        : Sync.busy ? 'Syncing now…'
          : Sync.lastOk ? 'Up to date as of ' + fmtTime(Sync.lastOk) + '.' + (waiting ? ' ' + waiting + ' waiting to upload.' : '')
            : 'Connecting…'));
    const now = el('button', 'plain primary', 'Sync now');
    now.onclick = () => Sync.run();
    const out = el('button', 'plain', 'Sign out');
    out.onclick = () => dialog('Sign out?', waiting ? waiting + ' door' + (waiting === 1 ? ' hasn’t' : 's haven’t') + ' uploaded yet. They stay on this phone and upload when you sign back in.' : 'Your doors stay on this phone.',
      [{ label: 'Cancel' }, { label: 'Sign out', cls: 'danger', run: () => Sync.signOut() }]);
    body.append(now, out);
  }

  // ================================================================ your location
  let watchId = null;
  function startGps(center) {
    if (!navigator.geolocation) { toast('This browser can’t share your location.', true); return; }
    if (center) { following = true; $('locateBtn').classList.add('follow'); centerNext = true; }
    if (watchId !== null) {
      if (center && Overlay.gps) { centerNext = false; map.setView([Overlay.gps.lat, Overlay.gps.lon], Math.max(18, map.getZoom())); }
      return;
    }
    watchId = navigator.geolocation.watchPosition(pos => {
      lsSet('pc-gps-ok', true);
      const g = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 50 };
      Overlay.gps = g;
      if (centerNext) { centerNext = false; map.setView([g.lat, g.lon], Math.max(18, map.getZoom())); }
      else if (following) map.panTo([g.lat, g.lon], { animate: true });
      Overlay.redraw();
    }, err => {
      if (err.code === 1) {
        toast('Location is off for this app. You can still find houses by moving the map.', true);
        following = false; $('locateBtn').classList.remove('follow');
        navigator.geolocation.clearWatch(watchId); watchId = null;
      }
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  let centerNext = false;
  $('locateBtn').onclick = () => startGps(true);

  // ================================================================ buttons, install tip, start-up
  $('zoomIn').onclick = () => map.zoomIn(1);
  $('zoomOut').onclick = () => map.zoomOut(1);
  $('layerBtn').onclick = () => setLayer(layerName === 'STREET' ? 'SATELLITE' : 'STREET');
  $('hint').onclick = () => {
    if (/^Couldn’t reach county/.test($('hint').textContent) && Houses.lastError) {
      dialog('County address services', 'None of the county 911 address services answered, so house numbers can’t be filled in here yet. The app will try again in a minute.\n\n' + Houses.lastError);
    }
  };

  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS && !standalone && !lsGet('pc-install-dismissed', false)) $('installTip').hidden = false;
  $('installClose').onclick = () => { $('installTip').hidden = true; lsSet('pc-install-dismissed', true); };

  async function start() {
    Overlay.init();
    setLayer(layerName);
    const ok = await Store.open();
    if (!ok) toast('This browser won’t keep doors after you close it (private browsing?).', true);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    try { (await Store.all('visits')).forEach(v => byId.set(v.id, v)); } catch (e) { /* nothing saved yet */ }
    await Sync.load().catch(() => {});
    rebuild();
    updateHint();
    Sync.start();
    // Show where you are: right away if allowed before, or ask the first time.
    const firstRun = !lsGet('pc-started', false);
    lsSet('pc-started', true);
    let granted = lsGet('pc-gps-ok', false);
    try { if (navigator.permissions) granted = granted || (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch (e) { /* Safari < 16 */ }
    if (granted || firstRun) startGps(firstRun && !lsGet('pc-view', null));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  start();
})();
