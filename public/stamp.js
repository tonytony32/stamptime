/*
  Stamptime page logic. No build step, no dependencies.

  The page renders one Swarm postage stamp from one JSON document, described in api/stamp.schema.json:
    production:  GET {meta stamptime-api}/stamps/{batchId}
    demo:        ./examples/{name}.json when the URL has ?demo={name}

  The batch id comes from the last path segment (/stamp/{id}) or from ?id={id}.
  Everything visual (the bar, the ranking, the states, the Add time sheet, waiting for a top up) lives here.
  The backend only has to return the JSON.
*/
(function () {
  'use strict';

  // ---------- constants

  const DAY = 864e5;
  const MONTH_DAYS = 30.44;          // a block on the bar is a month, never labelled
  const SOON_DAYS = 14;              // "Expiring soon" at 14 days or less
  const BLOCK_SECONDS = 5;           // Gnosis block time
  const PRICE_ROUND_MS = 152 * BLOCK_SECONDS * 1000;   // the price can change at most once per 152 blocks
  const POLL_MS = 10000;             // while waiting for a top up
  const WAIT_MAX_MS = 10 * 60 * 1000;
  const OPTIONS = [{ days: 30, label: '30 days' }, { days: 182, label: '6 months' }, { days: 365, label: '1 year' }];
  const OUT = 'cubic-bezier(.23,1,.32,1)';       // things arriving
  const INOUT = 'cubic-bezier(.77,0,.175,1)';    // things moving on screen

  const meta = name => { const m = document.querySelector('meta[name="' + name + '"]'); return m ? m.content : null; };
  const API = (meta('stamptime-api') || '/api/v1').replace(/\/$/, '');
  const BEEPORT = meta('stamptime-beeport') || 'https://beeport.eth.limo/?topup={id}';
  const SCAN = 'https://gnosisscan.io';
  const EXPLORER = 'https://batch-explorer.github.io/batch/';
  const BADGE_JS = 'https://ethswarm.org/stamp/badge.js';
  const DONATE_JS = 'https://ethswarm.org/stamp/donate.js';

  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo');

  // ---------- small helpers

  const $ = id => document.getElementById(id);
  const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtNum = d => d.toLocaleDateString('en-GB');
  const fmtShort = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (h, a, b) => h ? (h.length > a + b + 1 ? h.slice(0, a) + '…' + (b ? h.slice(-b) : '') : h) : '';
  const money = n => n == null ? '' : '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US'));
  const bzz = n => n == null ? '' : (n < 100 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US')) + ' BZZ';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  // the last version of each stamp this visitor saw, kept in this browser only, so a reload can show what changed since.
  // nothing is sent anywhere and the page works the same without it
  const seen = {
    get(id) { try { return JSON.parse(localStorage.getItem('stamptime.seen.' + id)); } catch (e) { return null; } },
    set(s) { try { localStorage.setItem('stamptime.seen.' + s.batchId, JSON.stringify(s)); } catch (e) { /* storage off */ } }
  };
  const newSince = (base, s) => (s.contributions || []).filter(c => !(base.contributions || []).some(p => p.tx === c.tx));

  function batchIdFromUrl() {
    const raw = params.get('id') || location.pathname.split('/').filter(Boolean).pop() || '';
    const id = raw.toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(id) ? id : null;
  }

  // ---------- data

  async function load(id, demoName) {
    const name = demoName || DEMO;
    const url = name ? './examples/' + encodeURIComponent(name) + '.json' : API + '/stamps/' + id;
    const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
    // a stamp that does not exist is a normal answer: 200 with status not_found (a 404 carrying that body is accepted too).
    // any other 404 means the API is not where the page expects it, which is an error, not a missing stamp
    if (res.status === 404) {
      const body = await res.json().catch(() => null);
      if (body && body.status === 'not_found') return body;
      throw new Error('HTTP 404 from ' + url);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // one row per address: an address that topped up twice is one keeper with the days added up
  function keepersOf(s, youTx) {
    const by = new Map();
    (s.contributions || []).forEach(c => {
      const k = c.address.toLowerCase();
      const e = by.get(k) || { address: c.address, owner: false, days: 0, usd: 0, usdKnown: true, count: 0, last: null, you: false };
      e.days += c.days;
      if (c.usd == null) e.usdKnown = false; else e.usd += c.usd;
      if (c.kind === 'created') e.owner = true;
      if (youTx && c.tx === youTx) e.you = true;
      e.count++;
      if (!e.last || new Date(c.time) > new Date(e.last.time)) e.last = c;
      by.set(k, e);
    });
    return [...by.values()].sort((a, b) => b.days - a.days);
  }

  // ---------- state

  let stamp = null;          // the last JSON rendered
  let blockTimer = null, refreshTimer = null, waitTimer = null;

  // ---------- rendering

  function setState(name) { $('body').className = 'state-' + name; }

  function showNotice(html) { const n = $('notice'); n.innerHTML = html; n.hidden = false; }
  function hideNotice() { $('notice').hidden = true; }

  function renderLoading() {
    setState('loading'); hideNotice();
    $('days').textContent = '00'; $('pill').textContent = 'Reading';
    $('until').textContent = 'Reading Gnosis…';
    $('seg').style.setProperty('--n', 3); $('seg').innerHTML = '<i></i><i></i><i></i>';
    $('rank').innerHTML = '<li><span class="pos"></span><span class="who">Reading the history…</span><span class="amt"></span></li>';
    $('addBtn').disabled = true;
  }

  function renderMissing(id) {
    setState('missing');
    const looked = id ? '<p class="mono">' + esc(id) + '</p>' : '';
    showNotice(
      '<h2>' + (id ? 'No stamp with this id' : 'Which stamp?') + '</h2>' + looked +
      '<p>' + (id
        ? 'It may be a typo in the link, or it was never created on Gnosis. Check the link, or look it up on Batch Explorer.'
        : 'Add a batch id to the address, as /stamp/&lt;id&gt; or ?id=&lt;id&gt;.') + '</p>' +
      '<div class="actions">' +
        (id ? '<a class="btn" href="' + EXPLORER + esc(id) + '" target="_blank" rel="noopener">Look it up on Batch Explorer</a>' : '') +
        '<a class="btn" href="?demo=active">See a demo</a>' +
      '</div>');
  }

  function renderError(id) {
    setState('error');
    showNotice(
      '<h2>Could not read the stamp</h2>' +
      '<p>The stamp service did not answer. The stamp itself may be fine: it lives on Gnosis, not here.</p>' +
      '<div class="actions">' +
        '<button class="btn" type="button" id="retry">Try again</button>' +
        (id ? '<a class="btn" href="' + EXPLORER + esc(id) + '" target="_blank" rel="noopener">Check on Batch Explorer</a>' : '') +
      '</div>');
    $('retry').addEventListener('click', () => start());
  }

  function render(s, mode, youTx) {
    // for an update, measure what is on screen before anything changes, so it can move from there
    const before = mode === 'update' && stamp && stamp.status === 'active' ? measure() : null;
    stamp = s; hideNotice();
    if (s.status === 'not_found') return renderMissing(s.batchId);

    const dead = s.status === 'expired';
    const now = new Date(s.chain.blockTime);
    const created = new Date(s.created.time);
    const end = s.expiry && s.expiry.time ? new Date(s.expiry.time) : null;
    const daysLeft = dead || !end ? 0 : Math.max(0, Math.round((end - now) / DAY));
    const fuzz = !dead && s.expiry.earliest && s.expiry.latest
      ? Math.max(1, Math.round((new Date(s.expiry.latest) - new Date(s.expiry.earliest)) / DAY / 2)) : 0;
    const soon = !dead && daysLeft <= SOON_DAYS;
    setState(dead ? 'expired' : soon ? 'soon' : 'paid');

    // the number and the sentence
    $('stampShort').textContent = short(s.batchId, 8, 7);
    $('days').textContent = daysLeft;
    $('daysLabel').textContent = daysLeft === 1 ? 'day left' : 'days left';
    $('pill').textContent = dead ? 'Expired' : soon ? 'Expiring soon' : 'Paid';
    $('until').innerHTML = dead
      ? (end ? 'Ran out around <b>' + fmt(end) + '</b>. Time can no longer be added to it.' : 'Ran out. Time can no longer be added to it.')
      : 'Paid until about <b>' + fmt(end) + '</b>' + (fuzz ? ', give or take ' + fuzz + (fuzz === 1 ? ' day' : ' days') : '') + ', at today\'s price.';
    $('nervous').textContent = dead
      ? 'Nobody did. What it covered is no longer kept by the network.'
      : 'Nobody is obliged to keep it paid. If nobody does, what it covers stops being kept around ' + fmtShort(end) + '. Anyone can add time; the owner stays the owner.';

    renderBar(s, { now, created, end: end || now, dead, fuzz }, mode === 'enter');
    renderKeepers(s, dead, youTx);
    renderDetails(s, { now, created, end, dead, fuzz });
    renderSheet(s, end);

    // the tile
    $('addBtn').disabled = dead;
    $('addSub').textContent = dead ? 'the stamp has run out' : 'Extend with any wallet';

    // the block, ticking every five seconds while the stamp is paying
    const lag = DEMO ? 0 : Math.max(0, Math.floor((Date.now() - now) / 1000));
    let block = s.chain.block + Math.floor(lag / BLOCK_SECONDS), ago = lag;
    const paint = () => {
      $('hdrBlock').textContent = block; $('footBlock').textContent = block;
      $('readLine').textContent = ago + ' s ago, re read once per price round';
    };
    $('readBlock').textContent = '#' + s.chain.block;
    $('beatLine').textContent = dead
      ? (s.expiry && s.expiry.lastBlock ? 'went by, storers stopped being paid at block ' + s.expiry.lastBlock : 'went by')
      : 'just paid for five more seconds';
    paint();
    clearInterval(blockTimer);
    if (!dead) blockTimer = setInterval(() => { block++; ago += BLOCK_SECONDS; paint(); }, BLOCK_SECONDS * 1000);

    seen.set(s);
    if (before) play(before);
  }

  // the bar: the whole life of the stamp, one block per month, always filling the width.
  // spent time veiled, today as the line, the time ahead bright, the estimate dissolving across the end
  function renderBar(s, t, enter) {
    const seg = $('seg');
    const spentM = ((t.dead ? t.end : t.now) - t.created) / DAY / MONTH_DAYS;
    const endM = (t.end - t.created) / DAY / MONTH_DAYS;
    // the dissolve is the estimate band, never thinner than a tenth of the bar, so it reads as a fade and not as an edge
    const n0 = Math.max(1, Math.ceil(endM + (t.dead ? 0 : t.fuzz / MONTH_DAYS)));
    const fuzzM = t.dead ? 0 : Math.max(t.fuzz / MONTH_DAYS, n0 * 0.1);
    // one global ramp centred on the likeliest end; each block gets its own slice of it
    const fadeStart = endM - fuzzM / 2, fadeEnd = endM + fuzzM / 2, lifeM = t.dead ? endM : fadeEnd;
    const alpha = x => t.dead ? 1 : Math.max(0, Math.min(1, (fadeEnd - x) / (fadeEnd - fadeStart)));
    const N = Math.max(1, Math.ceil(lifeM));

    seg.style.setProperty('--n', N);
    seg.innerHTML = '';
    const fills = [];
    for (let k = 0; k < N; k++) {
      const blk = document.createElement('i');
      if (lifeM - k > 0) {
        const f = document.createElement('b'); f.className = 'fill';
        const A = Math.max(0, Math.min(1, fadeStart - k)), B = Math.max(0, Math.min(1, fadeEnd - k));
        const g = 'linear-gradient(90deg, rgba(0,0,0,' + alpha(k) + ') 0%, rgba(0,0,0,' + alpha(k + A) + ') ' + (A * 100) + '%, rgba(0,0,0,' + alpha(k + B) + ') ' + (B * 100) + '%, rgba(0,0,0,' + alpha(k + 1) + ') 100%)';
        f.style.webkitMask = g; f.style.mask = g;
        blk.appendChild(f);
        fills.push(f);
      }
      const q = Math.max(0, Math.min(1, spentM - k));
      if (q > 0 && !t.dead) { const v = document.createElement('b'); v.className = 'spent'; v.style.setProperty('--q', (q * 100) + '%'); blk.appendChild(v); }
      if (!t.dead && spentM >= k && spentM < k + 1) { blk.className = 'now'; blk.style.setProperty('--x', ((spentM - k) * 100) + '%'); }
      seg.appendChild(blk);
    }
    if (enter && !t.dead && !reduced()) {
      // first sight: the months add up one by one, each settling in from a little smaller, never from nothing
      fills.forEach((f, i) => f.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 320, easing: OUT, delay: i * 40, fill: 'both' }));
    }
    $('startCap').textContent = 'Created ' + fmtShort(t.created);
    $('endCap').textContent = t.dead ? (s.expiry && s.expiry.time ? 'ran out ' + fmtShort(t.end) : '') : '~' + fmtShort(t.end);
  }

  // the names, ranked by days given, with the open slot at the end
  function renderKeepers(s, dead, youTx) {
    const list = $('rank'); list.innerHTML = '';
    const ranked = keepersOf(s, youTx);
    const recent = stamp && stamp.chain ? new Date(stamp.chain.blockTime) - 3600e3 : 0;
    ranked.forEach((k, i) => {
      const when = fmtShort(new Date(k.last.time));
      const what = k.owner
        ? (k.count > 1 ? 'Owner, created it and kept it alive ' + (k.count - 1) + (k.count === 2 ? ' time' : ' times') + ', last ' + when : 'Owner, created the stamp, ' + when)
        : (k.you && new Date(k.last.time) >= recent ? 'Kept it alive, just now' : k.count > 1 ? 'Kept it alive ' + k.count + ' times, last ' + when : 'Kept it alive, ' + when);
      const who = k.you ? '<span>You</span>' : '<a class="lnk" href="' + SCAN + '/address/' + esc(k.address) + '" target="_blank" rel="noopener">' + esc(short(k.address, 6, 4)) + '</a>';
      const tx = '<a class="lnk" href="' + SCAN + '/tx/' + esc(k.last.tx) + '" target="_blank" rel="noopener">' + esc(short(k.last.tx, 8, 0)) + '</a>';
      const li = document.createElement('li'); if (k.you) li.className = 'you';
      li.dataset.key = k.address.toLowerCase();
      li.innerHTML = '<span class="pos">' + (i + 1) + '</span>' +
        '<span class="who">' + who + '<small>' + esc(what) + ' · tx ' + tx + '</small></span>' +
        '<span class="amt">' + Math.round(k.days) + ' days' + (!dead && k.usdKnown ? '<span class="usd">' + money(k.usd) + '</span>' : '') + '</span>';
      list.appendChild(li);
    });
    if (!dead) {
      const per = s.pricing && s.pricing.usdPerDay;
      const li = document.createElement('li'); li.className = 'slot'; li.dataset.key = 'slot';
      li.innerHTML = '<span class="pos">' + (ranked.length + 1) + '</span><span class="who">Open<small>Keep it alive: 30 days' + (per ? ' from about ' + money(per * 30) : '') + ', any wallet</small></span><span class="amt"><button type="button" class="btn slotBtn">Take it</button></span>';
      list.appendChild(li);
      li.querySelector('.slotBtn').addEventListener('click', () => openSheet(true));
    }
  }

  // ---------- new time arriving: from what was on screen to what is on chain now

  function measure() {
    const rect = el => el.getBoundingClientRect();
    return {
      bar: [...$('seg').children].map(b => { const r = rect(b); return { left: r.left, width: r.width }; }),
      rows: new Map([...$('rank').children].map(li => [li.dataset.key, rect(li).top])),
      rankH: rect($('rank')).height,
      days: parseInt($('days').textContent, 10) || 0
    };
  }

  function countTo(el, from, to) {
    el.textContent = from;
    const t0 = performance.now(), dur = 720;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4);
      el.textContent = Math.round(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    // a tab in the background pauses animation frames: make sure the number always ends on its value
    setTimeout(() => { el.textContent = to; }, dur + 80);
  }

  // a new keeper arrives as a card: it appears on the open slot it just took, rises over the list to its rank,
  // lands, keeps a tint for a moment, then becomes a row like the others. opaque early, so it covers the rows it passes
  function arrive(li, delay, dy) {
    li.classList.add('card', 'lift');
    li.animate([
      { transform: 'translateY(' + dy + 'px) scale(.97)', opacity: 0 },
      { opacity: 1, offset: .22 },
      { transform: 'none', opacity: 1 }
    ], { duration: 680, easing: INOUT, delay, fill: 'backwards' });
    setTimeout(() => { li.classList.remove('lift'); li.classList.add('tint'); }, delay + 820);
    setTimeout(() => li.classList.remove('tint'), delay + 2000);
    setTimeout(() => li.classList.remove('card'), delay + 3000);
  }

  function play(before) {
    const list = $('rank'), rows = [...list.children];
    if (reduced()) {
      // no movement: the new keeper fades in, everything else is simply there
      rows.forEach(li => { if (!before.rows.has(li.dataset.key)) li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease' }); });
      return;
    }

    // the number counts up to the new total, and the sentence sharpens into its new date
    countTo($('days'), before.days, parseInt($('days').textContent, 10) || 0);
    [$('until'), $('endCap')].forEach(el => el.animate([{ filter: 'blur(4px)', opacity: .35 }, { filter: 'blur(0)', opacity: 1 }], { duration: 380, easing: OUT }));

    // the bar: the months already there glide narrower to make room, then the new months settle in at the end
    const seg = $('seg'), blocks = [...seg.children], oldN = before.bar.length;
    seg.classList.add('morphing');
    let settleFrom = oldN;
    if (blocks.length > oldN) {
      blocks.slice(0, oldN).forEach((b, k) => {
        const r = b.getBoundingClientRect(), o = before.bar[k];
        b.style.transformOrigin = 'left center';
        b.animate([{ transform: 'translateX(' + (o.left - r.left) + 'px) scaleX(' + (o.width / r.width) + ')' }, { transform: 'none' }], { duration: 560, easing: INOUT });
      });
    } else {
      settleFrom = blocks.length - 1;   // the new time fits in the last month: that block refreshes in place
    }
    const fresh = blocks.slice(settleFrom);
    fresh.forEach((b, i) => b.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 340, easing: OUT, delay: 440 + i * 45, fill: 'backwards' }));
    setTimeout(() => seg.classList.remove('morphing'), 440 + fresh.length * 45 + 260);

    // the ranking: the list grows by one row, the others slide down to their new place, the new keeper rises into the gap
    const h = list.getBoundingClientRect().height;
    if (Math.abs(h - before.rankH) > 0.5) list.animate([{ height: before.rankH + 'px' }, { height: h + 'px' }], { duration: 560, easing: INOUT });
    let n = 0;
    rows.forEach(li => {
      if (before.rows.has(li.dataset.key)) {
        const dy = before.rows.get(li.dataset.key) - li.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) li.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 560, easing: INOUT });
      } else {
        const from = before.rows.has('slot') ? before.rows.get('slot') - li.getBoundingClientRect().top : 22;
        arrive(li, 120 + n++ * 90, from);
      }
    });
  }

  function renderDetails(s, t) {
    $('batchId').textContent = s.batchId;
    $('ownerLink').textContent = short(s.owner, 6, 4);
    $('ownerLink').href = SCAN + '/address/' + s.owner;
    $('capacity').textContent = s.capacity;
    $('depth').textContent = s.depth;
    $('immutable').textContent = s.immutable ? 'Yes' : 'No';
    $('createdRow').innerHTML = esc(fmtNum(t.created)) + ' <a class="chip" style="text-decoration:none" href="' + SCAN + '/block/' + s.created.block + '" target="_blank" rel="noopener">#' + s.created.block + '</a>';
    $('expiryRow').innerHTML = t.dead
      ? (t.end ? 'around ' + fmtNum(t.end) + ' <span class="ui" style="color:var(--muted)">ran out</span>' : '<span class="ui" style="color:var(--muted)">ran out</span>')
      : 'about ' + fmtNum(t.end) + ' <span class="ui" style="color:var(--muted)">' + (t.fuzz ? 'give or take ' + t.fuzz + (t.fuzz === 1 ? ' day' : ' days') + ', ' : '') + 'at today\'s price</span>';
    $('rpc').textContent = s.chain.rpc || '';
    $('contract').textContent = s.chain.contract;
    $('eventsLink').href = EXPLORER + s.batchId;
    $('contractLink').href = SCAN + '/address/' + s.chain.contract + '#code';
    $('badgeDate').textContent = t.end ? fmt(t.end) : 'expired';
    $('badgeCode').textContent = '<script src="' + BADGE_JS + '" data-batch="' + s.batchId + '"></script>';
    $('donateCode').textContent = '<script src="' + DONATE_JS + '" data-batch="' + s.batchId + '"></script>';
    $('donateOwner').textContent = short(s.owner, 6, 4);
  }

  // the Add time sheet: three durations, priced from today's price, each added to the current end.
  // the only place on the page that shows BZZ, always with its dollar equivalent underneath
  function renderSheet(s, end) {
    const per = s.pricing && s.pricing.usdPerDay;
    const perBzz = s.pricing && s.pricing.bzzPerDay;
    $('sheetLead').textContent = 'Extends the whole stamp, ' + s.capacity + ', for everyone who uses it. It does not make it yours.';
    const opts = $('opts'); opts.innerHTML = '';
    OPTIONS.forEach((o, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', i === 1 ? 'true' : 'false'); b.dataset.days = o.days;
      const to = end ? new Date(end.getTime() + o.days * DAY) : null;
      const price = perBzz
        ? '<b>≈ ' + bzz(perBzz * o.days) + '</b>' + (per ? '<small>≈ ' + money(per * o.days) + '</small>' : '')
        : (per ? '<b>≈ ' + money(per * o.days) + '</b>' : '');
      b.innerHTML = '<span><b>' + o.label + '</b><small>' + (to ? 'to about ' + fmt(to) : '') + '</small></span><span class="usdv">' + price + '</span>';
      b.addEventListener('click', () => opts.querySelectorAll('.opt').forEach(x => x.setAttribute('aria-checked', x === b ? 'true' : 'false')));
      opts.appendChild(b);
    });
  }

  // ---------- the Add time hand off, and waiting for the chain to confirm it

  const sheet = $('sheet'), scrim = $('scrim');
  function openSheet(v) {
    if (v && (!stamp || stamp.status !== 'active')) return;
    sheet.hidden = !v; scrim.hidden = !v;
    if (v) $('go').focus();
  }
  $('addBtn').addEventListener('click', () => openSheet(true));
  $('cancel').addEventListener('click', () => openSheet(false));
  scrim.addEventListener('click', () => openSheet(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) openSheet(false); });

  $('go').addEventListener('click', async () => {
    openSheet(false);
    const url = BEEPORT.replace('{id}', stamp.batchId);
    // open the tab inside the click, so popup blockers allow it; it is pointed at Beeport after the pre flight
    const tab = DEMO ? null : window.open('about:blank', '_blank');
    let fresh = stamp;
    try { if (!DEMO) fresh = await load(stamp.batchId); } catch (e) { /* use what we have */ }
    if (fresh.status !== 'active') {
      if (tab) tab.close();
      render(fresh, false);
      return toast('This stamp has run out. Time can no longer be added to it.');
    }
    const h = { id: fresh.batchId, at: Date.now(), end: fresh.expiry.time, txs: (fresh.contributions || []).map(c => c.tx) };
    store.set('stamptime.handoff', h);
    if (tab) { tab.opener = null; tab.location.href = url; }
    else if (!DEMO) { location.href = url; return; }
    waitFor(h);
  });

  function setWaiting(on, text) {
    $('waiting').hidden = !on;
    if (text) $('waitingText').textContent = text;
    $('addBtn').disabled = on || !stamp || stamp.status !== 'active';
    document.querySelectorAll('.slotBtn').forEach(b => b.disabled = on);
  }

  function waitFor(h) {
    setWaiting(true, 'Waiting for Gnosis to confirm your top up. Usually under a minute.');
    window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    clearTimeout(waitTimer);
    const tick = async () => {
      let s;
      try { s = await load(h.id, DEMO ? 'topped' : null); } catch (e) { s = null; }
      const grew = s && s.status === 'active' && s.expiry && new Date(s.expiry.time) > new Date(h.end);
      if (grew) {
        const mine = (s.contributions || []).filter(c => h.txs.indexOf(c.tx) < 0).sort((a, b) => new Date(b.time) - new Date(a.time))[0];
        if (mine) store.set('stamptime.you', { id: h.id, tx: mine.tx });
        store.del('stamptime.handoff');
        setWaiting(false);
        render(s, 'update', mine && mine.tx);
        const added = Math.round((new Date(s.expiry.time) - new Date(h.end)) / DAY);
        return toast('Added ' + added + ' days. Paid until about ' + fmt(new Date(s.expiry.time)) + '.');
      }
      if (Date.now() - h.at > WAIT_MAX_MS) {
        store.del('stamptime.handoff');
        setWaiting(false);
        return toast('Not seen on chain yet. Check Batch Explorer in a minute.');
      }
      waitTimer = setTimeout(tick, DEMO ? 2500 : POLL_MS);
    };
    waitTimer = setTimeout(tick, DEMO ? 2500 : POLL_MS);
  }

  // ---------- copy, toast

  function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => el.hidden = true, 3500); }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]'); if (!b || !stamp) return;
    const text = b.dataset.copy === 'owner' ? stamp.owner : stamp.batchId;
    const done = () => toast(b.dataset.copy === 'owner' ? 'Owner address copied' : 'Batch id copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast(text)); else toast(text);
  });

  // ---------- start

  async function start(demoName) {
    const id = batchIdFromUrl();
    const name = demoName || DEMO;
    clearInterval(refreshTimer);
    if (!name && !id) return renderMissing(null);
    if (name === 'loading') return renderLoading();
    if (name === 'error') return renderError(id);
    if (!stamp) renderLoading();
    let s;
    try { s = await load(id, name); } catch (e) { return renderError(id); }
    const you = store.get('stamptime.you');
    const yours = you && you.id === s.batchId ? you.tx : null;
    const onScreen = stamp && stamp.status === 'active' && stamp.batchId === s.batchId ? stamp : null;
    const remembered = onScreen ? null : seen.get(s.batchId);
    const base = onScreen || remembered;
    const added = base && base.status === 'active' && s.status === 'active' ? newSince(base, s) : [];
    const gained = added.length ? Math.round((new Date(s.expiry.time) - new Date(base.expiry.time)) / DAY) : 0;
    if (added.length && onScreen) {
      // already on screen (the demo's "After top up"): the new time arrives in place, as if it were yours
      const tx = name === 'topped' ? added[added.length - 1].tx : yours;
      render(s, 'update', tx);
      toast('Added ' + gained + ' days. Paid until about ' + fmt(new Date(s.expiry.time)) + '.');
    } else if (added.length && remembered) {
      // seen before, in this browser: show it as it was for a beat, then let the new time arrive
      render(remembered, false, yours);
      setTimeout(() => {
        render(s, 'update', yours);
        toast(yours && added.some(c => c.tx === yours) ? 'Your top up landed: ' + gained + ' days added.' : 'Since you last looked, ' + gained + ' days were added.');
      }, reduced() ? 0 : 520);
    } else {
      render(s, onScreen ? false : 'enter', yours);
    }

    // resume waiting after a reload or a same tab hand off
    const h = store.get('stamptime.handoff');
    if (h && h.id === s.batchId && Date.now() - h.at < WAIT_MAX_MS && s.status === 'active') waitFor(h);

    // re read once per price round
    if (!name && s.status !== 'not_found') refreshTimer = setInterval(async () => {
      try {
        const r = await load(s.batchId);
        const fresh = stamp && stamp.status === 'active' && r.status === 'active' && newSince(stamp, r).length;
        render(r, fresh ? 'update' : false, yours);
      } catch (e) { /* keep what is on screen */ }
    }, PRICE_ROUND_MS);
  }

  // the demo bar, only with ?demo=
  if (DEMO && params.get('bare') !== '1') {
    const bar = $('devbar'); bar.hidden = false;
    const press = n => bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.demo === n ? 'true' : 'false'));
    press(DEMO);
    bar.addEventListener('click', e => {
      const b = e.target.closest('button[data-demo]'); if (!b) return;
      press(b.dataset.demo); setWaiting(false); clearTimeout(waitTimer);
      if (['loading', 'error', 'not_found'].indexOf(b.dataset.demo) >= 0) stamp = null;
      start(b.dataset.demo);
    });
  }

  start();
})();
