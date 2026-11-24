/* Customer signing page: the customer reviews and signs their service agreement on their own phone.
   The link holds a long random key; the server only shows this one agreement for that key. */
(function () {
  'use strict';
  const CFG = window.PC_CONFIG || {};
  const T = window.PC_AGREEMENT;
  const $ = id => document.getElementById(id);
  const main = $('main');
  const token = (new URLSearchParams(location.hash.slice(1))).get('t') || '';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function card(title) {
    const k = el('div', 'card');
    if (title) k.appendChild(el('h3', '', title));
    main.appendChild(k);
    return k;
  }
  function clear() { main.innerHTML = ''; $('bar').hidden = true; $('barIn').innerHTML = ''; }
  function message(title, text, phone) {
    clear();
    const k = card(title);
    k.appendChild(el('p', '', text));
    if (phone) {
      const a = el('a', '', 'Call or text ' + phone);
      a.href = 'tel:' + phone.replace(/[^\d+]/g, '');
      k.appendChild(a);
    }
  }
  async function rpc(name, args) {
    const r = await fetch(CFG.supabaseUrl + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error('The server said ' + r.status);
    return r.json();
  }
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function renderDoc(box, text) {
    text.split('\n').forEach((ln, i) => {
      if (!ln.trim()) return;
      let node;
      if (i === 0) node = el('h2', '', ln);
      else if (ln === T.right_to_cancel) node = el('p', 'rtc', ln);
      else if (/^[0-9]+\. [A-Z]/.test(ln) && ln === ln.toUpperCase()) node = el('h4', '', ln);
      else if (/^(CUSTOMER|SERVICES|TOTAL PRICE)/.test(ln)) node = el('h4', '', ln);
      else node = el('p', /^ {2}/.test(ln) ? 'indent' : '', ln.trim());
      box.appendChild(node);
    });
  }
  function noticeCopies(notice, n) {
    for (let i = 1; i <= n; i++) {
      const box = el('div', 'doc notice');
      box.appendChild(el('p', 'copy', 'Your copy ' + i + ' of ' + n + ' — keep one, and use the other if you decide to cancel.'));
      notice.forEach((line, k) => box.appendChild(el(k === 0 ? 'h4' : 'p', '', line)));
      main.appendChild(box);
    }
  }
  function ctxFor(p, tx) {
    return { template: T, business: p.business, customer: p.customer, job: p.job, version: p.version || 1,
      agreement_no: PJ.agreementNo(p.job.id, tx), transaction_date: tx, technician: p.technician };
  }

  function signaturePad() {
    const wrap = el('div', 'sigwrap');
    const canvas = el('canvas');
    const line = el('div', 'sigline', '✕  Sign here');
    wrap.append(canvas, line);
    const ctx = canvas.getContext('2d');
    let strokes = [], cur = null, scale = 1;
    const redraw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.strokeStyle = '#0c2238'; ctx.fillStyle = '#0c2238';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.6;
      for (const s of strokes) {
        if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x, s[0].y, 1.4, 0, 7); ctx.fill(); continue; }
        ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
        ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y); ctx.stroke();
      }
    };
    const size = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * scale); canvas.height = Math.round(r.height * scale);
      redraw();
    };
    const pt = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); cur = [pt(e)]; strokes.push(cur); redraw(); line.classList.add('signed'); });
    canvas.addEventListener('pointermove', e => { if (!cur) return; e.preventDefault(); (e.getCoalescedEvents ? e.getCoalescedEvents() : [e]).forEach(x => cur.push(pt(x))); redraw(); });
    const end = () => { cur = null; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    window.addEventListener('resize', size);
    setTimeout(size, 0);
    return {
      el: wrap,
      empty: () => !strokes.some(s => s.length > 2) && strokes.length < 2,
      clear: () => { strokes = []; line.classList.remove('signed'); redraw(); },
      png: () => {   // trim to a small image, like the in-person signature
        const out = document.createElement('canvas');
        const w = Math.min(canvas.width, 900), h = Math.round(canvas.height * w / canvas.width);
        out.width = w; out.height = h;
        out.getContext('2d').drawImage(canvas, 0, 0, w, h);
        return out.toDataURL('image/png');
      },
    };
  }

  function showSigned(res, justSigned) {
    clear();
    const p = res.payload;
    const r = PJ.renderAgreement(ctxFor(p, res.transaction_date));
    const top = card();
    top.classList.add('no-print');
    if (justSigned) top.appendChild(el('div', 'ok', '✓'));
    top.appendChild(el('h2', 'center', justSigned ? 'Thank you — your agreement is signed' : 'Your signed agreement'));
    top.appendChild(el('p', 'center', 'Signed by ' + res.signer_name + ' on ' + new Date(res.signed_at).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }) + '.'));
    if (res.cancel_by) top.appendChild(el('p', 'center', 'You can cancel until midnight of ' + PJ.longDate(res.cancel_by) + '. Your two Notice of Cancellation forms are at the bottom of this page.'));
    top.appendChild(el('p', 'center', 'Your service is scheduled for ' + PJ.longDate(p.job.service_date) + (p.job.service_window ? ', ' + p.job.service_window.toLowerCase() : '') + '.'));
    top.appendChild(el('p', 'center muted', 'Please save or print a copy now. This page stays available for 90 days.'));
    const b = el('div', 'row');
    b.style.justifyContent = 'center';
    const pr = el('button', 'primary', 'Save or print your copy (PDF)');
    pr.onclick = () => window.print();
    b.appendChild(pr);
    top.appendChild(b);
    const doc = el('div', 'doc');
    renderDoc(doc, res.document_text);
    const sig = el('div', 'card');
    sig.appendChild(el('h4', '', 'CUSTOMER SIGNATURE'));
    const img = el('img', 'sigimg'); img.src = res.signature; img.alt = 'Signature';
    sig.appendChild(img);
    sig.appendChild(el('p', '', res.signer_name + ' · signed electronically ' + new Date(res.signed_at).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })));
    main.append(doc, sig);
    if (r.notice.length) noticeCopies(r.notice, 2);
    document.title = 'Signed service agreement · ' + p.business.name;
  }

  function showToSign(res) {
    clear();
    const p = res.payload, tx = res.today;
    const b = p.business;
    $('bizName').textContent = b.name;
    const first = PJ.firstScheduleDate(tx);
    if (p.job.service_date < first) {
      message('This visit is too soon to sign online', 'Your service is scheduled for ' + PJ.longDate(p.job.service_date) +
        '. The 3-day cancellation period has to end before the visit, so this agreement can’t be signed online today. Please contact us to pick a new date.', b.phone);
      return;
    }
    const r = PJ.renderAgreement(ctxFor(p, tx));
    const intro = card();
    intro.appendChild(el('p', 'lead', 'Hi ' + (p.customer.first_name || 'there') + ', please review your service agreement with ' + b.name + ', then sign at the bottom.'));
    intro.appendChild(el('p', '', 'Total: ' + PJ.money(r.total_cents) + ' · Scheduled for ' + PJ.longDate(p.job.service_date) + (p.job.service_window ? ', ' + p.job.service_window.toLowerCase() : '') + '.'));
    intro.appendChild(el('p', 'muted', 'Please sign by ' + PJ.longDate(p.sign_by) + '. Questions? Call or text ' + b.phone + '.'));
    const doc = el('div', 'doc');
    renderDoc(doc, r.text);
    main.appendChild(doc);
    if (r.notice.length) {
      const n = el('div', 'doc notice');
      r.notice.forEach((line, i) => n.appendChild(el(i === 0 ? 'h4' : 'p', '', line)));
      n.appendChild(el('p', 'copy', 'You’ll get two copies of this notice on the next page after you sign.'));
      main.appendChild(n);
    }
    const k = card('Before you sign');
    const ticks = [];
    const tick = text => {
      const l = el('label', 'tick');
      const cb = el('input'); cb.type = 'checkbox';
      l.append(cb, el('span', '', text));
      k.appendChild(l);
      ticks.push(cb);
    };
    tick('I have read the whole agreement and the total price of ' + PJ.money(r.total_cents) + '.');
    if (T.timing && T.timing.scheduled_customer_tick) tick(PJ.fill(T.timing.scheduled_customer_tick, r.vars).replace(/^Customer: /, ''));
    tick('I agree to sign this agreement electronically and to receive it and the Notice of Cancellation electronically. I can print or save them from the next page.');
    const s = card('Your signature');
    s.appendChild(el('p', 'rtc', T.right_to_cancel));
    s.appendChild(el('label', 'fld', 'Your full name'));
    const name = el('input', 'text');
    name.value = PJ.fullName(p.customer); name.autocomplete = 'name'; name.maxLength = 100;
    s.appendChild(name);
    s.appendChild(el('label', 'fld', 'Sign with your finger in the box'));
    const pad = signaturePad();
    s.appendChild(pad.el);
    const cr = el('div', 'row');
    const clr = el('button', '', 'Clear signature');
    clr.onclick = () => pad.clear();
    cr.appendChild(clr);
    s.appendChild(cr);
    const err = el('p', 'err');
    s.appendChild(err);
    $('bar').hidden = false;
    const go = el('button', 'primary', 'Sign agreement — ' + PJ.money(r.total_cents));
    $('barIn').appendChild(go);
    go.onclick = async () => {
      err.textContent = '';
      if (ticks.some(t => !t.checked)) { err.textContent = 'Please tick each box under “Before you sign”.'; k.scrollIntoView({ behavior: 'smooth' }); return; }
      if (name.value.trim().length < 2) { err.textContent = 'Please enter your full name.'; name.focus(); return; }
      if (pad.empty()) { err.textContent = 'Please sign in the box with your finger.'; return; }
      go.disabled = true; go.textContent = 'Signing…';
      try {
        const sigPng = pad.png();
        const out = await rpc('sign_submit', {
          p_token: token, p_name: name.value.trim(), p_signature: sigPng, p_text: r.text, p_sha256: await sha256(r.text),
          p_cancel_by: r.cancel_by, p_total_cents: r.total_cents, p_transaction_date: tx,
          p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', p_device: (navigator.userAgent || '').slice(0, 160),
        });
        if (out && out.ok) {
          showSigned({ payload: p, signer_name: name.value.trim(), signature: sigPng, signed_at: out.signed_at, transaction_date: tx, document_text: r.text, cancel_by: r.cancel_by }, true);
          window.scrollTo(0, 0);
          return;
        }
        if (out && out.error === 'already_signed') { load(); return; }
        if (out && out.error === 'date') { err.textContent = 'The date changed while this page was open. Reloading…'; setTimeout(load, 1200); return; }
        throw new Error((out && out.error) || 'unknown');
      } catch (e) {
        err.textContent = 'Your agreement wasn’t signed yet (' + (e.message || e) + '). Please check your connection and try again.';
        go.disabled = false; go.textContent = 'Sign agreement — ' + PJ.money(r.total_cents);
      }
    };
  }

  async function load() {
    if (!token) { message('Link not complete', 'This signing link is missing part of its address. Please open the full link from your text or email.'); return; }
    let res;
    try { res = await rpc('sign_get', { p_token: token }); } catch (e) {
      message('Couldn’t load your agreement', 'Please check your internet connection and reload this page.'); return;
    }
    if (!res) return message('Link not found', 'This signing link isn’t valid. Please contact Prairie Lint Patrol for a new link.');
    if (res.status === 'signed') return showSigned(res, false);
    if (res.status === 'void') return message('This link was replaced', 'This agreement was changed or cancelled. Please use the newest link we sent you, or contact Prairie Lint Patrol.');
    if (res.status === 'expired') return message('This link has expired', 'The last day to sign online has passed. Please contact Prairie Lint Patrol to set a new date.');
    if (res.status === 'archived') return message('This agreement is archived', 'Online copies are kept for 90 days. Please contact Prairie Lint Patrol for a copy.');
    showToSign(res);
  }
  load();
})();
