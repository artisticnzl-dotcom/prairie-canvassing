/* Prairie Canvassing — customers, pricing and agreements (no screen code). The Android app mirrors this exactly. */
(function (root) {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const DEFAULT_BUSINESS = {
    name: 'Prairie Lint Patrol', street: '506 Clover Ln', city: 'Hesston', state: 'KS', zip: '67062',
    phone: '620-869-1692', email: 'prairielintpatrol@gmail.com', website: 'PrairieLintPatrol.com', booking_url: 'https://prairielintpatrol.com/#book', requested_visits: false, review_url: 'https://g.page/r/CcnmULVFXxSkEBM/review',
    payment_terms: 'Payment is due when the work is completed. We accept check, card, or ACH bank transfer.',
    services: [
      { name: 'Standard Dryer Vent Cleaning', description: 'Clean the dryer vent line from the dryer connection to the exterior termination, where accessible.', price_cents: 14900, default: true },
      { name: 'Roof-Exhaust Dryer Vent Cleaning', description: 'Clean a dryer vent line that exits through the roof, where accessible.', price_cents: 16900, default: false },
      { name: 'Additional Dryer Vent Cleaning', description: 'Cleaning of an additional dryer vent line at the same property.', price_cents: 9900, default: false },
      { name: 'Inspection Only', description: 'Visual and camera inspection of accessible vent sections with a written report. No cleaning.', price_cents: 7900, default: false },
    ],
  };

  // ------------------------------------------------------------ money
  function money(cents) {
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    const d = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + '$' + d + '.' + String(c % 100).padStart(2, '0');
  }
  /** "149", "149.5", "$1,049.99" → cents; null if not a number. */
  function parseMoney(s) {
    const t = String(s == null ? '' : s).replace(/[$,\s]/g, '');
    if (!/^-?\d*(\.\d{0,2})?$/.test(t) || t === '' || t === '-' || t === '.') return null;
    return Math.round(parseFloat(t) * 100);
  }
  function lineCents(item) { return Math.max(1, item.qty || 1) * (item.price_cents || 0); }
  function totals(services, adjustments) {
    const subtotal = (services || []).reduce((a, s) => a + lineCents(s), 0);
    const adj = (adjustments || []).reduce((a, x) => a + (x.amount_cents || 0), 0);
    return { subtotal, adjustments: adj, total: Math.max(0, subtotal + adj) };
  }

  // ------------------------------------------------------------ dates
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], 12);
    return d.getMonth() === +m[2] - 1 ? d : null;
  }
  function longDate(s) { const d = parseYmd(s); return d ? MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() : s; }

  function nthWeekday(year, month, weekday, n) { // n-th weekday (0=Sun) of month; n = -1 for last
    if (n > 0) {
      const first = new Date(year, month, 1, 12);
      return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7, 12);
    }
    const last = new Date(year, month + 1, 0, 12);
    return new Date(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7), 12);
  }

  /** Legal holidays used to count business days. Generous on purpose: an extra day off only gives the customer longer to cancel. */
  function holidays(year) {
    const fixed = [[0, 1], [1, 12], [5, 19], [6, 4], [10, 11], [11, 25]]; // New Year, Lincoln, Juneteenth, July 4, Veterans, Christmas
    const out = new Set();
    for (const [m, d] of fixed) {
      const day = new Date(year, m, d, 12);
      out.add(ymd(day));
      if (day.getDay() === 0) out.add(ymd(new Date(year, m, d + 1, 12)));   // observed Monday
      if (day.getDay() === 6) out.add(ymd(new Date(year, m, d - 1, 12)));   // observed Friday
    }
    out.add(ymd(nthWeekday(year, 0, 1, 3)));   // Martin Luther King Jr. Day
    out.add(ymd(nthWeekday(year, 1, 1, 3)));   // Presidents' Day
    out.add(ymd(nthWeekday(year, 4, 1, -1)));  // Memorial Day
    out.add(ymd(nthWeekday(year, 8, 1, 1)));   // Labor Day
    out.add(ymd(nthWeekday(year, 9, 1, 2)));   // Columbus Day
    out.add(ymd(nthWeekday(year, 10, 4, 4)));  // Thanksgiving
    // New Year's Day of next year observed on Dec 31
    if (new Date(year + 1, 0, 1, 12).getDay() === 6) out.add(year + '-12-31');
    return out;
  }
  function isBusinessDay(d) {
    if (d.getDay() === 0) return false;
    return !holidays(d.getFullYear()).has(ymd(d));
  }
  /** Last day to cancel: the third business day after the transaction date (cancel by midnight of that day). */
  function cancelBy(transactionYmd) {
    const d = parseYmd(transactionYmd);
    if (!d) return '';
    let n = 0;
    while (n < 3) {
      d.setDate(d.getDate() + 1);
      if (isBusinessDay(d)) n++;
    }
    return ymd(d);
  }

  // ------------------------------------------------------------ the agreement
  function fill(s, vars) { return String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)); }
  function cityLine(o) { return [o.city, [o.state, o.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); }
  function fullName(c) { return [c.first_name, c.last_name].map(x => (x || '').trim()).filter(Boolean).join(' '); }
  function serviceAddress(c) { return [c.street, cityLine(c)].filter(Boolean).join(', '); }
  function businessAddress(b) { return [b.street, cityLine(b)].filter(Boolean).join(', '); }

  /**
   * The exact agreement a customer reviews and signs. Same input → same text on every device.
   * ctx: {template, business, customer, job, version, agreement_no, transaction_date, technician}
   */
  const REQUEST_METHODS = ['Phone call', 'Text message', 'Website booking', 'Email', 'Social media message', 'Other'];
  /** True when the customer asked us to come (no 3-day right for that requested maintenance visit). */
  /** "2:30 PM" style appointment times; older jobs may have Morning/Afternoon/Evening. */
  function isClockTime(w) { return /^\d{1,2}:\d{2} ?(AM|PM)$/i.test(String(w || '').trim()); }
  /** The words after a date: " at 2:30 PM" or ", morning" (older jobs), or "". */
  function windowSuffix(w) { return !w ? '' : isClockTime(w) ? ' at ' + String(w).trim().toUpperCase() : ', ' + String(w).toLowerCase(); }
  function whenText(dateYmd, w) { return longDate(dateYmd) + windowSuffix(w); }
  /** "14:30" → "2:30 PM" and back, for time inputs. */
  function to12h(hhmm) { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ''); if (!m) return ''; const h = +m[1]; return ((h + 11) % 12 + 1) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function to24h(t) { const m = /^(\d{1,2}):(\d{2}) ?(AM|PM)$/i.exec(String(t || '').trim()); if (!m) return ''; let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return String(h).padStart(2, '0') + ':' + m[2]; }
  function isRequested(j) { return !!j && j.origin === 'customer_request'; }
  /** Ways a customer can ask us to come out for work done today. */
  const TODAY_METHODS = ['Phone call', 'Text message', 'Email', 'Website booking'];
  /** Why the work can be done today: the customer asked us to come out. */
  const TODAY_REASONS = [['before_door', 'They contacted us before we came to their door'], ['after_door', 'We knocked first, and they later contacted us on their own to book']];
  function requestMethodText(m) { return !m || m === 'Other' ? 'another method' : String(m).toLowerCase(); }

  function renderAgreement(ctx) {
    const t = ctx.template, b = ctx.business, c = ctx.customer, j = ctx.job;
    const req = isRequested(j) && t.requested ? t.requested : null;
    const rq = j.request || {};
    const tot = totals(j.services, j.adjustments);
    const cancel = cancelBy(ctx.transaction_date);
    const vars = {
      business_name: b.name, total: money(tot.total), payment_terms: b.payment_terms || '',
      transaction_date: longDate(ctx.transaction_date), seller_name: b.name.toUpperCase(),
      seller_address: businessAddress(b).toUpperCase(), cancel_by: longDate(cancel).toUpperCase(),
      cancel_by_date: longDate(cancel), service_date: longDate(j.service_date),
      service_window: windowSuffix(j.service_window),
      request_date: rq.date ? longDate(rq.date) : '', request_method: requestMethodText(rq.method),
    };
    const why = t.timing && t.timing.now_reasons && t.timing.now_reasons[rq.reason];
    vars.today_reason = why ? why.text : '';
    vars.today_reason_customer = why ? fill(why.customer, vars) : '';
    const L = [];
    L.push(b.name.toUpperCase() + ' — ' + t.title.toUpperCase());
    L.push([b.name, businessAddress(b), b.phone, b.email, b.website].filter(Boolean).join(' · '));
    L.push('Agreement ' + ctx.agreement_no + ' · Version ' + ctx.version);
    L.push('Date of transaction: ' + longDate(ctx.transaction_date));
    L.push('');
    L.push('CUSTOMER');
    L.push(fullName(c));
    const contact = [c.phone ? 'Phone: ' + c.phone : '', c.email ? 'Email: ' + c.email : ''].filter(Boolean).join(' · ');
    if (contact) L.push(contact);
    L.push('Service address: ' + serviceAddress(c));
    L.push('Service date: ' + longDate(j.service_date) + (!j.service_window ? '' : isClockTime(j.service_window) ? ' at ' + String(j.service_window).trim().toUpperCase() : ' (' + String(j.service_window).toLowerCase() + ')'));
    L.push('');
    L.push('SERVICES');
    for (const s of j.services) {
      const q = Math.max(1, s.qty || 1);
      L.push('- ' + s.name + (q > 1 ? ' (' + q + ' × ' + money(s.price_cents) + ')' : '') + ': ' + money(lineCents(s)));
      if (s.description) L.push('  ' + s.description);
    }
    if ((j.adjustments || []).length) {
      L.push('Subtotal: ' + money(tot.subtotal));
      for (const a of j.adjustments) L.push('- ' + (a.label || 'Adjustment') + ': ' + money(a.amount_cents));
    }
    L.push('TOTAL PRICE: ' + money(tot.total));
    L.push('');
    for (const s0 of t.sections) {
      const s = req && s0.id === 'cancel' ? req.section : s0;
      L.push(s.heading.toUpperCase()); L.push(fill(s.text, vars)); L.push('');
    }
    if (t.timing && (j.timing === 'now' || j.timing === 'scheduled')) {
      L.push(t.timing.heading.toUpperCase()); L.push(fill((req || t.timing)[j.timing], vars)); L.push('');
    }
    L.push(fill(req ? req.acknowledgment : t.acknowledgment, vars));
    L.push('');
    if (!req) { L.push(t.right_to_cancel); L.push(''); }
    L.push('Technician: ' + (ctx.technician || ''));
    const text = L.join('\n');
    const notice = req ? [] : t.notice.map(x => fill(x, vars));
    return { text, notice, cancel_by: req ? '' : cancel, total_cents: tot.total, vars, requested: !!req };
  }

  /** Short human-friendly agreement number, e.g. PLP-20261114-7F3A. */
  function agreementNo(jobId, transactionYmd) {
    return 'PLP-' + String(transactionYmd).replace(/-/g, '') + '-' + String(jobId).replace(/-/g, '').slice(0, 4).toUpperCase();
  }

  /** First day work may be scheduled when the customer waits out the cancellation period. */
  function firstScheduleDate(transactionYmd) {
    const d = parseYmd(cancelBy(transactionYmd)); d.setDate(d.getDate() + 1); return ymd(d);
  }

  const api = { isClockTime, windowSuffix, whenText, to12h, to24h, REQUEST_METHODS, TODAY_METHODS, TODAY_REASONS, isRequested, requestMethodText, firstScheduleDate, DEFAULT_BUSINESS, MONTHS, money, parseMoney, lineCents, totals, ymd, parseYmd, longDate, holidays, isBusinessDay,
    cancelBy, fill, cityLine, fullName, serviceAddress, businessAddress, renderAgreement, agreementNo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PJ = api;
})(typeof self !== 'undefined' ? self : this);
