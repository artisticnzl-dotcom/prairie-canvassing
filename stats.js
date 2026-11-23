/* Prairie Canvassing — interaction log and the Stats tab (day / week / month, by category). */
(function () {
  'use strict';
  const A = window.App, PC = window.PC;
  const { Store, Sync, el } = A;
  const $ = id => document.getElementById(id);
  const OUT = PC.OUT, OUTCOMES = PC.OUTCOMES;

  const log = new Map(); // id -> { id, visit_id, outcome, at, address, by_email, updated_at, deleted }
  const live = r => r && !r.deleted;
  let period = A.lsGet('pc-stats-period', 'day'); // day | week | month
  let offset = 0;                                   // 0 = this day/week/month, -1 = the one before …
  let who = A.lsGet('pc-stats-who', 'all');        // all | me

  Sync.addTable({ name: 'interactions', map: log, changed: () => { if (!$('statsPanel').hidden) show(); } });

  window.StatsInit = async () => {
    try { (await Store.all('interactions')).forEach(r => log.set(r.id, r)); } catch (e) { /* first run */ }
  };

  function myEmail() {
    return ((Sync.session && Sync.session.email) || A.lsGet('pc-last-email', '') || '').toLowerCase();
  }

  /** Called whenever a door gets an outcome (a new knock, not a note edit). */
  async function record(v) {
    const now = Date.now();
    const r = {
      id: A.uuid(), visit_id: v.id, outcome: v.outcome, at: v.visit_time || now, address: v.address || '',
      by_email: myEmail(), updated_at: now, deleted: false, dirty: true,
    };
    log.set(r.id, r);
    try { await Store.putRows('interactions', [r]); } catch (e) { /* kept in memory; next save retries */ }
    if (!$('statsPanel').hidden) show();
  }

  // ---------------------------------------------------------------- periods
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function range() {
    const now = new Date();
    let from, to, label;
    if (period === 'day') {
      from = startOfDay(now); from.setDate(from.getDate() + offset);
      to = new Date(from); to.setDate(to.getDate() + 1);
      label = offset === 0 ? 'Today' : offset === -1 ? 'Yesterday'
        : from.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    } else if (period === 'week') {
      from = startOfDay(now);
      from.setDate(from.getDate() - ((from.getDay() + 6) % 7) + offset * 7); // weeks start Monday
      to = new Date(from); to.setDate(to.getDate() + 7);
      const last = new Date(to); last.setDate(last.getDate() - 1);
      const f = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      label = (offset === 0 ? 'This week · ' : offset === -1 ? 'Last week · ' : '') + f(from) + ' – ' + f(last);
    } else {
      from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
      label = from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    return { from: from.getTime(), to: to.getTime(), fromDate: from, label };
  }

  function rows(r) {
    const me = myEmail();
    return [...log.values()].filter(x => live(x) && x.at >= r.from && x.at < r.to && OUT[x.outcome]
      && (who === 'all' || !me || (x.by_email || '').toLowerCase() === me));
  }

  function counts(list) {
    const c = {};
    OUTCOMES.forEach(o => { c[o.key] = 0; });
    list.forEach(x => { c[x.outcome] = (c[x.outcome] || 0) + 1; });
    return c;
  }

  // ---------------------------------------------------------------- screen
  function seg(options, value, onPick) {
    const box = el('div', 'seg');
    options.forEach(([k, label]) => {
      const b = el('button', value === k ? 'on' : '', label);
      b.onclick = () => onPick(k);
      box.appendChild(b);
    });
    return box;
  }

  function show() {
    const p = $('statsPanel');
    p.innerHTML = '';
    const top = el('div', 'stats-top');
    top.appendChild(seg([['day', 'Day'], ['week', 'Week'], ['month', 'Month']], period, k => {
      period = k; offset = 0; A.lsSet('pc-stats-period', k); show();
    }));
    top.appendChild(seg([['all', 'Whole crew'], ['me', 'Just me']], who, k => { who = k; A.lsSet('pc-stats-who', k); show(); }));
    p.appendChild(top);

    const r = range();
    const nav = el('div', 'stats-nav');
    const prev = el('button', 'plain', '‹');
    prev.setAttribute('aria-label', 'Earlier');
    prev.onclick = () => { offset--; show(); };
    const next = el('button', 'plain', '›');
    next.setAttribute('aria-label', 'Later');
    next.disabled = offset >= 0;
    next.onclick = () => { if (offset < 0) { offset++; show(); } };
    nav.append(prev, el('div', 'stats-label', r.label), next);
    p.appendChild(nav);

    const list = rows(r);
    const c = counts(list);
    const total = list.length;
    const doors = new Set(list.map(x => x.visit_id)).size;

    const sum = el('div', 'stats-sum');
    const tile = (n, label) => { const t = el('div', 'tile'); t.append(el('b', '', String(n)), el('span', '', label)); return t; };
    sum.append(tile(total, total === 1 ? 'interaction' : 'interactions'), tile(doors, doors === 1 ? 'door' : 'doors'),
      tile(doors ? Math.round(100 * c.BOOKED / doors) + '%' : '—', 'booked'));
    p.appendChild(sum);

    const cats = el('div', 'card stats-cats');
    cats.appendChild(el('h3', '', 'By category'));
    const max = Math.max(1, ...OUTCOMES.map(o => c[o.key]));
    OUTCOMES.forEach(o => {
      const row = el('div', 'catrow');
      const name = el('div', 'catname');
      const dot = el('i', 'dot');
      dot.style.background = o.color;
      name.append(dot, document.createTextNode(o.label));
      const bar = el('div', 'catbar');
      const fill = el('div', 'fill');
      fill.style.width = (100 * c[o.key] / max) + '%';
      fill.style.background = o.color;
      bar.appendChild(fill);
      row.append(name, bar, el('div', 'catn', String(c[o.key])));
      cats.appendChild(row);
    });
    if (!total) cats.appendChild(el('p', 'muted', 'Nothing logged in this ' + (period === 'day' ? 'day' : period) + '.'));
    p.appendChild(cats);

    // Breakdown: each knock for a day, each day for a week or month.
    const br = el('div', 'card');
    if (period === 'day') {
      br.appendChild(el('h3', '', 'Doors'));
      list.sort((a, b) => b.at - a.at).slice(0, 300).forEach(x => {
        const row = el('div', 'logrow');
        const o = OUT[x.outcome];
        const tag = el('span', 'tag', o.label);
        tag.style.background = o.color;
        row.append(el('span', 'when', A.fmtTime(x.at)), el('span', 'addr', x.address || 'Address not set'), tag);
        if (who === 'all' && x.by_email) row.appendChild(el('span', 'by', x.by_email.split('@')[0]));
        row.onclick = () => { const v = A.byId.get(x.visit_id); if (v && !v.deleted) { A.showTab('map'); A.goTo(v.lat, v.lon); } };
        br.appendChild(row);
      });
      if (!list.length) br.appendChild(el('p', 'muted', 'No doors yet.'));
    } else {
      br.appendChild(el('h3', '', 'By day'));
      const t = el('table', 'daytable');
      const head = el('tr');
      head.appendChild(el('th', '', ''));
      OUTCOMES.forEach(o => { const th = el('th', '', o.mark); th.style.color = o.color; th.title = o.label; head.appendChild(th); });
      head.appendChild(el('th', '', 'Total'));
      t.appendChild(head);
      const days = [];
      for (let d = new Date(r.fromDate); d.getTime() < r.to && d.getTime() <= Date.now(); d.setDate(d.getDate() + 1)) days.push(new Date(d));
      days.reverse().forEach(d => {
        const s = d.getTime(), e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const dl = list.filter(x => x.at >= s && x.at < e);
        if (period === 'month' && !dl.length) return;
        const dc = counts(dl);
        const tr = el('tr');
        tr.appendChild(el('td', 'dname', d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })));
        OUTCOMES.forEach(o => tr.appendChild(el('td', dc[o.key] ? '' : 'zero', String(dc[o.key]))));
        tr.appendChild(el('td', 'tot', String(dl.length)));
        tr.onclick = () => { period = 'day'; offset = Math.round((startOfDay(d) - startOfDay(new Date())) / 864e5); show(); };
        t.appendChild(tr);
      });
      br.appendChild(t);
      const key = el('p', 'muted small', OUTCOMES.map(o => o.mark + ' = ' + o.label).join(' · ') + '. Tap a day to see its doors.');
      br.appendChild(key);
      if (!list.length) br.appendChild(el('p', 'muted', 'No doors yet.'));
    }
    p.appendChild(br);

    if (who === 'all') {
      const people = new Map();
      list.forEach(x => { const k = x.by_email || 'Unknown'; people.set(k, (people.get(k) || 0) + 1); });
      if (people.size > 1) {
        const pc = el('div', 'card');
        pc.appendChild(el('h3', '', 'By person'));
        [...people.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
          const row = el('div', 'catrow');
          row.append(el('div', 'catname', k === 'Unknown' ? 'Earlier doors (before tracking)' : k.split('@')[0]), el('div', 'catbar'), el('div', 'catn', String(n)));
          pc.appendChild(row);
        });
        p.appendChild(pc);
      }
    }
    p.appendChild(el('p', 'muted small pad', 'Every time a door gets an outcome it counts as one interaction. Doors marked before Nov 23 count once, by their latest outcome.'));
  }

  window.Stats = { record, show, _log: log };
})();
