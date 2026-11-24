/* Prairie Canvassing — customers, pricing, signed agreements, inspections and reports (web / iPhone). */
(function () {
  'use strict';
  const A = window.App;
  const { Store, Sync, toast, dialog, el, uuid } = A;
  const T = window.PC_AGREEMENT;
  const $ = id => document.getElementById(id);

  const TERMINATIONS = ['Not recorded', 'Exterior wall', 'Roof', 'Soffit', 'Other or not located'];
  const ACCESS = ['Not assessed', 'Accessible', 'Partially accessible', 'Not accessible'];
  const CONDITION = ['Not assessed', 'No visible buildup', 'Light buildup', 'Moderate buildup', 'Heavy buildup', 'Obstruction or damage observed'];
  const CAMERA = ['Not performed', 'Completed on accessible sections', 'Limited view', 'Unable to inspect with camera'];
  const PHOTO_LABELS = ['Before', 'After', 'Camera view', 'Other finding'];
  const PHOTO_LIMIT = 12;
  const STATUS = { awaiting: 'Sent to sign — waiting for the customer', draft: 'Not signed yet', signed: 'Signed — ready to inspect', inspecting: 'Inspection in progress', completed: 'Completed', cancelled: 'Cancelled by customer' };
  const PAYMENT = { unpaid: 'Unpaid', partial: 'Partly paid', paid: 'Paid' };
  const METHODS = ['', 'Check', 'Card', 'ACH bank transfer', 'Cash', 'Other'];

  // ================================================================ data
  const customers = new Map(), jobs = new Map(), agreements = new Map(), settings = new Map();
  const live = c => c && !c.deleted;

  function refresh() {
    processSignedRequests();
    if (!$('customersPanel').hidden) showCustomers();
    if (currentPage && currentPage.refresh) currentPage.refresh();
  }
  Sync.addTable({ name: 'customers', map: customers, changed: refresh });
  Sync.addTable({ name: 'jobs', map: jobs, changed: refresh });
  Sync.addTable({ name: 'settings', map: settings, changed: refresh });
  Sync.addTable({ name: 'agreements', map: agreements, changed: refresh, insertOnly: true });
  // Agreements sent to customers to sign on their own phone. Once signed, the customer's signature always wins.
  const signRequests = new Map();
  Sync.addTable({ name: 'sign_requests', map: signRequests, changed: () => { processSignedRequests(); refresh(); },
    remoteWins: (local, v) => (v.status === 'signed' && (!local || local.status !== 'signed' || (!local.agreement_id && v.agreement_id))) || PC.remoteWins(local, v) });

  window.JobsInit = async () => {
    for (const [name, m] of [['customers', customers], ['jobs', jobs], ['agreements', agreements], ['settings', settings], ['sign_requests', signRequests]]) {
      try { (await Store.all(name)).forEach(r => m.set(r.id, r)); } catch (e) { /* first run */ }
    }
    processSignedRequests();
  };

  function business() {
    const s = settings.get('business');
    return Object.assign({}, PJ.DEFAULT_BUSINESS, s && s.value ? s.value : {});
  }
  function technician() { return A.lsGet('pc-tech', ''); }

  async function saveRow(table, map, row) {
    const old = map.get(row.id);
    row.updated_at = Math.max(Date.now(), old ? (old.updated_at || 0) + 1 : 0);
    row.dirty = true;
    if (row.deleted === undefined) row.deleted = false;
    map.set(row.id, row);
    await Store.putRows(table, [row]);
    Sync.soon();
    return row;
  }
  const saveCustomer = c => saveRow('customers', customers, c);
  const saveJob = j => saveRow('jobs', jobs, j);
  async function putFile(path, blob) {
    await Store.set('files', path, { blob, type: blob.type });
    await Sync.queueUpload(path);
  }

  function jobsFor(customerId) {
    return [...jobs.values()].filter(j => live(j) && j.customer_id === customerId)
      .sort((a, b) => (b.service_date || '').localeCompare(a.service_date || '') || b.updated_at - a.updated_at);
  }
  function agreementsFor(jobId) {
    return [...agreements.values()].filter(a => a.job_id === jobId).sort((a, b) => a.version - b.version);
  }
  function latestAgreement(job) {
    const list = agreementsFor(job.id);
    return list.length ? list[list.length - 1] : null;
  }
  function jobForDoor(doorId) {
    return [...jobs.values()].find(j => live(j) && j.door_id === doorId && j.status !== 'cancelled') || null;
  }
  const WINDOWS = ['Any time', 'Morning', 'Afternoon', 'Evening'];
  function jobWhen(j) {
    if (j.status === 'awaiting') return 'Waiting for the customer to sign · ' + PJ.longDate(j.service_date);
    const d = PJ.whenText(j.service_date, j.service_window);
    if (j.status === 'signed' && j.timing === 'scheduled') return 'Scheduled · ' + d;
    if (j.status === 'signed' && j.timing === 'now') return 'Signed — doing the work today · ' + d;
    return STATUS[j.status] + ' · ' + d;
  }
  /** The newest signed agreement's cancel deadline, or '' if none. */
  function cancelDeadline(j) {
    const list = agreementsFor(j.id);
    return list.length ? list[list.length - 1].cancel_by : '';
  }
  function serviceSummary(j) {
    return (j.services || []).map(s => s.name + ((s.qty || 1) > 1 ? ' ×' + s.qty : '')).join(', ') || 'No services yet';
  }

  // ================================================================ page framework (full screen, with back)
  let currentPage = null;
  function openPage(opts) {
    currentPage = opts;
    const p = $('page');
    p.innerHTML = '';
    const head = el('div', 'page-head');
    const back = el('button', 'page-back', '‹');
    back.setAttribute('aria-label', 'Back');
    back.onclick = () => (opts.back ? opts.back() : closePage());
    const titles = el('div', 'page-titles');
    titles.append(el('div', 'page-kicker', opts.kicker || 'Prairie Lint Patrol'), el('div', 'page-title', opts.title));
    head.append(back, titles);
    if (opts.steps) {
      const st = el('div', 'steps');
      opts.steps.list.forEach((name, i) => {
        const s = el('div', 'step' + (i < opts.steps.at ? ' done' : i === opts.steps.at ? ' on' : ''), (i + 1) + '. ' + name);
        st.appendChild(s);
      });
      head.appendChild(st);
    }
    const body = el('div', 'page-body');
    const foot = el('div', 'page-foot');
    p.append(head, body, foot);
    opts.render(body, foot);
    if (!foot.children.length) foot.remove();
    p.hidden = false;
    body.scrollTop = 0;
  }
  function closePage() {
    currentPage = null;
    $('page').hidden = true;
    $('page').innerHTML = '';
    refresh();
  }

  // ---- small form helpers
  function card(parent, title) {
    const c = el('div', 'card');
    if (title) c.appendChild(el('h3', '', title));
    parent.appendChild(c);
    return c;
  }
  function input(parent, label, value, opts) {
    opts = opts || {};
    const wrap = el('label', 'fld' + (opts.half ? ' half' : ''));
    wrap.appendChild(el('span', '', label + (opts.required ? ' *' : '')));
    const i = el(opts.multi ? 'textarea' : 'input', 'field');
    if (!opts.multi) i.type = opts.type || 'text';
    if (opts.multi) i.rows = opts.rows || 3;
    i.value = value == null ? '' : value;
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.auto) i.autocomplete = opts.auto;
    if (opts.mode) i.inputMode = opts.mode;
    if (opts.caps) i.autocapitalize = opts.caps;
    if (opts.max) i.maxLength = opts.max;
    if (opts.onInput) i.addEventListener('input', () => opts.onInput(i.value));
    wrap.appendChild(i);
    const err = el('div', 'err');
    wrap.appendChild(err);
    i.showError = m => { err.textContent = m || ''; i.classList.toggle('bad', !!m); if (m) i.focus(); };
    parent.appendChild(wrap);
    return i;
  }
  function select(parent, label, options, value, onChange) {
    const wrap = el('label', 'fld');
    wrap.appendChild(el('span', '', label));
    const s = el('select', 'field');
    options.forEach(o => { const op = el('option', '', o === '' ? 'Choose…' : o); op.value = o; s.appendChild(op); });
    s.value = options.indexOf(value) >= 0 ? value : options[0];
    s.onchange = () => onChange(s.value);
    wrap.appendChild(s);
    parent.appendChild(wrap);
    return s;
  }
  function button(label, cls, fn) { const b = el('button', 'plain' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; }
  function row(parent) { const r = el('div', 'btnrow'); parent.appendChild(r); return r; }
  const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

  // ================================================================ customers tab
  let customerQuery = '';
  function showCustomers() {
    const panel = $('customersPanel');
    const keepFocus = document.activeElement && document.activeElement.id === 'custSearch';
    panel.innerHTML = '';
    const top = el('div', 'cust-top');
    const q = el('input', 'field');
    q.id = 'custSearch';
    q.type = 'search';
    q.placeholder = 'Search name, address, phone or email';
    q.value = customerQuery;
    q.oninput = () => { customerQuery = q.value; showCustomers(); };
    const add = button('New customer', 'primary', () => startNew());
    top.append(q, add);
    panel.appendChild(top);
    const list = el('div', 'list');
    panel.appendChild(list);

    // Unfinished work first, so nothing gets lost
    const open = [...jobs.values()].filter(j => live(j) && ['awaiting', 'draft', 'signed', 'inspecting'].includes(j.status) && live(customers.get(j.customer_id)))
      .sort((a, b) => (a.status === 'draft') - (b.status === 'draft') || (a.service_date || '').localeCompare(b.service_date || '') || b.updated_at - a.updated_at);
    if (open.length && !customerQuery) {
      list.appendChild(el('div', 'day', 'Jobs in progress'));
      for (const j of open.slice(0, 10)) {
        const c = customers.get(j.customer_id);
        list.appendChild(listRow(PJ.fullName(c) || 'Unnamed customer', jobWhen(j), PJ.money(j.total_cents || PJ.totals(j.services, j.adjustments).total), () => continueJob(j)));
      }
    }
    const words = customerQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const all = [...customers.values()].filter(live).filter(c => {
      const hay = [c.first_name, c.last_name, c.street, c.city, c.phone, c.email].join(' ').toLowerCase();
      return words.every(w => hay.includes(w));
    }).sort((a, b) => (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name));
    list.appendChild(el('div', 'day', customerQuery ? all.length + ' match' + (all.length === 1 ? '' : 'es') : 'Customers (' + all.length + ')'));
    for (const c of all.slice(0, 300)) {
      const js = jobsFor(c.id);
      const last = js[0];
      list.appendChild(listRow(PJ.fullName(c) || 'Unnamed customer', [c.street, c.city].filter(Boolean).join(', '),
        last ? PJ.longDate(last.service_date) + ' · ' + (PAYMENT[last.payment_status] || '') : 'No jobs yet', () => openCustomer(c.id)));
    }
    if (!all.length && !open.length) {
      const e = el('div', 'empty');
      e.append(el('h3', '', customerQuery ? 'No matches' : 'No customers yet'),
        el('p', '', customerQuery ? 'Try part of a name, street or phone number.' : 'Tap “New customer”, or tap a house on the map and choose “Start job”.'));
      list.appendChild(e);
    }
    const foot = el('div', 'cust-foot');
    foot.appendChild(button('Business & technician settings', '', openSettings));
    list.appendChild(foot);
    if (keepFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }
  function listRow(title, sub, extra, onTap) {
    const r = el('button', 'row');
    const col = el('div', 'col');
    col.append(el('div', 't', title), el('div', 'n', sub || ''));
    if (extra) col.appendChild(el('div', 's muted-s', extra));
    r.append(col, el('div', 'chev', '›'));
    r.onclick = onTap;
    return r;
  }

  // ================================================================ starting a job
  function newJob(customer, doorId) {
    const b = business();
    return {
      id: uuid(), customer_id: customer.id, door_id: doorId || null, service_date: PJ.ymd(new Date()), status: 'draft',
      services: b.services.filter(s => s.default).map(s => ({ name: s.name, description: s.description, qty: 1, price_cents: s.price_cents })),
      adjustments: [], total_cents: 0, payment_status: 'unpaid', payment_method: '', payment_note: '', technician: technician(),
      inspection: {}, photos: [], agreement_id: null, report_path: '', report_at: 0, deleted: false,
    };
  }
  function startNew(prefill) {
    const c = Object.assign({ id: uuid(), first_name: '', last_name: '', street: '', city: '', state: 'KS', zip: '', phone: '', email: '', notes: '', lat: null, lon: null, deleted: false }, prefill || {});
    const j = newJob(c, prefill && prefill._door);
    delete c._door;
    wizard(c, j, 0, true);
  }
  function startFromDoor(o) {
    const existing = o.visit ? jobForDoor(o.visit.id) : null;
    if (existing) { continueJob(existing); return; }
    const street = (o.address || '').trim();
    const same = street && [...customers.values()].find(c => live(c) && c.street.trim().toLowerCase() === street.toLowerCase());
    if (same) {
      dialog('Customer already saved', PJ.fullName(same) + ' at ' + same.street + ' is already a customer.', [
        { label: 'Cancel' },
        { label: 'New customer here', run: () => fromDoorNew(o, street) },
        { label: 'New job for ' + (same.first_name || 'them'), cls: 'primary', run: () => wizard(same, newJob(same, o.visit ? o.visit.id : null), 0, false) },
      ]);
      return;
    }
    fromDoorNew(o, street);
  }
  function fromDoorNew(o, street) {
    const place = A.houseCity(o.lat, o.lon) || {};
    startNew({ street, city: place.city || '', zip: place.zip || '', lat: o.lat, lon: o.lon, _door: o.visit ? o.visit.id : null });
  }
  function continueJob(j) {
    const c = customers.get(j.customer_id);
    if (!c) { toast('This job’s customer hasn’t synced to this phone yet.', true); return; }
    if (j.status === 'draft') wizard(c, j, j.services && j.services.length && c.first_name && j.timing ? 1 : 0, false);
    else if (j.status === 'awaiting') remoteSignPage(j.id);
    else if (j.status === 'signed' || j.status === 'inspecting') inspection(j.id);
    else openJob(j.id);
  }

  // ================================================================ the four steps before signing
  const STEPS = ['Customer', 'Services & price', 'Review', 'Sign'];
  function wizard(cust, job, step, isNewCustomer) {
    // Work on copies until saved, but save on every Next so nothing typed is lost.
    const c = Object.assign({}, cust);
    const j = JSON.parse(JSON.stringify(job));
    let saved = !isNewCustomer || customers.has(c.id);
    const persist = async () => {
      j.total_cents = PJ.totals(j.services, j.adjustments).total;
      await saveCustomer(Object.assign({}, c));
      await saveJob(Object.assign({}, j));
      saved = true;
    };
    const leave = () => {
      if (!saved && !(c.first_name || c.last_name || c.street)) { closePage(); return; }
      persist().then(() => { toast('Saved. Find it under Customers → Jobs in progress.'); closePage(); });
    };
    const go = n => {
      step = n;
      [stepCustomer, stepServices, stepReview, stepSign][n]();
    };

    function stepCustomer() {
      openPage({
        title: isNewCustomer ? 'New job' : (PJ.fullName(c) || 'New job'), kicker: 'Step 1 of 4', steps: { list: STEPS, at: 0 }, back: leave,
        render(body, foot) {
          const k = card(body, 'Customer');
          const f = input(k, 'First name', c.first_name, { required: true, auto: 'given-name', caps: 'words', max: 80, half: true, onInput: v => { c.first_name = v; } });
          const l = input(k, 'Last name', c.last_name, { required: true, auto: 'family-name', caps: 'words', max: 80, half: true, onInput: v => { c.last_name = v; } });
          const ph = input(k, 'Phone', c.phone, { type: 'tel', auto: 'tel', mode: 'tel', max: 30, half: true, onInput: v => { c.phone = v; } });
          const em = input(k, 'Email (for their copies)', c.email, { type: 'email', auto: 'email', caps: 'off', max: 200, half: true, onInput: v => { c.email = v.trim(); } });
          const a = card(body, 'Service address');
          const st = input(a, 'Street', c.street, { required: true, auto: 'address-line1', caps: 'words', max: 160, onInput: v => { c.street = v; } });
          const ci = input(a, 'City', c.city, { required: true, auto: 'address-level2', caps: 'words', max: 80, half: true, onInput: v => { c.city = v; } });
          input(a, 'State', c.state, { max: 2, caps: 'characters', half: true, onInput: v => { c.state = v.toUpperCase(); } }).classList.add('short');
          const zp = input(a, 'ZIP', c.zip, { mode: 'numeric', max: 10, half: true, onInput: v => { c.zip = v; } });
          const today = PJ.ymd(new Date());
          const requestedOn = !!business().requested_visits;
          if (!requestedOn) j.origin = 'door';
          if (!j.request) j.request = {};
          const firstDate = () => PJ.isRequested(j) ? today : PJ.firstScheduleDate(today);
          const choiceGroup = (parent, opts, isOn, onPick) => {
            const box = el('div', 'timing');
            const btns = opts.map(([key, title, sub]) => {
              const b = el('button', 'plain choice', '');
              b.type = 'button';
              b.append(el('b', '', title), el('span', '', sub));
              b.onclick = () => onPick(key);
              box.appendChild(b);
              return [key, b];
            });
            parent.appendChild(box);
            return () => btns.forEach(([key, b]) => b.classList.toggle('on', isOn(key)));
          };
          // ---- how the job started (only when the owner turned on customer-requested visits)
          if (requestedOn) {
            const o = card(body, 'How did this job start?');
            o.appendChild(el('p', 'tip', 'This decides whether the customer gets the 3-day right to cancel.'));
            const styleOrigin = choiceGroup(o, [
              ['door', 'We knocked or met them', 'They get the 3-day right to cancel.'],
              ['customer_request', 'They contacted us and asked us to come', 'Only for the service they asked for. No 3-day right for that visit.'],
            ], key => j.origin === key, key => { j.origin = key; drawOrigin(); drawTiming(); });
            const how = el('div', '');
            o.appendChild(how);
            var drawOrigin = () => {
              styleOrigin();
              how.innerHTML = '';
              if (!PJ.isRequested(j)) return;
              if (!j.request.date) j.request.date = today;
              const rd = input(how, 'Date they contacted us', j.request.date, { type: 'date', onInput: v => { j.request.date = v; } });
              rd.max = today;
              how.reqDate = rd;
              select(how, 'How they contacted us', [''].concat(PJ.REQUEST_METHODS), j.request.method || '', v => { j.request.method = v; });
              how.appendChild(el('p', 'tip warn', 'Only the service they asked for goes on this job. If you sell anything extra during the visit, start a separate job for it: extra sales keep the 3-day right to cancel.'));
            };
            drawOrigin();
            var originCheck = () => {
              if (j.origin !== 'door' && j.origin !== 'customer_request') { toast('Choose how this job started.', true); return false; }
              if (!PJ.isRequested(j)) return true;
              if (!PJ.parseYmd(j.request.date) || j.request.date > today) { how.reqDate.showError('Enter the date they contacted you.'); return false; }
              if (!j.request.method) { toast('Choose how the customer contacted you.', true); return false; }
              return true;
            };
          }
          // ---- when the work happens
          const d = card(body, 'When will the work be done?');
          const tip = el('p', 'tip', '');
          d.appendChild(tip);
          const choiceBox = el('div', '');
          const when = el('div', '');
          d.append(choiceBox, when);
          let dateField = null, timeField = null;
          const drawTiming = () => {
            const req = PJ.isRequested(j);
            tip.textContent = req ? 'Ask the customer which they prefer.'
              : 'Ask the customer which they prefer. They can cancel until midnight of ' + PJ.longDate(PJ.cancelBy(today)) + ' either way.';
            choiceBox.innerHTML = '';
            const style = choiceGroup(choiceBox, req
              ? [['now', 'Today', 'Do the work now.'], ['scheduled', 'Schedule a date', 'Any day that works for them.']]
              : [['now', 'Today — only if they asked us to come out', 'They contacted you before you knocked, or booked on their own after.'],
                 ['scheduled', 'Schedule after the cancel period', 'First open day: ' + PJ.longDate(PJ.firstScheduleDate(today)) + '.']],
              key => j.timing === key, key => { j.timing = key; drawWhen(); });
            drawWhen = () => {
              style();
              when.innerHTML = '';
              dateField = null; timeField = null;
              if (j.timing === 'now') { j.service_date = today; j.service_window = ''; }
              if (j.timing === 'now' && !PJ.isRequested(j)) {
                when.appendChild(el('p', 'tip', 'Why can the work be done today?'));
                const styleWhy = choiceGroup(when, PJ.TODAY_REASONS.map(([k, t]) => [k, t, '']),
                  key => j.request.reason === key, key => { j.request.reason = key; styleWhy(); });
                styleWhy();
                if (!j.request.date) j.request.date = today;
                const rd = input(when, 'Date they contacted us', j.request.date, { type: 'date', onInput: v => { j.request.date = v; } });
                rd.max = today;
                when.reqDate = rd;
                select(when, 'How they contacted us', [''].concat(PJ.TODAY_METHODS), PJ.TODAY_METHODS.indexOf(j.request.method) >= 0 ? j.request.method : '', v => { j.request.method = v; });
                when.appendChild(el('p', 'tip warn', 'If you knocked and they did not contact you on their own, choose “Schedule after the cancel period”.'));
              }
              if (j.timing !== 'scheduled') return;
              const first = firstDate();
              if (!(j.service_date >= first)) j.service_date = first;
              dateField = input(when, 'Scheduled date', j.service_date, { type: 'date', onInput: v => { j.service_date = v; showLoad(); } });
              dateField.min = first;
              const load = el('p', 'tip', '');
              when.appendChild(load);
              const showLoad = () => {
                const n = [...jobs.values()].filter(x => live(x) && x.id !== j.id && x.service_date === j.service_date && ['signed', 'inspecting'].includes(x.status)).length;
                load.textContent = !PJ.parseYmd(j.service_date) ? '' : n ? 'The crew already has ' + n + (n === 1 ? ' job' : ' jobs') + ' that day.' : 'No other crew jobs that day yet.';
              };
              showLoad();
              if (!PJ.isClockTime(j.service_window)) j.service_window = '';   // older jobs used Morning/Afternoon
              timeField = input(when, 'Appointment time', PJ.to24h(j.service_window), { type: 'time', onInput: v => { j.service_window = PJ.to12h(v); if (timeField) timeField.showError(''); } });
              timeField.step = 900;
              const url = business().booking_url;
              if (url) {
                const a = el('a', 'plain', 'Check open dates on the website');
                a.href = url; a.target = '_blank'; a.rel = 'noopener';
                when.appendChild(a);
              }
            };
            drawWhen();
          };
          let drawWhen = () => {};
          drawTiming();
          input(d, 'Notes about this customer (optional)', c.notes, { multi: true, rows: 2, max: 2000, onInput: v => { c.notes = v; } });
          foot.appendChild(button('Next: services & price', 'primary big', () => {
            if (!c.first_name.trim()) return f.showError('Enter the first name.');
            if (!c.last_name.trim()) return l.showError('Enter the last name.');
            if (c.email && !validEmail(c.email)) return em.showError('Check this email address.');
            if (!c.street.trim()) return st.showError('Enter the street address.');
            if (!c.city.trim()) return ci.showError('Enter the city.');
            if (c.zip && !/^\d{5}(-\d{4})?$/.test(c.zip.trim())) return zp.showError('ZIP should be 5 digits.');
            if (!c.phone.trim() && !c.email.trim()) return ph.showError('Add a phone number or email so you can reach them.');
            if (requestedOn && !originCheck()) return;
            if (j.timing !== 'now' && j.timing !== 'scheduled') { toast('Choose when the work will be done.', true); return; }
            if (j.timing === 'now' && !PJ.isRequested(j)) {
              if (!todayReasonOk(j)) {
                if (!j.request.reason) { toast('Choose why the work can be done today.', true); return; }
                if (!PJ.parseYmd(j.request.date) || j.request.date > today) return when.reqDate.showError('Enter the date they contacted you.');
                toast('Choose how they contacted you.', true); return;
              }
            }
            if (j.timing === 'scheduled' && !(PJ.parseYmd(j.service_date) && j.service_date >= firstDate())) return dateField.showError('Pick a date on or after ' + PJ.longDate(firstDate()) + '.');
            if (j.timing === 'scheduled' && !PJ.isClockTime(j.service_window)) return timeField.showError('Pick the appointment time.');
            persist().then(() => go(1));
          }));
        },
      });
    }

    function stepServices() {
      openPage({
        title: PJ.fullName(c), kicker: 'Step 2 of 4', steps: { list: STEPS, at: 1 }, back: () => persist().then(() => go(0)),
        render(body, foot) {
          const totalBox = el('div', 'total-bar');
          const updateTotal = () => {
            const t = PJ.totals(j.services, j.adjustments);
            totalBox.innerHTML = '';
            totalBox.append(el('span', '', (j.adjustments.length ? 'Subtotal ' + PJ.money(t.subtotal) + ' · ' : '') + 'Total'), el('b', '', PJ.money(t.total)));
          };
          const k = card(body, 'Services');
          if (addOnJobs.has(j.id)) k.appendChild(el('p', 'tip warn', 'Add the extra work the customer approved (tick a service or use “Add a custom service”). The work already agreed stays on the list. The customer signs an updated agreement for the new total, with a new 3-day right to cancel.'));
          k.appendChild(el('p', 'tip', 'Tick the work you’ll do. Every price can be changed for this job.'));
          const catalog = business().services;
          const listBox = el('div', '');
          k.appendChild(listBox);
          const draw = () => {
            listBox.innerHTML = '';
            // catalog services (on/off) plus any custom ones on this job
            const names = catalog.map(s => s.name);
            const rows = catalog.map(s => ({ cat: s, item: j.services.find(x => x.name === s.name) }))
              .concat(j.services.filter(x => names.indexOf(x.name) < 0).map(x => ({ cat: null, item: x })));
            for (const r of rows) {
              const box = el('div', 'svc' + (r.item ? ' on' : ''));
              const top = el('label', 'svc-top');
              const cb = el('input');
              cb.type = 'checkbox';
              cb.checked = !!r.item;
              cb.onchange = () => {
                if (cb.checked) j.services.push({ name: r.cat.name, description: r.cat.description, qty: 1, price_cents: r.cat.price_cents });
                else j.services = j.services.filter(x => x !== r.item);
                draw(); updateTotal();
              };
              top.append(cb, el('span', 'svc-name', r.item ? r.item.name : r.cat.name), el('span', 'svc-price', PJ.money(r.item ? PJ.lineCents(r.item) : r.cat.price_cents)));
              box.appendChild(top);
              if (r.item) {
                const it = r.item;
                const line = el('div', 'svc-edit');
                if (!r.cat) input(line, 'Service name', it.name, { max: 120, onInput: v => { it.name = v; } });
                const price = input(line, 'Price each ($)', (it.price_cents / 100).toFixed(2), { mode: 'decimal', half: true, max: 12,
                  onInput: v => { const p = PJ.parseMoney(v); price.showError(p === null || p < 0 ? 'Enter a price like 149 or 149.50' : ''); if (p !== null && p >= 0) { it.price_cents = p; box.querySelector('.svc-price').textContent = PJ.money(PJ.lineCents(it)); updateTotal(); } } });
                const qty = el('div', 'qty');
                const minus = el('button', 'plain', '−'), plus = el('button', 'plain', '+'), n = el('span', '', String(it.qty || 1));
                minus.onclick = () => { it.qty = Math.max(1, (it.qty || 1) - 1); n.textContent = it.qty; box.querySelector('.svc-price').textContent = PJ.money(PJ.lineCents(it)); updateTotal(); };
                plus.onclick = () => { it.qty = Math.min(20, (it.qty || 1) + 1); n.textContent = it.qty; box.querySelector('.svc-price').textContent = PJ.money(PJ.lineCents(it)); updateTotal(); };
                qty.append(el('span', 'qlabel', 'Quantity'), minus, n, plus);
                line.appendChild(qty);
                input(line, 'Description on the agreement', it.description, { multi: true, rows: 2, max: 600, onInput: v => { it.description = v; } });
                if (!r.cat) line.appendChild(button('Remove this service', 'danger', () => { j.services = j.services.filter(x => x !== it); draw(); updateTotal(); }));
                box.appendChild(line);
              }
              listBox.appendChild(box);
            }
          };
          draw();
          k.appendChild(button('+ Add a custom service', '', () => {
            j.services.push({ name: 'Custom service', description: '', qty: 1, price_cents: 0, custom: true });
            draw(); updateTotal();
          }));
          const adj = card(body, 'Discounts & adjustments');
          adj.appendChild(el('p', 'tip', 'Use a minus sign for a discount (for example −10). Leave empty if none.'));
          const adjBox = el('div', '');
          adj.appendChild(adjBox);
          const drawAdj = () => {
            adjBox.innerHTML = '';
            j.adjustments.forEach(a => {
              const r = el('div', 'adj');
              input(r, 'Label', a.label, { half: true, max: 80, onInput: v => { a.label = v; } });
              const amt = input(r, 'Amount ($)', (a.amount_cents / 100).toFixed(2), { half: true, mode: 'text', max: 12,
                onInput: v => { const p = PJ.parseMoney(v); amt.showError(p === null ? 'Enter an amount like -10 or 25' : ''); if (p !== null) { a.amount_cents = p; updateTotal(); } } });
              r.appendChild(button('Remove', 'danger', () => { j.adjustments = j.adjustments.filter(x => x !== a); drawAdj(); updateTotal(); }));
              adjBox.appendChild(r);
            });
          };
          drawAdj();
          adj.appendChild(button('+ Add discount or adjustment', '', () => { j.adjustments.push({ label: 'Discount', amount_cents: -1000 }); drawAdj(); updateTotal(); }));
          updateTotal();
          foot.appendChild(totalBox);
          foot.appendChild(button('Next: review agreement', 'primary big', () => {
            j.services = j.services.filter(s => (s.name || '').trim());
            if (!j.services.length) { toast('Choose at least one service.', true); return; }
            if (j.services.some(s => s.price_cents < 0)) { toast('Prices can’t be negative. Use an adjustment for discounts.', true); return; }
            persist().then(() => go(2));
          }));
        },
      });
    }

    let oral = false, ack = false, timingOk = false, requestOk = false;
    function stepReview() {
      oral = ack = timingOk = requestOk = false;
      const version = agreementsFor(j.id).length + 1;
      const r = PJ.renderAgreement(ctxFor(c, j, version, PJ.ymd(new Date())));
      openPage({
        title: 'Review the agreement', kicker: 'Step 3 of 4 · show this screen to the customer', steps: { list: STEPS, at: 2 }, back: () => go(1),
        render(body, foot) {
          const doc = el('div', 'doc');
          renderDocHtml(doc, r.text, T.right_to_cancel);
          body.appendChild(doc);
          if (r.notice.length) {
            const n = el('div', 'doc notice');
            r.notice.forEach((line, i) => n.appendChild(el(i === 0 ? 'h4' : 'p', '', line)));
            n.appendChild(el('p', 'small', 'The customer gets two copies of this notice with the signed agreement.'));
            body.appendChild(n);
          }
          const R = r.requested ? T.requested : null;
          const k = card(body, 'Before signing');
          const tick = (text, val, set) => {
            const l = el('label', 'tick');
            const cb = el('input'); cb.type = 'checkbox'; cb.checked = val;
            cb.onchange = () => set(cb.checked);
            l.append(cb, el('span', '', text));
            k.appendChild(l);
          };
          tick(R ? PJ.fill(R.technician_tick, r.vars) : 'Technician: ' + T.technician_oral_notice, oral, v => { oral = v; });
          tick('Customer: I have read the whole agreement and the total price of ' + PJ.money(r.total_cents) + '.', ack, v => { ack = v; });
          if (R) tick(PJ.fill(R.customer_tick, r.vars), requestOk, v => { requestOk = v; });
          if (T.timing && (j.timing === 'now' || j.timing === 'scheduled')) tick(PJ.fill((R || T.timing)[j.timing + '_customer_tick'], r.vars), timingOk, v => { timingOk = v; });
          const tb = el('div', 'total-bar');
          tb.append(el('span', '', 'Total to be agreed'), el('b', '', PJ.money(r.total_cents)));
          foot.appendChild(tb);
          foot.appendChild(button('Next: customer signs', 'primary big', () => {
            if (!oral) { toast(R ? 'Confirm the customer asked for this visit, then tick the box.' : 'Tell the customer about their 3-day right to cancel, then tick the box.', true); return; }
            if (!ack) { toast('The customer needs to confirm they read the agreement.', true); return; }
            if (R && !requestOk) { toast('The customer needs to confirm they asked for this visit.', true); return; }
            if (T.timing && (j.timing === 'now' || j.timing === 'scheduled') && !timingOk) { toast('The customer needs to confirm when the work will be done.', true); return; }
            go(3);
          }));
          if (j.timing === 'scheduled' && !R) {
            foot.appendChild(button('Send to the customer to sign on their phone', 'big', async () => {
              if (!oral) { toast('Tell the customer about their 3-day right to cancel (at the door or by phone), then tick the first box.', true); return; }
              if (!c.phone && !c.email) { toast('Add the customer’s phone or email in step 1 so you can send the link.', true); return; }
              try { await persist(); await sendForSigning(c, j); } catch (e) { dialog('Couldn’t send the agreement', (e.message || e)); }
            }));
          }
        },
      });
    }

    function stepSign() {
      openPage({
        title: 'Customer signature', kicker: 'Step 4 of 4', steps: { list: STEPS, at: 3 }, back: () => go(2),
        render(body, foot) {
          const tot = PJ.totals(j.services, j.adjustments).total;
          const k = card(body);
          k.appendChild(el('p', 'sign-lead', 'By signing, ' + (PJ.fullName(c) || 'the customer') + ' agrees to the work and the total price of ' + PJ.money(tot) + '.'));
          if (!PJ.isRequested(j)) k.appendChild(el('p', 'rtc', T.right_to_cancel));
          const name = input(k, 'Printed name', PJ.fullName(c), { required: true, max: 120, caps: 'words' });
          const pad = signaturePad();
          k.appendChild(pad.el);
          const r = row(k);
          r.appendChild(button('Clear signature', '', () => pad.clear()));
          const go2 = button('Sign agreement — ' + PJ.money(tot), 'primary big', async () => {
            if (!name.value.trim()) return name.showError('Enter the printed name.');
            if (pad.empty()) { toast('Please sign in the box with a finger or stylus.', true); return; }
            go2.disabled = true;
            go2.textContent = 'Saving signed agreement…';
            try {
              await persist();
              await signAgreement(c, j, name.value.trim(), pad.png());
            } catch (e) {
              console.error(e);
              go2.disabled = false;
              go2.textContent = 'Sign agreement — ' + PJ.money(tot);
              dialog('Couldn’t save the agreement', 'Nothing was signed yet. Please try again.\n\n' + (e.message || e));
            }
          });
          foot.appendChild(go2);
        },
      });
    }

    if (isNewCustomer) saved = false;
    if (step > 0 && j.timing !== 'now' && j.timing !== 'scheduled') step = 0;
    if (step > 0 && j.timing === 'now' && !PJ.isRequested(j) && !todayReasonOk(j)) step = 0;   // work today needs the customer's request
    if (step > 0 && business().requested_visits && j.origin !== 'door' && j.origin !== 'customer_request') step = 0;   // when the work happens is chosen in step 1
    go(step);
  }

  function ctxFor(c, j, version, txDate) {
    return { template: T, business: business(), customer: c, job: j, version, agreement_no: PJ.agreementNo(j.id, txDate),
      transaction_date: txDate, technician: j.technician || technician() };
  }

  /** Shows agreement text with headings and the bold right-to-cancel statement. */
  function renderDocHtml(box, text, rtc) {
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
      if (!ln.trim()) return;
      let node;
      if (i === 0) node = el('h2', '', ln);
      else if (ln === rtc) node = el('p', 'rtc', ln);
      else if (/^[0-9]+\. [A-Z]/.test(ln) && ln === ln.toUpperCase()) node = el('h4', '', ln);
      else if (/^(CUSTOMER|SERVICES|TOTAL PRICE)/.test(ln)) node = el('h4', '', ln);
      else node = el('p', /^ {2}/.test(ln) ? 'indent' : '', ln.trim());
      box.appendChild(node);
    });
  }

  // ================================================================ signature pad
  function signaturePad() {
    const wrap = el('div', 'sigwrap');
    const canvas = el('canvas', 'sig');
    const line = el('div', 'sigline', '✕  Sign here');
    wrap.append(canvas, line);
    const ctx = canvas.getContext('2d');
    let strokes = [], cur = null, scale = 1;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * scale);
      canvas.height = Math.round(r.height * scale);
      redraw();
    };
    const redraw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.strokeStyle = '#0c2238';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of strokes) drawStroke(s);
    };
    const drawStroke = s => {
      if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x, s[0].y, 1.4, 0, 7); ctx.fillStyle = '#0c2238'; ctx.fill(); return; }
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length - 1; i++) {
        const mx = (s[i].x + s[i + 1].x) / 2, my = (s[i].y + s[i + 1].y) / 2;
        ctx.quadraticCurveTo(s[i].x, s[i].y, mx, my);
      }
      ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y);
      ctx.stroke();
    };
    const pt = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); cur = [pt(e)]; strokes.push(cur); redraw(); line.classList.add('signed'); });
    canvas.addEventListener('pointermove', e => {
      if (!cur) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      evs.forEach(x => cur.push(pt(x)));
      redraw();
    });
    const end = () => { cur = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.style.touchAction = 'none';
    setTimeout(size, 0);
    window.addEventListener('resize', () => setTimeout(size, 50));
    return {
      el: wrap,
      clear() { strokes = []; redraw(); line.classList.remove('signed'); },
      empty() { return !strokes.some(s => s.length > 2) && strokes.length < 2; },
      png() {
        // crop to the ink with a small margin, on white
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        strokes.forEach(s => s.forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }));
        const m = 10, w = Math.max(40, x1 - x0 + 2 * m), h = Math.max(30, y1 - y0 + 2 * m), k = 2;
        const out = document.createElement('canvas');
        out.width = Math.round(w * k); out.height = Math.round(h * k);
        const o = out.getContext('2d');
        o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
        o.setTransform(k, 0, 0, k, -(x0 - m) * k, -(y0 - m) * k);
        o.strokeStyle = '#0c2238'; o.lineCap = 'round'; o.lineJoin = 'round';
        const save = ctx; // reuse drawing logic on the export canvas
        strokes.forEach(s => {
          if (s.length === 1) { o.beginPath(); o.arc(s[0].x, s[0].y, 1.4, 0, 7); o.fillStyle = '#0c2238'; o.fill(); return; }
          o.lineWidth = 2.6; o.beginPath(); o.moveTo(s[0].x, s[0].y);
          for (let i = 1; i < s.length - 1; i++) o.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
          o.lineTo(s[s.length - 1].x, s[s.length - 1].y); o.stroke();
        });
        void save;
        return out.toDataURL('image/png');
      },
    };
  }

  // ================================================================ signing → PDF → saved
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function dataUrlToBlob(u) {
    const [head, b64] = u.split(',');
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: /:(.*?);/.exec(head)[1] });
  }
  function blobToDataUrl(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); }); }
  let badgeData = null;
  // QR for the default Google review link (made from the link Google gives, with its tracking tags).
  const REVIEW_QR_FOR = 'https://g.page/r/CcnmULVFXxSkEBM/review';
  let qrData = null;
  async function reviewQr() {
    if (qrData) return qrData;
    try { qrData = await blobToDataUrl(await (await fetch('review-qr.png')).blob()); } catch (e) { qrData = null; }
    return qrData;
  }

  async function badge() {
    if (badgeData) return badgeData;
    try { badgeData = await blobToDataUrl(await (await fetch('badge.jpg')).blob()); } catch (e) { badgeData = null; }
    return badgeData;
  }

  async function signAgreement(c, j, signerName, sigPng) {
    const prior = agreementsFor(j.id);
    const version = (prior.length ? prior[prior.length - 1].version : 0) + 1;
    const tx = PJ.ymd(new Date());
    if (j.timing === 'now') { j.service_date = tx; j.service_window = ''; }
    const minDate = PJ.isRequested(j) ? tx : PJ.firstScheduleDate(tx);
    if (j.timing === 'scheduled' && !(j.service_date >= minDate))
      throw new Error('The scheduled date must be on or after ' + PJ.longDate(minDate) + '. Go back to step 1 and pick a new date.');
    if (j.timing === 'now' && !PJ.isRequested(j) && !todayReasonOk(j)) throw new Error('Work today is only for customers who asked you to come out. Go back to step 1 and choose why, or schedule it after the cancel period.');
    if (PJ.isRequested(j) && !business().requested_visits) throw new Error('Customer-requested visits are turned off in Settings. Go back to step 1 and choose how the job started.');
    const ctx = ctxFor(c, j, version, tx);
    const r = PJ.renderAgreement(ctx);
    const hash = await sha256(r.text);
    const signedAt = Date.now();
    const id = uuid();
    const sigPath = j.id + '/agreement-v' + version + '-signature.png';
    const pdfPath = j.id + '/agreement-v' + version + '.pdf';
    const doc = {
      template: T.template, agreement_no: ctx.agreement_no, transaction_date: tx, business: ctx.business,
      customer: { first_name: c.first_name, last_name: c.last_name, street: c.street, city: c.city, state: c.state, zip: c.zip, phone: c.phone, email: c.email },
      service_date: j.service_date, timing: j.timing || '', service_window: j.service_window || '',
      origin: j.origin || 'door', request: requestFor(j), services: j.services, adjustments: j.adjustments, technician: ctx.technician, notice: r.notice,
    };
    const a = { id, job_id: j.id, customer_id: c.id, version, document: doc, document_text: r.text, document_sha256: hash, total_cents: r.total_cents,
      signer_name: signerName, signed_at: signedAt, signed_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', cancel_by: r.cancel_by,
      signature_path: sigPath, pdf_path: pdfPath, device: (navigator.userAgent || '').slice(0, 160) };
    const pdf = await agreementPdf(a, sigPng);
    await putFile(sigPath, dataUrlToBlob(sigPng));
    await putFile(pdfPath, pdf);
    a.dirty = true;
    agreements.set(id, a);
    await Store.putRows('agreements', [a]);
    const job = Object.assign({}, jobs.get(j.id) || j, { status: 'signed', agreement_id: id, total_cents: r.total_cents, technician: ctx.technician,
      timing: j.timing || '', service_date: j.service_date, service_window: j.service_window || '',
      origin: j.origin || 'door', request: requestFor(j) });
    await saveJob(job);
    markDoor(job, c, 'BOOKED');
    Sync.soon();
    signedPage(job.id, id);
  }

  // ================================================================ remote signing (customer signs on their own phone)
  /** The last day the customer can sign and still have the 3-day cancel period end before the scheduled date. */
  function lastSignDate(serviceYmd) {
    const d = PJ.parseYmd(serviceYmd);
    for (let k = 1; k <= 40; k++) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - k);
      if (PJ.firstScheduleDate(PJ.ymd(t)) <= serviceYmd) return PJ.ymd(t);
    }
    return PJ.ymd(new Date());
  }
  function randomToken() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function signLink(sr) { return new URL('sign.html', location.href).href.split('?')[0] + '#t=' + sr.token; }
  function openSignRequest(jobId) {
    return [...signRequests.values()].filter(r => r.job_id === jobId && !r.deleted && r.status === 'sent').sort((a, b) => b.updated_at - a.updated_at)[0] || null;
  }
  async function sendForSigning(c, j) {
    const today = PJ.ymd(new Date());
    if (!(j.service_date >= PJ.firstScheduleDate(today))) throw new Error('The scheduled date must be on or after ' + PJ.longDate(PJ.firstScheduleDate(today)) + '. Go back to step 1 and pick a new date.');
    const signBy = lastSignDate(j.service_date);
    const version = agreementsFor(j.id).length ? agreementsFor(j.id)[agreementsFor(j.id).length - 1].version + 1 : 1;
    const old = openSignRequest(j.id);
    if (old) await saveRow('sign_requests', signRequests, Object.assign({}, old, { status: 'void' }));
    const by = PJ.parseYmd(signBy);
    const sr = {
      id: uuid(), token: randomToken(), job_id: j.id, customer_id: c.id, version, status: 'sent', sent_by: technician(),
      expires_at: new Date(by.getFullYear(), by.getMonth(), by.getDate(), 23, 59, 59).getTime(),
      payload: {
        template: T.template, version, business: business(), technician: j.technician || technician(), sign_by: signBy,
        customer: { first_name: c.first_name, last_name: c.last_name, street: c.street, city: c.city, state: c.state, zip: c.zip, phone: c.phone, email: c.email },
        job: { id: j.id, services: j.services, adjustments: j.adjustments, service_date: j.service_date, service_window: j.service_window || '', timing: 'scheduled', origin: 'door', request: {} },
      },
    };
    await saveRow('sign_requests', signRequests, sr);
    await saveJob(Object.assign({}, jobs.get(j.id) || j, { status: 'awaiting', timing: 'scheduled', origin: 'door', request: {},
      total_cents: PJ.totals(j.services, j.adjustments).total, technician: j.technician || technician() }));
    remoteSignPage(j.id, true);
  }
  function signMessage(c, j, sr) {
    return 'Hi ' + (c.first_name || 'there') + ', here is your ' + business().name + ' service agreement for ' + PJ.longDate(j.service_date) +
      '. Please review and sign it here: ' + signLink(sr) + '\n\nPlease sign by ' + PJ.longDate(sr.payload.sign_by) + '. Questions? Call or text ' + business().phone + '.';
  }
  function remoteSignPage(jobId, fresh) {
    const j = jobs.get(jobId);
    if (!j) return;
    const c = customers.get(j.customer_id);
    openPage({
      title: 'Waiting for signature', kicker: PJ.fullName(c), back: () => openCustomer(c.id), refresh: () => remoteSignPage(jobId),
      render(body, foot) {
        const cur = jobs.get(jobId);
        if (cur.status !== 'awaiting') { openJob(jobId); return; }
        const sr = openSignRequest(jobId);
        const k = card(body);
        if (!sr) {
          k.appendChild(el('p', '', 'The signing link isn’t on this device yet. Connect to the internet so it can sync.'));
          return;
        }
        k.appendChild(el('p', 'big', (fresh ? 'Now send the link. ' : '') + 'The customer signs on their own phone.'));
        k.appendChild(el('p', '', serviceSummary(cur) + ' · ' + PJ.money(cur.total_cents || PJ.totals(cur.services, cur.adjustments).total)));
        k.appendChild(el('p', '', 'Scheduled for ' + PJ.whenText(cur.service_date, cur.service_window) + '.'));
        k.appendChild(el('p', 'tip warn', 'They must sign by ' + PJ.longDate(sr.payload.sign_by) + ' so the 3-day cancel period ends before the visit. The link stops working after that.'));
        const msg = signMessage(c, cur, sr);
        const r = row(k);
        if (c.phone) {
          const a = el('a', 'plain', 'Text the link');
          a.href = 'sms:' + c.phone.replace(/[^\d+]/g, '') + (/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? '&' : '?') + 'body=' + encodeURIComponent(msg);
          r.appendChild(a);
        }
        if (c.email) {
          const a = el('a', 'plain', 'Email the link');
          a.href = 'mailto:' + encodeURIComponent(c.email) + '?subject=' + encodeURIComponent('Your ' + business().name + ' service agreement') + '&body=' + encodeURIComponent(msg);
          r.appendChild(a);
        }
        r.appendChild(button('Copy link', '', async () => {
          try { await navigator.clipboard.writeText(signLink(sr)); toast('Link copied.'); } catch (e) { dialog('Signing link', signLink(sr)); }
        }));
        // To text from the business number (Google Voice), share or copy the whole message and pick Google Voice.
        const gv = card(body, 'Text from your business number');
        gv.appendChild(el('p', 'tip', 'To send from Google Voice: tap “Share message” and pick Voice, or tap “Copy message”, open Google Voice, start a text to ' + (c.phone || 'the customer') + ', and paste.'));
        const r2 = row(gv);
        if (navigator.share) r2.appendChild(button('Share message', '', async () => {
          try { await navigator.share({ text: msg }); } catch (e) { /* closed */ }
        }));
        r2.appendChild(button('Copy message', '', async () => {
          try { await navigator.clipboard.writeText(msg); toast('Message copied. Paste it in Google Voice.'); } catch (e) { dialog('Message', msg); }
        }));
        body.appendChild(el('p', 'tip', 'When they sign, this job turns to “Scheduled” on every crew phone, and the signed agreement PDF is saved with the job. Their cancel period counts from the day they sign.'));
        const more = card(body, 'More');
        more.appendChild(button('Cancel the link and sign here instead', '', () => dialog('Cancel the signing link?',
          'The link stops working right away. If the customer already signed, their signature still counts.',
          [{ label: 'Keep the link' }, { label: 'Cancel the link', cls: 'primary', run: async () => {
            await saveRow('sign_requests', signRequests, Object.assign({}, sr, { status: 'void' }));
            const d = Object.assign({}, jobs.get(jobId), { status: 'draft' });
            await saveJob(d);
            wizard(c, d, 1, false);
          } }])));
        foot.appendChild(button('Done', 'primary big', () => { closePage(); A.showTab('customers'); }));
      },
    });
  }
  /** Turns a request the customer signed on their phone into a signed agreement (PDF + job), once, on any crew phone. */
  let processing = false;
  async function processSignedRequests() {
    if (processing) return;
    processing = true;
    try {
      for (const sr of [...signRequests.values()]) {
        if (sr.deleted || sr.status !== 'signed' || sr.agreement_id) continue;
        const j = jobs.get(sr.job_id), c = customers.get(sr.customer_id);
        if (!j || !c) continue;   // wait until they sync
        if (!agreements.has(sr.id)) {
          const p = sr.payload, tx = sr.transaction_date;
          const ctx = { template: T, business: p.business, customer: p.customer, job: p.job, version: sr.version,
            agreement_no: PJ.agreementNo(sr.job_id, tx), transaction_date: tx, technician: p.technician };
          const r = PJ.renderAgreement(ctx);
          const matches = (await sha256(sr.document_text)) === sr.document_sha256 && r.text === sr.document_text;
          const sigPath = sr.job_id + '/agreement-v' + sr.version + '-signature.png';
          const pdfPath = sr.job_id + '/agreement-v' + sr.version + '.pdf';
          const doc = {
            template: p.template, agreement_no: ctx.agreement_no, transaction_date: tx, business: p.business, customer: p.customer,
            service_date: p.job.service_date, timing: 'scheduled', service_window: p.job.service_window || '', origin: 'door', request: {},
            services: p.job.services, adjustments: p.job.adjustments, technician: p.technician, notice: r.notice,
            signed_remotely: true, sign_request_id: sr.id, text_matches_app: matches,
          };
          const a = { id: sr.id, job_id: sr.job_id, customer_id: sr.customer_id, version: sr.version, document: doc, document_text: sr.document_text,
            document_sha256: sr.document_sha256, total_cents: sr.total_cents, signer_name: sr.signer_name, signed_at: sr.signed_at, signed_tz: sr.signed_tz || '',
            cancel_by: sr.cancel_by, signature_path: sigPath, pdf_path: pdfPath, device: ('Signed on customer’s device: ' + (sr.device || '')).slice(0, 160) };
          const pdf = await agreementPdf(a, sr.signature);
          await putFile(sigPath, dataUrlToBlob(sr.signature));
          await putFile(pdfPath, pdf);
          a.dirty = true;
          agreements.set(a.id, a);
          await Store.putRows('agreements', [a]);
        }
        const cur = jobs.get(sr.job_id);
        if (cur.status === 'awaiting' || cur.status === 'draft') {
          const p = sr.payload;
          await saveJob(Object.assign({}, cur, { status: 'signed', agreement_id: sr.id, total_cents: sr.total_cents, technician: p.technician, timing: 'scheduled',
            service_date: p.job.service_date, service_window: p.job.service_window || '', origin: 'door', request: {}, services: p.job.services, adjustments: p.job.adjustments }));
          markDoor(jobs.get(sr.job_id), c, 'BOOKED');
          toast(PJ.fullName(c) + ' signed the agreement.');
        }
        await saveRow('sign_requests', signRequests, Object.assign({}, signRequests.get(sr.id), { agreement_id: sr.id }));
      }
    } catch (e) {
      console.error('remote signing', e);
    } finally {
      processing = false;
    }
  }

  /** Keeps the canvassing map in step: signed = Booked, report done = Completed. */
  function markDoor(job, c, outcome) {
    const addr = [c.street].filter(Boolean).join('');
    let v = job.door_id ? A.byId.get(job.door_id) : null;
    if (v && v.deleted) v = null;
    if (v) A.saveVisit(v, v.lat, v.lon, outcome, v.address || addr, v.note, false);
    else if (c.lat != null && c.lon != null) A.saveVisit(null, c.lat, c.lon, outcome, addr, PJ.fullName(c), false);
  }

  function signedPage(jobId, agreementId) {
    const a = agreements.get(agreementId);
    const j = jobs.get(jobId);
    const c = customers.get(j.customer_id);
    openPage({
      title: 'Agreement signed', kicker: PJ.fullName(c), back: () => openCustomer(c.id),
      render(body, foot) {
        const k = card(body);
        k.appendChild(el('div', 'bigcheck', '✓'));
        k.appendChild(el('h3', 'center', 'Signed and saved'));
        k.appendChild(el('p', 'center', a.document.agreement_no + ' · Version ' + a.version + ' · ' + PJ.money(a.total_cents)));
        k.appendChild(el('p', 'center muted', 'Signed by ' + a.signer_name + ' on ' + A.fmtDate(a.signed_at) + '. ' + (a.cancel_by
          ? 'The customer can cancel until midnight of ' + PJ.longDate(a.cancel_by) + '.' : 'Visit requested by the customer: no 3-day cancellation period.')));
        const r = row(k);
        r.appendChild(button('View PDF', '', () => viewFile(a.pdf_path, a.document.agreement_no + '.pdf')));
        r.appendChild(button('Send customer their copy', '', () => shareFile(a.pdf_path, 'Prairie Lint Patrol agreement ' + a.document.agreement_no + '.pdf', 'Your signed Prairie Lint Patrol service agreement', c)));
        body.appendChild(el('p', 'tip', a.cancel_by ? 'Give the customer their copy now (share, email, or text it). It includes the two Notice of Cancellation forms.'
          : 'Give the customer their copy now (share, email, or text it).'));
        if (j.timing === 'scheduled') {
          const s = card(body, 'Scheduled');
          s.appendChild(el('p', 'big', PJ.whenText(j.service_date, j.service_window)));
          s.appendChild(el('p', 'muted', 'The job is under Customers → Jobs in progress. Add it to your calendar or booking system too.'));
          foot.appendChild(button('Done', 'primary big', () => { closePage(); A.showTab('customers'); }));
        } else {
          const started = addOnJobs.has(jobId) || (j.photos || []).length || Object.keys(j.inspection || {}).length;
          addOnJobs.delete(jobId);
          foot.appendChild(button(started ? 'Continue inspection' : 'Begin inspection', 'primary big', () => inspection(jobId)));
        }
      },
    });
  }

  // ================================================================ PDFs (jsPDF)
  const PDF_INK = [12, 34, 56], PDF_ACCENT = [163, 59, 19], PDF_MUTED = [72, 90, 105], PDF_LINE = [218, 226, 231];
  function pdfDoc(footerLeft) {
    const { jsPDF } = window.jspdf;
    const d = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    const st = { d, y: 0, page: 0, logo: null, footerLeft };
    return st;
  }
  function pdfPage(st) {
    if (st.page > 0) st.d.addPage();
    st.page++;
    const d = st.d;
    d.setFillColor(...PDF_INK); d.rect(0, 0, 612, 8, 'F');
    if (st.logo) d.addImage(st.logo, 'JPEG', 46, 18, 56, 56);
    d.setFont('helvetica', 'bold'); d.setFontSize(16); d.setTextColor(...PDF_INK); d.text('Prairie Lint Patrol', 112, 44);
    d.setFontSize(8.5); d.setTextColor(...PDF_ACCENT); d.text('DRYER VENT SERVICE  •  CENTRAL KANSAS', 112, 60);
    d.setDrawColor(...PDF_LINE); d.setLineWidth(1); d.line(46, 84, 566, 84);
    st.y = 104;
  }
  function pdfFinish(st) {
    const d = st.d, n = d.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      d.setPage(i);
      d.setDrawColor(...PDF_LINE); d.line(46, 747, 566, 747);
      d.setFont('helvetica', 'normal'); d.setFontSize(8.5); d.setTextColor(...PDF_MUTED);
      d.text(st.footerLeft, 46, 764);
      d.text('Page ' + i + ' of ' + n, 566, 764, { align: 'right' });
    }
  }
  function pdfText(st, text, o) {
    o = o || {};
    const d = st.d, size = o.size || 10.5, lh = size * 1.32, x = o.x || 46, w = o.w || 520;
    d.setFont('helvetica', o.bold ? 'bold' : 'normal'); d.setFontSize(size); d.setTextColor(...(o.color || PDF_INK));
    const lines = d.splitTextToSize(String(text), w);
    for (const ln of lines) {
      if (st.y + lh > 735) pdfPage(st), d.setFont('helvetica', o.bold ? 'bold' : 'normal'), d.setFontSize(size), d.setTextColor(...(o.color || PDF_INK));
      d.text(ln, x, st.y + size);
      st.y += lh;
    }
    st.y += o.after == null ? 4 : o.after;
  }
  function pdfNeed(st, h) { if (st.y + h > 735) pdfPage(st); }

  async function agreementPdf(a, sigPng) {
    const doc = a.document;
    const st = pdfDoc('Agreement ' + doc.agreement_no + '  •  Version ' + a.version + '  •  SHA-256 ' + a.document_sha256.slice(0, 16));
    st.logo = await badge();
    pdfPage(st);
    const lines = a.document_text.split('\n');
    lines.forEach((ln, i) => {
      if (!ln.trim()) { st.y += 4; return; }
      if (i === 0) return pdfText(st, ln, { size: 15, bold: true, after: 6 });
      if (ln === T.right_to_cancel) return pdfText(st, ln, { size: 11, bold: true, after: 8 });
      if ((/^[0-9]+\. [A-Z]/.test(ln) && ln === ln.toUpperCase()) || /^(CUSTOMER|SERVICES|TOTAL PRICE)/.test(ln)) {
        pdfNeed(st, 40);
        return pdfText(st, ln, { size: 10.5, bold: true, color: /^TOTAL/.test(ln) ? PDF_INK : PDF_ACCENT, after: 2 });
      }
      if (/^ {2}/.test(ln)) return pdfText(st, ln.trim(), { size: 9.5, color: PDF_MUTED, x: 58, w: 508, after: 3 });
      pdfText(st, ln, { size: 10, after: 3 });
    });
    // signature block
    pdfNeed(st, 150);
    st.y += 6;
    const d = st.d;
    d.setDrawColor(...PDF_LINE); d.setFillColor(248, 249, 250); d.rect(46, st.y, 520, 128, 'FD');
    d.setFont('helvetica', 'bold'); d.setFontSize(9); d.setTextColor(...PDF_ACCENT); d.text('CUSTOMER SIGNATURE', 58, st.y + 16);
    const img = new Image();
    await new Promise(res => { img.onload = res; img.onerror = res; img.src = sigPng; });
    const maxW = 260, maxH = 70, k = Math.min(maxW / (img.width || 1), maxH / (img.height || 1), 1);
    d.addImage(sigPng, 'PNG', 58, st.y + 24, (img.width || 260) * k, (img.height || 70) * k);
    d.setDrawColor(...PDF_INK); d.line(58, st.y + 98, 330, st.y + 98);
    d.setFont('helvetica', 'normal'); d.setFontSize(9.5); d.setTextColor(...PDF_INK);
    d.text(a.signer_name, 58, st.y + 112);
    d.setFont('helvetica', 'bold'); d.setFontSize(9); d.setTextColor(...PDF_ACCENT); d.text('SIGNED', 350, st.y + 16);
    d.setFont('helvetica', 'normal'); d.setFontSize(9.5); d.setTextColor(...PDF_INK);
    d.text(d.splitTextToSize(A.fmtDate(a.signed_at) + (a.signed_tz ? ' (' + a.signed_tz + ')' : ''), 200), 350, st.y + 32);
    d.text('Total agreed: ' + PJ.money(a.total_cents), 350, st.y + 62);
    d.text(a.cancel_by ? 'Cancel by: midnight, ' + PJ.longDate(a.cancel_by) : 'Visit requested by the customer', 350, st.y + 78);
    st.y += 140;
    pdfText(st, 'Document fingerprint (SHA-256): ' + a.document_sha256, { size: 7.5, color: PDF_MUTED, after: 2 });
    pdfText(st, 'This record cannot be changed after signing. Any change requires a new signed version.', { size: 7.5, color: PDF_MUTED });
    // two copies of the Notice of Cancellation, each on its own page
    for (let copy = 1; copy <= ((doc.notice || []).length ? 2 : 0); copy++) {
      pdfPage(st);
      pdfText(st, 'Copy ' + copy + ' of 2  •  ' + (copy === 1 ? 'Keep this copy' : 'Use this copy to cancel'), { size: 9, color: PDF_MUTED, after: 10 });
      doc.notice.forEach((ln, i) => {
        if (i === 0) return pdfText(st, ln, { size: 16, bold: true, after: 8 });
        pdfText(st, ln, { size: 11, bold: true, after: 9 });
      });
      st.y += 34;
      const d2 = st.d;
      d2.setDrawColor(...PDF_INK); d2.line(46, st.y, 220, st.y); d2.line(260, st.y, 566, st.y);
      d2.setFont('helvetica', 'normal'); d2.setFontSize(9); d2.setTextColor(...PDF_MUTED);
      d2.text('(Date)', 46, st.y + 12); d2.text("(Buyer's signature)", 260, st.y + 12);
      st.y += 34;
      pdfText(st, 'Agreement ' + doc.agreement_no + ', version ' + a.version + ', with ' + [doc.customer.first_name, doc.customer.last_name].join(' ') + ', ' + doc.customer.street + '.', { size: 9, color: PDF_MUTED });
    }
    pdfFinish(st);
    return st.d.output('blob');
  }

  async function reportPdf(j) {
    const c = customers.get(j.customer_id);
    const a = j.agreement_id ? agreements.get(j.agreement_id) : latestAgreement(j);
    const b = business();
    const ins = j.inspection || {};
    const st = pdfDoc(b.phone + '   •   ' + b.website + '   •   ' + b.email);
    st.logo = await badge();
    pdfPage(st);
    pdfText(st, 'Dryer vent inspection report', { size: 22, bold: true, after: 4 });
    pdfText(st, 'Service date  ' + PJ.longDate(j.service_date), { size: 11, color: PDF_MUTED, after: 14 });
    const pair = (label, value) => { if (!value) return; pdfNeed(st, 34); pdfText(st, label, { size: 8.5, bold: true, color: PDF_ACCENT, after: 1 }); pdfText(st, value, { size: 11.5, after: 8 }); };
    pair('CUSTOMER', PJ.fullName(c) + ([c.phone, c.email].filter(Boolean).length ? '  •  ' + [c.phone, c.email].filter(Boolean).join('  •  ') : ''));
    pair('SERVICE ADDRESS', PJ.serviceAddress(c));
    pair('TECHNICIAN', j.technician || technician());
    st.y += 4;
    pdfText(st, 'Work and agreed price', { size: 15, bold: true, after: 4 });
    const items = a ? a.document.services : j.services, adj = a ? a.document.adjustments : j.adjustments;
    for (const s of items) pdfText(st, s.name + ((s.qty || 1) > 1 ? ' (' + s.qty + ' × ' + PJ.money(s.price_cents) + ')' : '') + '   ' + PJ.money(PJ.lineCents(s)), { size: 11, after: 2 });
    for (const x of adj || []) pdfText(st, (x.label || 'Adjustment') + '   ' + PJ.money(x.amount_cents), { size: 11, after: 2 });
    pdfText(st, 'Total   ' + PJ.money(a ? a.total_cents : PJ.totals(j.services, j.adjustments).total) + '   •   Payment: ' + (PAYMENT[j.payment_status] || 'Unpaid') + (j.payment_method ? ' (' + j.payment_method + ')' : ''), { size: 11, bold: true, after: 4 });
    if (a) pdfText(st, 'Signed service agreement ' + a.document.agreement_no + ' (version ' + a.version + ') is provided as a separate PDF.', { size: 9, color: PDF_MUTED, after: 12 });
    pdfText(st, 'Inspection summary', { size: 15, bold: true, after: 4 });
    const sum = (k, v) => pdfText(st, k + '  •  ' + v, { size: 11, after: 2 });
    sum('Vent termination', ins.termination || TERMINATIONS[0]);
    sum('Duct access', ins.access || ACCESS[0]);
    sum('Visible condition before service', ins.condition || CONDITION[0]);
    sum('Camera check', ins.camera || CAMERA[0]);
    if (ins.airflow_before || ins.airflow_after) {
      const unit = ins.airflow_unit || 'ft/min';
      sum('Airflow', (ins.airflow_before ? 'before ' + ins.airflow_before + ' ' + unit : '') + (ins.airflow_before && ins.airflow_after ? ',  ' : '') + (ins.airflow_after ? 'after ' + ins.airflow_after + ' ' + unit : ''));
    }
    st.y += 8;
    for (const [title, key] of [['Findings', 'findings'], ['Work performed', 'work'], ['Recommendations', 'recommendations']]) {
      const v = (ins[key] || '').trim();
      if (!v) continue;
      pdfNeed(st, 44);
      pdfText(st, title, { size: 13, bold: true, after: 3 });
      pdfText(st, v, { size: 11, after: 10 });
    }
    pdfNeed(st, 40);
    pdfText(st, 'This report describes visible conditions at the time of service. Findings are limited to the areas accessed during this visit.', { size: 9, color: PDF_MUTED });
    // Google review request
    const rurl = (b.review_url || '').trim();
    if (rurl) {
      const qr = rurl.split('?')[0] === REVIEW_QR_FOR ? await reviewQr() : null;
      pdfNeed(st, 150);
      st.y += 14;
      const d = st.d, top = st.y;
      d.setDrawColor(254, 168, 83); d.setLineWidth(1.5); d.roundedRect(46, top, 520, 128, 10, 10, 'S');
      if (qr) d.addImage(qr, 'PNG', 60, top + 12, 104, 104);
      const x = qr ? 182 : 62;
      d.setFont('helvetica', 'bold'); d.setFontSize(15); d.setTextColor(16, 45, 55);
      d.text('Happy with our work?', x, top + 36);
      d.setFont('helvetica', 'normal'); d.setFontSize(11); d.setTextColor(...PDF_MUTED);
      d.text(d.splitTextToSize((qr ? 'Scan the code with your phone camera' : 'Visit the link below') + ' to leave us a Google review. It takes a minute and helps a small local business a lot. Thank you!', 566 - x - 14), x, top + 56);
      d.setTextColor(20, 102, 84); d.setFontSize(10);
      d.textWithLink(rurl.split('?')[0], x, top + 108, { url: rurl });
      st.y = top + 140;
    }
    // photos, two per page
    const photos = j.photos || [];
    for (let i = 0; i < photos.length; i++) {
      if (i % 2 === 0) { pdfPage(st); pdfText(st, 'Inspection photos', { size: 18, bold: true, after: 8 }); }
      const p = photos[i];
      const blob = await Sync.file(photoPath(j.id, p.id));
      const d = st.d;
      d.setFillColor(243, 246, 247); d.rect(46, st.y, 520, 250, 'F');
      if (blob) {
        const url = await blobToDataUrl(blob);
        const img = new Image();
        await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
        const k = Math.min(508 / (img.width || 1), 238 / (img.height || 1));
        const w = (img.width || 508) * k, h = (img.height || 238) * k;
        d.addImage(url, 'JPEG', 46 + (520 - w) / 2, st.y + (250 - h) / 2, w, h);
      } else {
        d.setFont('helvetica', 'normal'); d.setFontSize(10); d.setTextColor(...PDF_MUTED);
        d.text('Photo not available on this device yet', 306, st.y + 125, { align: 'center' });
      }
      st.y += 256;
      pdfText(st, 'Photo ' + (i + 1) + '  •  ' + p.label, { size: 11, bold: true, after: 14 });
    }
    pdfFinish(st);
    return st.d.output('blob');
  }

  // ================================================================ viewing & sending files
  async function viewFile(path, name) {
    const blob = await Sync.file(path);
    if (!blob) { toast('This file isn’t on this device yet. Connect to the internet and sign in to download it.', true); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && navigator.canShare) {
      // In a Home Screen app, the share sheet is the dependable way to open a PDF.
      return shareFile(path, name, '', null);
    }
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
  }
  function reviewLine() {
    const u = business().review_url;
    return u ? 'If you were happy with our work, a quick Google review would mean a lot to our small local business: ' + u : '';
  }
  function reviewMessage(c) {
    return 'Hi ' + ((c && c.first_name) || 'there') + ', thank you for choosing ' + business().name + '! ' + reviewLine() + '\n\nThank you!';
  }
  /** Buttons that open a ready-to-send text or email asking for a Google review. */
  function reviewCard(body, c) {
    if (!business().review_url) return;
    const k = card(body, 'Ask for a Google review');
    k.appendChild(el('p', 'tip', 'The review link is already in the report message. Use these to send a separate request.'));
    const r = row(k);
    const msg = reviewMessage(c);
    if (c.phone) {
      const a = el('a', 'plain', 'Text review request');
      a.href = 'sms:' + c.phone.replace(/[^\d+]/g, '') + (/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? '&' : '?') + 'body=' + encodeURIComponent(msg);
      r.appendChild(a);
    }
    if (c.email) {
      const a = el('a', 'plain', 'Email review request');
      a.href = 'mailto:' + encodeURIComponent(c.email) + '?subject=' + encodeURIComponent('Thank you from ' + business().name) + '&body=' + encodeURIComponent(msg);
      r.appendChild(a);
    }
    if (!c.phone && !c.email) k.appendChild(el('p', 'muted', 'Add a phone number or email to this customer to send a request.'));
  }

  async function shareFile(path, name, subject, customer, askReview) {
    const blob = await Sync.file(path);
    if (!blob) { toast('This file isn’t on this device yet. Connect to the internet and sign in to download it.', true); return; }
    const file = new File([blob], name.replace(/[\\/:*?"<>|]/g, '-'), { type: blob.type || 'application/pdf' });
    const text = customer ? 'Hi ' + (customer.first_name || '') + ',\n\nAttached is your ' + subject.toLowerCase().replace(/^your /, '') + '. Questions? Call or text ' + business().phone + '.' +
      (askReview && reviewLine() ? '\n\n' + reviewLine() : '') + '\n\nThank you,\n' + business().name : '';
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: subject || name, text }); } catch (e) { /* closed the share sheet */ }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
    toast('Saved ' + file.name + '. Attach it to an email or text to send it.', true);
  }

  // ================================================================ inspection
  const photoPath = (jobId, id) => jobId + '/photos/' + id + '.jpg';
  async function resizePhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('That image could not be opened.')); img.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.85));
    } finally { URL.revokeObjectURL(url); }
  }

  /** Work today needs a reason: the customer asked us to come out (before or after we knocked). */
  function todayReasonOk(j) {
    const r = j.request || {};
    return PJ.TODAY_REASONS.some(x => x[0] === r.reason) && !!PJ.parseYmd(r.date) && r.date <= PJ.ymd(new Date()) && PJ.TODAY_METHODS.indexOf(r.method) >= 0;
  }
  function requestFor(j) {
    const r = j.request || {};
    if (PJ.isRequested(j)) return { date: r.date, method: r.method };
    if (j.timing === 'now') return { date: r.date, method: r.method, reason: r.reason };
    return {};
  }
  // Jobs where the technician is adding services found on site (kept on this device only).
  const addOnJobs = new Set();
  /** Extra work found during the visit: the customer approves it by signing an updated agreement. */
  async function moreServices(jobId) {
    const cur = jobs.get(jobId);
    const c = customers.get(cur.customer_id);
    addOnJobs.add(jobId);
    // Extra work always carries the 3-day right to cancel. It can be done today only when the
    // customer asked us to come out; otherwise step 1 asks when it will be done.
    const d = Object.assign({}, cur, { status: 'draft', timing: 'now', service_date: PJ.ymd(new Date()), service_window: '', origin: 'door', request: Object.assign({}, cur.request || {}) });
    if (PJ.isRequested(cur) && !d.request.reason) d.request.reason = 'before_door';   // they called us before this visit
    if (!todayReasonOk(d)) d.timing = '';
    await saveJob(d);
    wizard(c, d, d.timing ? 1 : 0, false);
  }

  function inspection(jobId, confirmed) {
    const j0 = jobs.get(jobId);
    const c = customers.get(j0.customer_id);
    const deadline = cancelDeadline(j0);
    if (!confirmed && j0.status === 'signed' && j0.timing === 'scheduled' && deadline && PJ.ymd(new Date()) <= deadline) {
      dialog('Start before the scheduled date?', 'This job is scheduled for ' + PJ.longDate(j0.service_date) + ', after the customer’s cancel period. Their cancel period runs until midnight of ' +
        PJ.longDate(deadline) + '. Only start now if the customer asks you to. They can still cancel and get a full refund.',
        [{ label: 'Wait' }, { label: 'Customer asked — start now', run: () => inspection(jobId, true) }]);
      return;
    }
    let timer = 0;
    const j = Object.assign({}, j0, { inspection: Object.assign({}, j0.inspection || {}), photos: (j0.photos || []).slice() });
    if (j.status === 'signed') j.status = 'inspecting';
    if (!j.technician) j.technician = technician();
    let changed = false;
    const finished = j0.status === 'completed';
    const save = () => { changed = true; clearTimeout(timer); timer = setTimeout(() => saveJob(Object.assign({}, j)), 400); };
    // Saves the inspection, builds the report PDF and marks the job completed.
    const makeReport = async () => {
      clearTimeout(timer);
      await saveJob(Object.assign({}, j));
      const pdf = await reportPdf(jobs.get(j.id));
      const path = j.id + '/report-' + Date.now() + '.pdf';
      await putFile(path, pdf);
      const done = Object.assign({}, jobs.get(j.id), { report_path: path, report_at: Date.now(), status: 'completed' });
      await saveJob(done);
      markDoor(done, c, 'COMPLETED');
      reportPage(j.id);
    };
    const set = (k, v) => { j.inspection[k] = v; save(); };
    let photoLabel = 'Before';
    openPage({
      title: PJ.fullName(c), kicker: 'Inspection · ' + PJ.longDate(j.service_date),
      back: () => {
        clearTimeout(timer);
        saveJob(Object.assign({}, j)).then(() => {
          if (!(finished && changed)) { openCustomer(c.id); return; }
          dialog('Update the report?', 'You changed this inspection after its report was made. Update the report so it shows your changes?',
            [{ label: 'Not now', run: () => openCustomer(c.id) },
             { label: 'Update report', cls: 'primary', run: () => makeReport().catch(err => dialog('Couldn’t create the report', String(err.message || err))) }]);
        });
      },
      render(body, foot) {
        body.appendChild(el('p', 'tip', 'Everything saves on this device as you go.'));
        if (finished) body.appendChild(el('p', 'tip warn', 'You’re editing a finished inspection. Your changes save as you type. Tap “Update report” when you’re done so the customer’s report matches.'));
        const ms = card(body, 'Found more work?');
        ms.appendChild(el('p', 'tip', 'Explain the extra work and its price first. If the customer wants it, add it here and they sign an updated agreement. Your notes and photos stay.'));
        ms.appendChild(button('+ More services needed', '', async () => {
          clearTimeout(timer);
          await saveJob(Object.assign({}, j));
          moreServices(jobId);
        }));
        const k = card(body, 'Checklist');
        select(k, 'Vent termination', TERMINATIONS, j.inspection.termination, v => set('termination', v));
        select(k, 'Duct access', ACCESS, j.inspection.access, v => set('access', v));
        select(k, 'Visible condition before service', CONDITION, j.inspection.condition, v => set('condition', v));
        select(k, 'Camera check', CAMERA, j.inspection.camera, v => set('camera', v));
        const air = card(body, 'Airflow (optional)');
        input(air, 'Before cleaning', j.inspection.airflow_before, { mode: 'decimal', half: true, max: 12, onInput: v => set('airflow_before', v.trim()) });
        input(air, 'After cleaning', j.inspection.airflow_after, { mode: 'decimal', half: true, max: 12, onInput: v => set('airflow_after', v.trim()) });
        select(air, 'Unit', ['ft/min', 'm/s', 'CFM'], j.inspection.airflow_unit || 'ft/min', v => set('airflow_unit', v));
        const n = card(body, 'Notes for the report');
        input(n, 'Findings', j.inspection.findings, { multi: true, rows: 3, max: 4000, placeholder: 'Example: lint buildup near the exterior vent', onInput: v => set('findings', v) });
        input(n, 'Work performed', j.inspection.work, { multi: true, rows: 3, max: 4000, placeholder: 'What you cleaned, checked, or adjusted', onInput: v => set('work', v) });
        input(n, 'Recommendations', j.inspection.recommendations, { multi: true, rows: 3, max: 4000, placeholder: 'Any next steps for the homeowner', onInput: v => set('recommendations', v) });
        input(n, 'Technician', j.technician, { max: 120, caps: 'words', onInput: v => { j.technician = v; A.lsSet('pc-tech', v); save(); } });
        const p = card(body, 'Photos');
        p.appendChild(el('p', 'tip', 'Up to ' + PHOTO_LIMIT + ' photos. Choose the label first, then take or pick the photo.'));
        const labels = el('div', 'chips2');
        PHOTO_LABELS.forEach(l => {
          const b = el('button', 'chip' + (l === photoLabel ? ' on' : ''), l);
          b.onclick = () => { photoLabel = l; labels.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); };
          labels.appendChild(b);
        });
        p.appendChild(labels);
        const pick = el('input');
        pick.type = 'file'; pick.accept = 'image/*'; pick.hidden = true;
        const addBtn = button('Take or add photo', 'primary', () => {
          if (j.photos.length >= PHOTO_LIMIT) { toast('This job already has ' + PHOTO_LIMIT + ' photos.', true); return; }
          pick.click();
        });
        p.append(addBtn, pick);
        const grid = el('div', 'photos');
        p.appendChild(grid);
        const drawPhotos = async () => {
          grid.innerHTML = '';
          for (const ph of j.photos) {
            const cell = el('div', 'ph');
            const im = el('img');
            im.alt = ph.label;
            Sync.file(photoPath(j.id, ph.id)).then(b => { if (b) im.src = URL.createObjectURL(b); });
            const rm = el('button', 'plain danger', 'Remove');
            rm.onclick = () => dialog('Remove this photo?', ph.label, [{ label: 'Keep' }, { label: 'Remove', cls: 'danger', run: () => { j.photos = j.photos.filter(x => x !== ph); save(); drawPhotos(); } }]);
            cell.append(im, el('div', 'phl', ph.label), rm);
            grid.appendChild(cell);
          }
        };
        pick.onchange = async () => {
          const f = pick.files && pick.files[0];
          pick.value = '';
          if (!f) return;
          addBtn.disabled = true; addBtn.textContent = 'Adding photo…';
          try {
            const blob = await resizePhoto(f);
            const id = uuid();
            await putFile(photoPath(j.id, id), blob);
            j.photos.push({ id, label: photoLabel });
            await saveJob(Object.assign({}, j));
            drawPhotos();
          } catch (e) { toast(e.message || 'Could not add that photo.', true); }
          addBtn.disabled = false; addBtn.textContent = 'Take or add photo';
        };
        drawPhotos();
        const reportLabel = finished ? 'Update report' : 'Create report';
        foot.appendChild(button(reportLabel, 'primary big', async e => {
          const b = e.target;
          b.disabled = true; b.textContent = finished ? 'Updating report…' : 'Creating report…';
          try {
            await makeReport();
          } catch (err) {
            console.error(err);
            b.disabled = false; b.textContent = reportLabel;
            dialog('Couldn’t create the report', String(err.message || err));
          }
        }));
      },
    });
  }

  function reportPage(jobId) {
    const j = jobs.get(jobId);
    const c = customers.get(j.customer_id);
    openPage({
      title: 'Report ready', kicker: PJ.fullName(c), back: () => openCustomer(c.id),
      render(body, foot) {
        const k = card(body);
        k.appendChild(el('div', 'bigcheck', '✓'));
        k.appendChild(el('h3', 'center', 'Inspection report saved'));
        k.appendChild(el('p', 'center muted', 'Created ' + A.fmtDate(j.report_at)));
        const r = row(k);
        r.appendChild(button('View report', '', () => viewFile(j.report_path, 'Inspection report.pdf')));
        r.appendChild(button('Send to customer', '', () => shareFile(j.report_path, 'Prairie Lint Patrol inspection report ' + j.service_date + '.pdf', 'Your Prairie Lint Patrol inspection report', c, true)));
        r.appendChild(button('Edit inspection', '', () => inspection(j.id)));
        reviewCard(body, c);
        paymentCard(body, j);
        foot.appendChild(button('Done', 'primary big', () => openCustomer(c.id)));
      },
    });
  }

  function paymentCard(body, j) {
    const p = card(body, 'Payment');
    const deadline = cancelDeadline(j);
    if (deadline && j.status !== 'cancelled' && PJ.ymd(new Date()) <= deadline)
      p.appendChild(el('p', 'tip warn', 'The customer can cancel until midnight of ' + PJ.longDate(deadline) + '. If they do, refund every payment within 10 business days. You may prefer to collect payment after that date.'));
    select(p, 'Status', Object.values(PAYMENT), PAYMENT[j.payment_status] || 'Unpaid', v => {
      const key = Object.keys(PAYMENT).find(k => PAYMENT[k] === v);
      saveJob(Object.assign({}, jobs.get(j.id), { payment_status: key }));
    });
    select(p, 'Method', METHODS, j.payment_method || '', v => saveJob(Object.assign({}, jobs.get(j.id), { payment_method: v })));
    input(p, 'Payment note (check number, amount paid…)', j.payment_note, { max: 300, onInput: v => {
      clearTimeout(paymentCard.t);
      paymentCard.t = setTimeout(() => saveJob(Object.assign({}, jobs.get(j.id), { payment_note: v })), 500);
    } });
  }

  // ================================================================ customer & job pages
  function openCustomer(id) {
    const c = customers.get(id);
    if (!live(c)) { closePage(); A.showTab('customers'); return; }
    openPage({
      title: PJ.fullName(c) || 'Customer', kicker: 'Customer', back: () => { closePage(); A.showTab('customers'); },
      refresh: () => openCustomer(id),
      render(body, foot) {
        const k = card(body, 'Contact');
        k.appendChild(el('p', 'big', PJ.serviceAddress(c)));
        if (c.phone) k.appendChild(el('p', '', 'Phone: ' + c.phone));
        if (c.email) k.appendChild(el('p', '', 'Email: ' + c.email));
        if (c.notes) k.appendChild(el('p', 'muted', c.notes));
        const r = row(k);
        if (c.phone) { const a = el('a', 'plain', 'Call'); a.href = 'tel:' + c.phone.replace(/[^\d+]/g, ''); r.appendChild(a); }
        if (c.email) { const a = el('a', 'plain', 'Email'); a.href = 'mailto:' + c.email; r.appendChild(a); }
        r.appendChild(button('Edit', '', () => editCustomer(c.id)));
        if (c.lat != null) r.appendChild(button('Map', '', () => { closePage(); A.goTo(c.lat, c.lon); }));
        const js = jobsFor(c.id);
        const jl = card(body, 'Jobs (' + js.length + ')');
        if (!js.length) jl.appendChild(el('p', 'muted', 'No jobs yet.'));
        for (const j of js) {
          jl.appendChild(listRow(PJ.longDate(j.service_date) + ' · ' + PJ.money(j.total_cents || PJ.totals(j.services, j.adjustments).total),
            serviceSummary(j), STATUS[j.status] + ' · ' + (PAYMENT[j.payment_status] || 'Unpaid'), () => openJob(j.id)));
        }
        const signed = js.filter(j => agreementsFor(j.id).length).length;
        const more = card(body, 'More');
        more.appendChild(button('Delete customer', 'danger', () => dialog('Delete ' + (PJ.fullName(c) || 'this customer') + '?',
          'This removes the customer and ' + (js.length === 1 ? 'their job' : 'all ' + js.length + ' of their jobs') + ' from the app on every crew phone and tablet.' +
          (signed ? ' Signed agreements are kept in the crew database as a record, but they won’t show in the app.' : '') + ' This can’t be undone in the app.',
          [{ label: 'Keep' }, { label: 'Delete customer', cls: 'danger', run: async () => {
            for (const j of js) await saveJob(Object.assign({}, jobs.get(j.id), { deleted: true }));
            await saveRow('customers', customers, Object.assign({}, customers.get(c.id), { deleted: true }));
            toast('Customer deleted.');
            closePage(); A.showTab('customers');
          } }])));
        foot.appendChild(button('New job for ' + (c.first_name || 'this customer'), 'primary big', () => wizard(c, newJob(c, null), 1, false)));
      },
    });
  }

  function editCustomer(id) {
    const c = Object.assign({}, customers.get(id));
    openPage({
      title: 'Edit customer', kicker: PJ.fullName(c), back: () => openCustomer(id),
      render(body, foot) {
        const k = card(body);
        const f = input(k, 'First name', c.first_name, { required: true, half: true, caps: 'words', onInput: v => { c.first_name = v; } });
        input(k, 'Last name', c.last_name, { required: true, half: true, caps: 'words', onInput: v => { c.last_name = v; } });
        input(k, 'Phone', c.phone, { type: 'tel', half: true, onInput: v => { c.phone = v; } });
        const em = input(k, 'Email', c.email, { type: 'email', half: true, caps: 'off', onInput: v => { c.email = v.trim(); } });
        input(k, 'Street', c.street, { caps: 'words', onInput: v => { c.street = v; } });
        input(k, 'City', c.city, { half: true, caps: 'words', onInput: v => { c.city = v; } });
        input(k, 'State', c.state, { half: true, max: 2, onInput: v => { c.state = v.toUpperCase(); } });
        input(k, 'ZIP', c.zip, { half: true, mode: 'numeric', onInput: v => { c.zip = v; } });
        input(k, 'Notes', c.notes, { multi: true, rows: 3, onInput: v => { c.notes = v; } });
        k.appendChild(el('p', 'tip', 'Changes here don’t alter agreements that are already signed.'));
        foot.appendChild(button('Save', 'primary big', () => {
          if (!c.first_name.trim()) return f.showError('Enter the first name.');
          if (c.email && !validEmail(c.email)) return em.showError('Check this email address.');
          saveCustomer(c).then(() => openCustomer(id));
        }));
      },
    });
  }

  function openJob(jobId) {
    const j = jobs.get(jobId);
    if (!j) { closePage(); return; }
    const c = customers.get(j.customer_id);
    const list = agreementsFor(j.id);
    openPage({
      title: PJ.longDate(j.service_date), kicker: PJ.fullName(c) + ' · Job',
      back: () => openCustomer(c.id), refresh: () => openJob(jobId),
      render(body, foot) {
        const k = card(body, 'Status');
        k.appendChild(el('p', 'big', STATUS[j.status] || j.status));
        k.appendChild(el('p', '', serviceSummary(j)));
        if (j.status === 'awaiting') k.appendChild(button('Open the signing link', '', () => remoteSignPage(j.id)));
        k.appendChild(el('p', 'big', PJ.money(j.total_cents || PJ.totals(j.services, j.adjustments).total)));
        if (list.length) {
          const ag = card(body, 'Signed agreements');
          for (const a of list) {
            const r = row(ag);
            r.appendChild(el('div', 'grow', 'Version ' + a.version + ' · ' + PJ.money(a.total_cents) + ' · signed ' + A.fmtDate(a.signed_at)));
            r.appendChild(button('View', '', () => viewFile(a.pdf_path, a.document.agreement_no + '-v' + a.version + '.pdf')));
            r.appendChild(button('Send', '', () => shareFile(a.pdf_path, 'Prairie Lint Patrol agreement ' + a.document.agreement_no + '.pdf', 'Your signed Prairie Lint Patrol service agreement', c)));
          }
        }
        if (j.report_path) {
          const rp = card(body, 'Inspection report');
          const r = row(rp);
          r.appendChild(button('View report', '', () => viewFile(j.report_path, 'Inspection report.pdf')));
          r.appendChild(button('Send to customer', '', () => shareFile(j.report_path, 'Prairie Lint Patrol inspection report ' + j.service_date + '.pdf', 'Your Prairie Lint Patrol inspection report', c, true)));
          reviewCard(body, c);
        }
        paymentCard(body, j);
        const more = card(body, 'More');
        if (['signed', 'inspecting', 'completed'].includes(j.status)) {
          more.appendChild(button('+ More services needed', '', () => moreServices(j.id)));
        }
        if (j.status !== 'draft' && j.status !== 'cancelled') {
          more.appendChild(button('Change work or price (new signed version)', '', () => dialog('Change the agreed work?',
            'The signed agreement stays as it is. You’ll edit the services and price, and the customer signs a new version.',
            [{ label: 'Cancel' }, { label: 'Make a new version', cls: 'primary', run: async () => {
              const d = Object.assign({}, jobs.get(j.id), { status: 'draft' });
              await saveJob(d);
              wizard(c, d, 1, false);
            } }])));
        }
        if (j.status !== 'cancelled' && list.some(a => a.cancel_by)) {
          more.appendChild(button('Customer cancelled (within 3 business days)', 'danger', () => dialog('Mark this job cancelled?',
            'Refund any payment within 10 business days of receiving their notice, as the agreement says.',
            [{ label: 'Keep job' }, { label: 'Mark cancelled', cls: 'danger', run: () => saveJob(Object.assign({}, jobs.get(j.id), { status: 'cancelled' })).then(() => openJob(j.id)) }])));
        }
        if (!list.length && j.status !== 'awaiting') {
          more.appendChild(button('Delete this unsigned job', 'danger', () => dialog('Delete this job?', 'It hasn’t been signed. This can’t be undone.',
            [{ label: 'Keep' }, { label: 'Delete', cls: 'danger', run: () => saveJob(Object.assign({}, jobs.get(j.id), { deleted: true })).then(() => openCustomer(c.id)) }])));
        }
        const label = j.status === 'awaiting' ? '' : j.status === 'draft' ? 'Continue: ' + (list.length ? 'sign new version' : 'set up & sign')
          : j.status === 'signed' ? 'Begin inspection' : j.status === 'inspecting' ? 'Continue inspection'
            : j.status === 'completed' ? 'Edit inspection & recreate report' : '';
        if (label) foot.appendChild(button(label, 'primary big', () => (j.status === 'draft' ? wizard(c, j, 1, false) : inspection(j.id))));
      },
    });
  }

  // ================================================================ settings
  function openSettings() {
    const b = business();
    const v = JSON.parse(JSON.stringify(b));
    openPage({
      title: 'Settings', kicker: 'Business & technician', back: closePage,
      render(body, foot) {
        const t = card(body, 'This device');
        const tech = input(t, 'Technician name (on agreements and reports)', technician(), { caps: 'words', max: 120 });
        const k = card(body, 'Business details (shared with the crew)');
        k.appendChild(el('p', 'tip', 'These appear on every new agreement and report. Agreements already signed don’t change.'));
        input(k, 'Business name', v.name, { onInput: x => { v.name = x; } });
        input(k, 'Street', v.street, { onInput: x => { v.street = x; } });
        input(k, 'City', v.city, { half: true, onInput: x => { v.city = x; } });
        input(k, 'State', v.state, { half: true, max: 2, onInput: x => { v.state = x.toUpperCase(); } });
        input(k, 'ZIP', v.zip, { half: true, onInput: x => { v.zip = x; } });
        input(k, 'Phone', v.phone, { half: true, onInput: x => { v.phone = x; } });
        input(k, 'Email', v.email, { half: true, onInput: x => { v.email = x.trim(); } });
        input(k, 'Website', v.website, { half: true, onInput: x => { v.website = x.trim(); } });
        const rv = card(body, 'Customer-requested visits');
        rv.appendChild(el('p', 'tip', 'When on, new jobs ask how the job started. If the customer contacted you and asked you to come, that agreement has no 3-day cancellation period. Turn this on only after your attorney has approved the wording.'));
        const rvl = el('label', 'tick');
        const rvc = el('input'); rvc.type = 'checkbox'; rvc.checked = !!v.requested_visits;
        rvc.onchange = () => { v.requested_visits = rvc.checked; };
        rvl.append(rvc, el('span', '', 'Allow customer-requested visits (attorney approved)'));
        rv.appendChild(rvl);
        input(k, 'Google review link (added to report messages)', v.review_url, { type: 'url', caps: 'off', onInput: x => { v.review_url = x.trim(); } });
        input(k, 'Online booking page (shown when scheduling)', v.booking_url, { type: 'url', caps: 'off', onInput: x => { v.booking_url = x.trim(); } });
        input(k, 'Payment terms', v.payment_terms, { multi: true, rows: 2, onInput: x => { v.payment_terms = x; } });
        const s = card(body, 'Standard services and prices');
        v.services.forEach(svc => {
          const box = el('div', 'svc on');
          input(box, 'Name', svc.name, { onInput: x => { svc.name = x; } });
          const pr = input(box, 'Price ($)', (svc.price_cents / 100).toFixed(2), { half: true, mode: 'decimal', onInput: x => { const p = PJ.parseMoney(x); pr.showError(p === null || p < 0 ? 'Enter a price' : ''); if (p !== null && p >= 0) svc.price_cents = p; } });
          const l = el('label', 'tick');
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!svc.default; cb.onchange = () => { svc.default = cb.checked; };
          l.append(cb, el('span', '', 'Selected by default on new jobs'));
          box.appendChild(l);
          input(box, 'Description', svc.description, { multi: true, rows: 2, onInput: x => { svc.description = x; } });
          s.appendChild(box);
        });
        foot.appendChild(button('Save settings', 'primary big', async () => {
          A.lsSet('pc-tech', tech.value.trim());
          if (!v.name.trim() || !v.street.trim() || !v.city.trim()) { toast('Business name and address are required on agreements.', true); return; }
          await saveRow('settings', settings, { id: 'business', value: v });
          toast('Settings saved.');
          closePage();
        }));
      },
    });
  }

  // ================================================================ public
  window.Jobs = { showCustomers, startFromDoor, jobForDoor: id => jobForDoor(id), openCustomer, openJob,
    _debug: { customers, jobs, agreements, settings, reportPdf, agreementPdf } };
})();
