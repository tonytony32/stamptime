/*
  Stamptime: the page logic. No build step, no dependencies.

  The page renders one Swarm postage stamp from one JSON document, described in api/stamp.schema.json:
    production   read from Gnosis in the browser by chain.js, through the RPCs in meta stamptime-rpc,
                 or GET {meta stamptime-api}/stamps/{batchId} when that meta tag is there
    demo         ./examples/{name}.json, when the URL has ?demo={name}

  The batch id comes from ?id= when present, otherwise from the last path segment (/stamp/{id}).
  Everything visual lives here; chain.js, or an API, only has to produce the JSON.

  The file reads top to bottom:
     1. Configuration            6. Motion: new time arriving
     2. Helpers                  7. Adding time: the preview under the bar
     3. Reading a stamp          8. Feedback: toast, announcements, copy
     4. Page state and timers    9. Loading and keeping fresh
     5. Rendering               10. Wiring
*/
(function () {
  'use strict';

  // ---------- 1. Configuration

  const DAY_MS = 864e5;
  const MONTH_DAYS = 30.44;                    // a block on the bar is a month, never labelled
  const SOON_DAYS = 14;                        // "Expiring soon" is a page rule, not an API status
  const BLOCK_SECONDS = 5;                     // Gnosis block time
  const PRICE_ROUND_MS = 152 * BLOCK_SECONDS * 1000;   // the price changes at most once per 152 blocks: re read that often
  const FETCH_TIMEOUT_MS = 10 * 1000;          // a read still out after this shows the error state, with Try again
  const TOAST_MS = 3500;
  const TOAST_LONG_MS = 10 * 1000;             // long enough to copy a value by hand

  // Adding time's three stretches, previewed on the bar. Half a year starts selected.
  const DURATIONS = [
    { days: 30, name: 'A month' },
    { days: 182, name: 'Half a year' },
    { days: 365, name: 'A year' }
  ];
  const DEFAULT_DAYS = 182;

  const readMeta = name => { const meta = document.querySelector('meta[name="' + name + '"]'); return meta ? meta.content : null; };
  // Where the stamp comes from: Gnosis itself, through the first of these RPCs that answers, unless an API is set (see
  // fetchStamp). Both defaults answer eth_getLogs over a batch's whole history; many public RPCs cap the range.
  const RPCS = (readMeta('stamptime-rpc') || 'https://rpc.gnosis.gateway.fm https://rpc.gnosischain.com').split(/\s+/).filter(Boolean);
  const API = (readMeta('stamptime-api') || '').replace(/\/$/, '') || null;
  const GNOSISSCAN = 'https://gnosisscan.io';
  const BATCH_EXPLORER = 'https://batch-explorer.github.io/batch/';
  const BADGE_JS = 'https://ethswarm.org/stamp/badge.js';

  // What this browser remembers. Nothing is ever sent anywhere.
  const KEYS = {
    seen: id => 'stamptime.seen.' + id         // localStorage: the last version of each stamp shown
  };

  const params = new URLSearchParams(location.search);
  const DEMOS = ['active', 'topped', 'expiring', 'expired', 'not_found', 'loading', 'error'];
  const DEMO = DEMOS.includes(params.get('demo')) ? params.get('demo') : null;

  // Motion. EASE_OUT for things arriving, EASE_IN_OUT for things moving on screen. Durations in ms.
  const EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
  const EASE_IN_OUT = 'cubic-bezier(.77,0,.175,1)';
  const MOTION = {
    enter: { duration: 420, stagger: 70, spread: 480 },            // first sight: the months fill in from the left, one by one
    glide: { duration: 560 },                                      // rows and the list moving to their new place
    arrival: { duration: 560, easing: EASE_IN_OUT, stagger: 45, staggerMax: 360 },   // the bar making room for new time
    sharpen: { duration: 380 },                                    // the sentence blurring into its new date
    count: { duration: 720 },                                      // the number counting up
    card: { duration: 680, delay: 120, stagger: 90, rise: 22,     // a new keeper rising to its rank
      lands: 820, untint: 2000, done: 3000 },                      // done outlasts the .9s tint fade in stamp.css
    fade: { duration: 240 },                                       // reduced motion: the new keeper only fades in
    preview: { duration: 300, easing: EASE_OUT, stagger: 18, staggerMax: 160,   // the bar following a pick in Adding time: quick,
      enter: 240, exit: 150, swap: 180 },                          // it follows a hand. Pieces coming, going, changing
    toast: { enter: 240, exit: 160 },
    replay: 520                                                    // how long a remembered version shows before the new time arrives
  };


  // ---------- 2. Helpers: no page state

  const $ = id => document.getElementById(id);
  // Writes only when the element is there.
  const setDisabled = (id, on) => { const el = $(id); if (el) el.disabled = on; };
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const daysBetween = (from, to) => (to - from) / DAY_MS;
  const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const formatDate = date => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });   // 27 Dec 2026
  const formatDayMonth = date => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });              // 27 Dec
  const formatNumericDate = date => date.toLocaleDateString('en-GB');                                                // 27/12/2026
  const formatBzz = n => (n < 100 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US')) + ' BZZ';
  const formatBzzPrice = n => Number(n.toPrecision(3)).toLocaleString('en-US') + ' BZZ';                           // 1.14 BZZ, 0.174 BZZ
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const formatDays = days => Math.round(days) < 1 ? 'under a day' : plural(Math.round(days), 'day');
  // The head and tail of a hash, which is how people check one: 0x1F3a…9bC4
  const abbreviate = (hash, head, tail) => hash.length > head + tail + 1 ? hash.slice(0, head) + '…' + (tail ? hash.slice(-tail) : '') : hash;

  // Markup with every interpolated value escaped. Nested html`` results, and arrays of them, go in as markup.
  // The result can be assigned to innerHTML as it is.
  class Markup {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
  }
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ESCAPES[c]);
  const toMarkup = value => value instanceof Markup ? value.text : Array.isArray(value) ? value.map(toMarkup).join('') : escapeHtml(value);
  const html = (strings, ...values) => new Markup(strings.reduce((out, text, i) => out + toMarkup(values[i - 1]) + text));

  // Every link that leaves the page opens a new tab. `points` says what a bare hash points at, for screen readers.
  const externalLink = (href, text, className, points) => points
    ? html`<a class="${className}" href="${href}" target="_blank" rel="noopener" aria-label="${text}, ${points}">${text}</a>`
    : html`<a class="${className}" href="${href}" target="_blank" rel="noopener">${text}</a>`;

  // Storage that never throws: with storage blocked or in private mode, the page simply remembers nothing.
  const storageIn = area => ({
    get(key) { try { return JSON.parse(area().getItem(key)); } catch (e) { return null; } },
    set(key, value) { try { area().setItem(key, JSON.stringify(value)); } catch (e) { /* storage off */ } }
  });
  const local = storageIn(() => localStorage);


  // ---------- 3. Reading a stamp: JSON in, plain values out, no DOM

  const PATTERNS = { batchId: /^[0-9a-f]{64}$/, address: /^0x[0-9a-fA-F]{40}$/, tx: /^0x[0-9a-fA-F]{64}$/ };
  const isTime = value => typeof value === 'string' && !isNaN(Date.parse(value));
  const isTimeOrNull = value => value == null || isTime(value);
  const isNumberOrNull = value => value == null || typeof value === 'number';
  const isActive = stamp => Boolean(stamp) && stamp.status === 'active';

  // The batch id in the URL, from ?id= or the last path segment, forgiving stray punctuation after it. Without a
  // valid one, `asked` is whatever looked like an id, to show back, or null when there was none (a bare /stamp/).
  function idFromUrl() {
    const raw = params.get('id') || location.pathname.split('/').filter(Boolean).pop() || '';
    const id = raw.toLowerCase().replace(/^0x/, '').replace(/[^0-9a-z]+$/, '');
    if (PATTERNS.batchId.test(id)) return { id, asked: null };
    const looksLikeOne = Boolean(params.get('id')) || /[0-9a-f]{8,}/i.test(raw);
    return { id: null, asked: looksLikeOne ? raw : null };
  }

  // One stamp document. Rejects on network errors, timeouts, HTTP errors and documents the page cannot draw.
  async function fetchStamp(id, demo, timeoutMs = FETCH_TIMEOUT_MS) {
    if (!demo && !API) return checked(await readFromChain(id, timeoutMs), id);
    const url = demo ? './examples/' + demo + '.json' : API + '/stamps/' + id;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: abort.signal });
      // A stamp that does not exist is a normal answer: 200 with status not_found (a 404 carrying that body is
      // accepted too). Any other 404 means the API is not where the page expects it: an error, not a missing stamp.
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        if (body && body.status === 'not_found') return checked(body, demo ? null : id);
        throw new Error('HTTP 404 from ' + url);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return checked(await res.json(), demo ? null : id);
    } finally {
      clearTimeout(timer);
    }
  }

  // The stamp read from Gnosis by chain.js. It loads, and viem with it, only when a real stamp is asked for, so the
  // demo never touches the chain. viem is asked for at the same time as chain.js, not once chain.js asks for it, which
  // saves a round trip before the first read. It asks for no dollars, since the page shows none.
  async function readFromChain(id, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Gnosis did not answer in time')), timeoutMs); });
    try {
      const [chain] = await Promise.race([Promise.all([import('./chain.js'), import('./vendor/viem.js')]), timeout]);
      return await Promise.race([chain.readStamp(id, { rpcs: RPCS, withUsd: false }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // The parts of the contract the page relies on for arithmetic, links and markup. A document that breaks them
  // shows the error state instead of a half drawn page. `id`, when given, is the stamp that was asked for.
  function checked(doc, id) {
    if (!doc || !PATTERNS.batchId.test(doc.batchId) || (id && doc.batchId !== id)) throw new Error('Not the stamp asked for');
    if (doc.status === 'not_found') return doc;
    const { chain, created, expiry, pricing, contributions } = doc;
    const drawable = [
      doc.status === 'active' || doc.status === 'expired',
      chain && Number.isInteger(chain.block) && isTime(chain.blockTime) && PATTERNS.address.test(chain.contract),
      PATTERNS.address.test(doc.owner),
      created && Number.isInteger(created.block) && isTime(created.time),
      expiry && (doc.status === 'active' ? isTime(expiry.time) : isTimeOrNull(expiry.time)),
      expiry && isTimeOrNull(expiry.earliest) && isTimeOrNull(expiry.latest),
      !pricing || (isNumberOrNull(pricing.bzzPerDay) && isNumberOrNull(pricing.usdPerDay)),
      Array.isArray(contributions) && contributions.every(c => c && PATTERNS.address.test(c.address) &&
        PATTERNS.tx.test(c.tx) && isTime(c.time) && typeof c.days === 'number' && isNumberOrNull(c.usd) && isNumberOrNull(c.bzz))
    ].every(Boolean);
    if (!drawable) throw new Error('A stamp document the page cannot draw');
    return doc;
  }

  // What the page shows, worked out once per render and handed to the render* functions.
  function describe(stamp) {
    const expired = stamp.status === 'expired';
    const now = new Date(stamp.chain.blockTime);
    const created = new Date(stamp.created.time);
    const end = stamp.expiry.time ? new Date(stamp.expiry.time) : null;
    const { earliest, latest } = stamp.expiry;
    const daysLeft = expired ? 0 : Math.max(0, Math.round(daysBetween(now, end)));
    // "give or take": half the range between the ends at the highest and at the lowest recent price
    const giveOrTake = !expired && earliest && latest
      ? Math.max(1, Math.round(daysBetween(new Date(earliest), new Date(latest)) / 2)) : 0;
    return {
      expired, now, created, end, daysLeft, giveOrTake,
      soon: !expired && daysLeft <= SOON_DAYS,
      barEnd: end || paidUntil(stamp, created, now)
    };
  }

  // An expired stamp whose end cannot be reconstructed: the bar shows roughly the time its payments bought, never
  // past today. Rough, because later price changes and depth increases are not taken into account.
  function paidUntil(stamp, created, now) {
    const paid = daysIn(stamp.contributions);
    return paid ? new Date(Math.min(now.getTime(), created.getTime() + paid * DAY_MS)) : now;
  }

  // The ranking: one row per address, days and BZZ added up, most days first. Owner is the batch owner from
  // the document; whoever paid for BatchCreated may be someone else, such as a relayer.
  function keepersOf(stamp) {
    const ownerKey = stamp.owner.toLowerCase();
    const byAddress = new Map();
    for (const c of stamp.contributions) {
      const key = c.address.toLowerCase();
      const keeper = byAddress.get(key) ||
        { key, address: c.address, owner: key === ownerKey, created: false, days: 0, bzz: 0, bzzKnown: true, payments: 0, last: null };
      keeper.days += c.days;
      if (c.bzz == null) keeper.bzzKnown = false; else keeper.bzz += c.bzz;
      if (c.kind === 'created') keeper.created = true;
      keeper.payments++;
      if (!keeper.last || new Date(c.time) > new Date(keeper.last.time)) keeper.last = c;
      byAddress.set(key, keeper);
    }
    return [...byAddress.values()].sort((a, b) => b.days - a.days);
  }

  const txsOf = stamp => stamp.contributions.map(c => c.tx);
  const contributionsSince = (txs, stamp) => stamp.contributions.filter(c => !txs.includes(c.tx));
  const daysIn = contributions => contributions.reduce((sum, c) => sum + c.days, 0);
  // What `stamp` has that `base` did not. Time only arrives between two active versions.
  const addedSince = (base, stamp) => isActive(base) && isActive(stamp) ? contributionsSince(txsOf(base), stamp) : [];

  // The version of this stamp shown on an earlier visit, when this browser kept one the page can still draw.
  function rememberedVersion(batchId) {
    try { return checked(local.get(KEYS.seen(batchId)), batchId); } catch (e) { return null; }
  }


  // ---------- 4. Page state and timers
  // Everything that changes while the page is open. Each variable names what writes it.

  let current = null;              // the stamp on screen: showStamp(); switchDemo() clears it
  let chosenDays = DEFAULT_DAYS;   // the duration picked in Adding time, kept across re reads: chooseDuration()
  let previewDays = 0;             // the stretch drawn on the bar right now, 0 for none: showPreview(), clearPreview()
  let opener = null;               // what opened Adding time, to give focus back on close: openAdder()
  let generation = 0;              // bumped by start(), so an older, slower read never overwrites a newer one
  let countRun = 0;                // bumped to stop the number counting up: countTo(), renderHeadline(), renderLoading()
  let paintBlockClock = null;      // repaints the live block: startBlockClock(), stopBlockClock()

  // Named timers, each kept as the function that cancels it. Starting one cancels whatever ran under that name.
  const timers = new Map();
  function later(name, fn, ms) {
    stop(name);
    const id = setTimeout(() => { timers.delete(name); fn(); }, ms);
    timers.set(name, () => clearTimeout(id));
  }
  function every(name, fn, ms) {
    stop(name);
    const id = setInterval(fn, ms);
    timers.set(name, () => clearInterval(id));
  }
  function stop(...names) {
    for (const name of names) {
      const cancel = timers.get(name);
      if (cancel) { cancel(); timers.delete(name); }
    }
  }


  // ---------- 5. Rendering: a document in, the page out
  // render* functions only draw. None of them adds a listener: wiring is in section 10.

  // One class on <body> carries the state for the CSS: loading, paid, soon, expired, missing or error.
  function setState(name) {
    document.body.className = 'state-' + name;
    if (name !== 'paid' && name !== 'soon') hideAdder();   // nothing to add time to
    if (name === 'loading' || name === 'missing' || name === 'error') hideQr();   // no stamp on screen to show
    // the skeleton's "00 days left" is decoration, not a number to read out
    const number = document.querySelector('.num');
    if (name === 'loading') number.setAttribute('aria-hidden', 'true'); else number.removeAttribute('aria-hidden');
  }

  // Draws a stamp document. animate: 'enter' on first sight, 'update' when new time arrives in place.
  function showStamp(stamp, { animate = null } = {}) {
    // for an update, measure what is on screen before anything changes, so it can move from there
    const before = animate === 'update' && isActive(current) ? measureLayout() : null;
    current = stamp;
    hideNotice();
    if (stamp.status === 'not_found') return renderMissing(stamp.batchId);

    const view = describe(stamp);
    setState(view.expired ? 'expired' : view.soon ? 'soon' : 'paid');
    const previewing = isAdderOpen();
    renderHeadline(stamp, view);
    renderBar(view, animate === 'enter', previewing ? chosenDays : 0, before ? 'arrival' : null);
    renderKeepers(stamp, view);
    renderDetails(stamp, view);
    renderAdder(stamp);
    renderActions();
    startBlockClock(stamp, view);
    if (previewing) showPreview(chosenDays, { bar: false });
    local.set(KEYS.seen(stamp.batchId), stamp);
    if (before) playArrival(before, view);
  }

  // The number, the pill and the sentence: how long this is paid for, always as an estimate.
  function renderHeadline(stamp, view) {
    countRun++;   // a number still counting up from an earlier update stops here
    const shortId = abbreviate(stamp.batchId, 8, 7);
    $('stampShort').textContent = shortId;
    document.title = 'Postage stamp ' + shortId + ' · Stamptime';
    $('days').textContent = view.daysLeft;
    $('daysLabel').textContent = view.daysLeft === 1 ? 'day left' : 'days left';
    $('pill').textContent = view.expired ? 'Expired' : view.soon ? 'Expiring soon' : 'Paid';
    $('until').innerHTML = untilSentence(view);
    $('caveat').textContent = view.expired
      ? 'Nobody did. What it covered is no longer kept by the network.'
      : 'Nobody is obliged to keep it paid. If nobody does, what it covers stops being kept around ' + formatDayMonth(view.end) +
        '. Anyone can add time; the owner stays the owner.';
  }

  function untilSentence(view) {
    if (view.expired) {
      return view.end
        ? html`Ran out around <b>${formatDate(view.end)}</b>. Time can no longer be added to it.`
        : html`Ran out. Time can no longer be added to it.`;
    }
    const range = view.giveOrTake ? ', give or take ' + plural(view.giveOrTake, 'day') : '';
    return html`Paid in BZZ until about <b>${formatDate(view.end)}</b>${range}, at today's storage price.`;
  }

  // The bar: the whole life of the stamp, one block per month, always filling the width. Spent time veiled,
  // today as the line, the time ahead bright, and the estimate dissolving across the end.
  // Each month is an <i>; its colour layers, the fill, the spent veil and the plan, are <b>s.
  // extraDays: Adding time's preview. The stretch it would add is hatched from the paid end on, in the plan layer,
  // and the bar takes in the months it needs, so paying for more squeezes more blocks in, as it would.
  // The months are kept from one render to the next, so the bar can move instead of jumping. `motion` names the pace
  // in MOTION ('preview' or 'arrival'): months the bar gains widen in one after another from where it reached, months
  // it loses narrow away from the far end, and the hatching follows (stamp.css). Without it the bar is drawn at once.
  function renderBar(view, enter, extraDays = 0, motion = null) {
    const bar = $('months');
    const toMonths = date => daysBetween(view.created, date) / MONTH_DAYS;
    const spent = toMonths(view.expired ? view.barEnd : view.now);
    const end = toMonths(view.barEnd);
    // The estimate fades out over a band centred on the likeliest end, as wide as the give or take and never
    // thinner than a tenth of the bar, so it reads as a fade and not as an edge. An expired stamp has no estimate.
    const roughCount = Math.max(1, Math.ceil(end + view.giveOrTake / MONTH_DAYS));
    const band = view.expired ? 0 : Math.max(view.giveOrTake / MONTH_DAYS, roughCount * 0.1);
    const fadeStart = end - band / 2, fadeEnd = end + band / 2;
    const life = view.expired ? end : fadeEnd;          // where the colour runs out
    const planEnd = end + extraDays / MONTH_DAYS;       // where the preview would take it
    const count = Math.max(1, Math.ceil(life), Math.ceil(planEnd));
    const opacity = x => view.expired ? 1 : clamp01((fadeEnd - x) / (fadeEnd - fadeStart));

    const pace = motion && !prefersReducedMotion() ? MOTION[motion] : null;
    const reached = bar.reach == null ? planEnd : bar.reach;   // where the colour or the hatching reached last time
    const delay = m => {
      if (!pace) return 0;
      const steps = planEnd >= reached ? m - Math.floor(reached) : Math.ceil(reached) - 1 - m;
      return Math.min(pace.staggerMax, Math.max(0, steps) * pace.stagger);
    };
    bar.classList.toggle('still', !pace);
    if (pace) {
      bar.style.setProperty('--glide', pace.duration + 'ms');
      bar.style.setProperty('--glide-ease', pace.easing);
    }

    const fills = [], refreshed = [], kept = [...bar.children];
    for (let m = 0; m < Math.max(count, kept.length); m++) {
      let month = kept[m];
      if (m >= count) {
        if (month) narrowAway(month, pace, delay(m));
        continue;
      }
      if (!month) {
        month = document.createElement('i');
        month.className = pace ? 'month entering' : 'month';
        bar.append(month);
      } else if (month.leaving) {
        clearTimeout(month.leaving);   // wanted again before it was gone: it widens back from where it is
        month.leaving = null;
        month.classList.remove('leaving');
      }
      month.style.setProperty('--d', delay(m) + 'ms');
      // the fill and the veil are drawn afresh; the plan stays, so its width can move
      const plan = month.querySelector('.plan') || layer('plan plan-fill');
      for (const el of [...month.children]) if (el !== plan) el.remove();
      const layers = [];
      if (life - m > 0) {
        const fill = layer('fill');
        fill.style.webkitMask = fill.style.mask = fadeMask(m, fadeStart, fadeEnd, opacity);
        layers.push(fill);
        fills.push(fill);
        if (motion === 'arrival' && m >= Math.floor(reached) && !month.classList.contains('entering')) refreshed.push(fill);
      }
      const spentShare = clamp01(spent - m);
      if (spentShare > 0 && !view.expired) {
        const veil = layer('spent');
        veil.style.setProperty('--q', spentShare * 100 + '%');
        layers.push(veil);
      }
      month.prepend(...layers);
      if (!plan.parentNode) month.append(plan);
      const holdsToday = !view.expired && spent >= m && spent < m + 1;
      month.classList.toggle('now', holdsToday);
      if (holdsToday) month.style.setProperty('--x', (spent - m) * 100 + '%'); else month.style.removeProperty('--x');
      const planFrom = Math.max(m, end), planTo = Math.min(m + 1, planEnd);
      plan.style.setProperty('--a', clamp01(planFrom - m) * 100 + '%');
      plan.style.setProperty('--w', Math.max(0, planTo - planFrom) * 100 + '%');
    }
    if (pace) {
      bar.getBoundingClientRect();   // lay the new months out at no width, so they widen from there
      for (const month of bar.querySelectorAll('.entering')) month.classList.remove('entering');
      // where the end moved inside a month, its fill brightens into the new fade rather than switching
      for (const fill of refreshed) fill.animate([{ opacity: .45 }, { opacity: 1 }], { duration: pace.duration, easing: EASE_OUT });
    }
    bar.reach = planEnd;
    if (enter && !view.expired && !prefersReducedMotion()) playEnter(fills);

    $('startCap').textContent = 'Created ' + formatDayMonth(view.created);
    $('endCap').innerHTML = view.expired
      ? (view.end ? html`ran out ${formatDayMonth(view.end)}` : '')
      : html`<span aria-hidden="true">~</span><span class="sr">about </span>${formatDayMonth(view.end)}`;
  }

  // A month the bar no longer needs narrows away, or goes at once when nothing moves.
  function narrowAway(month, pace, delay) {
    if (!pace) return month.remove();
    if (month.leaving) return;
    month.style.setProperty('--d', delay + 'ms');
    month.classList.add('leaving');
    month.leaving = setTimeout(() => month.remove(), pace.duration + delay + 50);
  }

  function layer(className) {
    const el = document.createElement('b');
    el.className = className;
    return el;
  }

  // One month's slice of the fade: four stops, at the month's edges and where the fade starts and ends inside it.
  function fadeMask(m, fadeStart, fadeEnd, opacity) {
    const a = clamp01(fadeStart - m), b = clamp01(fadeEnd - m);
    const colorStop = (x, at) => 'rgba(0,0,0,' + opacity(m + x) + ') ' + at + '%';
    return 'linear-gradient(90deg, ' + [colorStop(0, 0), colorStop(a, a * 100), colorStop(b, b * 100), colorStop(1, 100)].join(', ') + ')';
  }

  // The names, ranked by days given, and while the stamp is paid an open slot that states the rule.
  function renderKeepers(stamp, view) {
    const keepers = keepersOf(stamp);
    const rows = keepers.map((keeper, i) => listItem(keeper.key, '', keeperRow(keeper, i + 1)));
    if (!view.expired) rows.push(listItem('slot', 'slot', openSlotRow(keepers.length + 1)));
    $('rank').replaceChildren(...rows);
  }

  // data-key lets the arrival find each row again after a render: the address, or 'slot'.
  function listItem(key, className, markup) {
    const li = document.createElement('li');
    li.dataset.key = key;
    if (className) li.className = className;
    li.innerHTML = markup;
    return li;
  }

  function keeperRow(keeper, rank) {
    const who = externalLink(GNOSISSCAN + '/address/' + keeper.address, abbreviate(keeper.address, 6, 4), 'chain-link', 'address on Gnosisscan');
    const tx = externalLink(GNOSISSCAN + '/tx/' + keeper.last.tx, abbreviate(keeper.last.tx, 8, 0), 'chain-link', 'transaction on Gnosisscan');
    const bzz = keeper.bzzKnown ? html`<span class="bzz">${formatBzz(keeper.bzz)}</span>` : '';
    return html`<span class="pos">${rank}</span>
      <span class="who">${who}<small>${keeperLine(keeper)} · tx ${tx}</small></span>
      <span class="amt">${formatDays(keeper.days)}${bzz}</span>`;
  }

  // "Owner, created the stamp, 9 Oct", "Kept it alive 3 times, last 12 Oct"…
  function keeperLine(keeper) {
    const when = formatDayMonth(new Date(keeper.last.time));
    if (keeper.created) {
      const who = keeper.owner ? 'Owner, created' : 'Created';
      return keeper.payments > 1
        ? who + ' it and kept it alive ' + plural(keeper.payments - 1, 'time') + ', last ' + when
        : who + ' the stamp, ' + when;
    }
    const kept = keeper.owner ? 'Owner, kept' : 'Kept';
    return keeper.payments > 1
      ? kept + ' it alive ' + plural(keeper.payments, 'time') + ', last ' + when
      : kept + ' it alive, ' + when;
  }

  // The slot states the rule and offers nothing.
  function openSlotRow(rank) {
    return html`<span class="pos">${rank}</span>
      <span class="who">Open<small>Any address can add BZZ to it. The owner stays the owner.</small></span>
      <span class="amt"></span>`;
  }

  // The facts, as Batch Explorer shows them, and the embed lines.
  function renderDetails(stamp, view) {
    const ownerShort = abbreviate(stamp.owner, 6, 4);
    $('batchId').textContent = stamp.batchId;
    renderQr(stamp.batchId);
    $('ownerLink').textContent = ownerShort;
    $('ownerLink').href = GNOSISSCAN + '/address/' + stamp.owner;
    $('capacity').textContent = stamp.capacity;
    $('depth').textContent = stamp.depth;
    $('immutable').textContent = stamp.immutable ? 'Yes' : 'No';
    const createdBlock = externalLink(GNOSISSCAN + '/block/' + stamp.created.block, '#' + stamp.created.block, 'chip');
    $('createdRow').innerHTML = html`${formatNumericDate(view.created)} ${createdBlock}`;
    $('expiryRow').innerHTML = expiryRow(view);
    const { bzzPerDay } = stamp.pricing || {};
    $('balanceRow').innerHTML = balanceRow(view, bzzPerDay);
    $('priceRow').innerHTML = bzzPerDay
      ? html`${formatBzzPrice(bzzPerDay)} <span class="ui">a day at this size, set by the network</span>`
      : html`<span class="ui">not read</span>`;
    $('rpc').textContent = stamp.chain.rpc || '';
    $('contract').textContent = stamp.chain.contract;
    $('eventsLink').href = BATCH_EXPLORER + stamp.batchId;
    $('contractLink').href = GNOSISSCAN + '/address/' + stamp.chain.contract + '#code';
    $('badgeLine').textContent = view.expired
      ? (view.end ? 'ran out around ' + formatDate(view.end) : 'ran out')
      : 'paid until about ' + formatDate(view.end);
    $('badgeCode').textContent = '<script src="' + BADGE_JS + '" data-batch="' + stamp.batchId + '"></script>';
  }

  // The batch id as a QR code, in the popover the QR icons open. qr.js loads the first time a stamp is drawn, after the
  // stamp is on screen, so it never delays it, and the code is ready before anyone asks for it: 4 KB, where loading it
  // on the first tap would leave the card empty for a round trip. The markup is numbers only; the id is never put in it.
  function renderQr(batchId) {
    if ($('qrId').textContent === batchId) return;
    $('qrId').textContent = batchId;
    $('qrCode').replaceChildren();
    import('./qr.js')
      .then(({ qrSvg }) => { if ($('qrId').textContent === batchId) $('qrCode').innerHTML = qrSvg(batchId); })
      .catch(e => console.warn('Stamptime: no QR code.', e));
  }

  // Which icon the popover hangs from: the one just pressed (stamp.css anchors it there).
  function pointQr(button) {
    for (const each of document.querySelectorAll('.qr-btn')) each.style.setProperty('anchor-name', each === button ? '--qr' : 'none');
  }

  function hideQr() {
    try { $('qrPop').hidePopover(); } catch (e) { /* closed already, or no popovers */ }
  }

  function expiryRow(view) {
    if (view.expired) {
      return view.end
        ? html`around ${formatNumericDate(view.end)} <span class="ui">ran out</span>`
        : html`<span class="ui">ran out</span>`;
    }
    const range = view.giveOrTake ? 'give or take ' + plural(view.giveOrTake, 'day') + ', ' : '';
    return html`about ${formatNumericDate(view.end)} <span class="ui">${range}at today's storage price</span>`;
  }

  // What is left on the stamp: a day at today's price times the days left, which is remainingBalance x 2^depth at
  // the same block. Divided by the Storage price row it gives back the expiry.
  function balanceRow(view, bzzPerDay) {
    if (view.expired) return html`0 BZZ <span class="ui">ran out</span>`;
    return bzzPerDay
      ? html`${formatBzz(bzzPerDay * daysBetween(view.now, view.end))} <span class="ui">left on the stamp</span>`
      : html`<span class="ui">not read</span>`;
  }

  // Adding time: three stretches side by side, each counted from the current end and priced in BZZ at today's price.
  // The chosen one is drawn on the bar: showPreview(). Nothing leaves the page.
  function renderAdder(stamp) {
    const options = $('opts');
    const hadFocus = options.contains(document.activeElement);
    $('adderContract').href = GNOSISSCAN + '/address/' + stamp.chain.contract + '#code';
    options.innerHTML = html`${DURATIONS.map(duration => durationOption(duration, stamp.pricing || {}))}`;
    options.style.setProperty('--pick', DURATIONS.findIndex(d => d.days === chosenDays));
    if (hadFocus) checkedOption().focus();
  }

  function durationOption({ days, name }, { bzzPerDay }) {
    const on = days === chosenDays;
    const bzz = bzzPerDay ? '≈ ' + formatBzz(bzzPerDay * days) : '';
    return html`<button type="button" class="opt" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}"
        data-action="choose-duration" data-days="${days}">
      <b>${name}</b>${bzz ? html`<span class="est">${bzz}</span>` : ''}
    </button>`;
  }

  // The preview: the stretch hatched on the bar, the number it would reach, the date it would reach, and the Preview
  // pill. `glide` moves everything there from what was on screen, for a pick or a pointer: what the preview pushes
  // aside slides, what it adds fades in, what it changes sharpens into the new value. Without it, as on a re read,
  // it is simply drawn. `bar: false` when the bar was just drawn with the stretch on it.
  function showPreview(days, { glide = false, bar = true } = {}) {
    if (!isActive(current)) return;
    const view = describe(current);
    const option = DURATIONS.find(d => d.days === days) || DURATIONS[0];
    const until = new Date(view.end.getTime() + days * DAY_MS);
    const opening = $('daysTo').hidden, changed = days !== previewDays;
    const draw = () => {
      if (bar) renderBar(view, false, days, glide ? 'preview' : null);
      $('endCap').innerHTML += html` <span class="to"><span aria-hidden="true">→ ~</span><span class="sr">, with it about </span>${formatDate(until)}</span>`;
      $('daysToNum').textContent = view.daysLeft + days;
      $('would').innerHTML = html`With ${option.name.toLowerCase()} on top, about <b>${formatDate(until)}</b>. A preview, not a transaction.`;
      $('daysTo').hidden = $('would').hidden = $('previewPill').hidden = false;
    };
    previewDays = days;
    if (!glide) return draw();
    easeAside(draw);
    const date = $('endCap').querySelector('.to');
    if (opening) {
      fadeIn($('previewPill'), 'scale(.96)');
      fadeIn($('daysTo'), 'translateX(-6px)');
      fadeIn($('would'), 'translateY(-3px)');
      fadeIn(date, 'translateX(-4px)');
    } else if (changed) {
      for (const el of [$('daysToNum'), $('would'), date]) sharpenSoftly(el);
    }
  }

  function clearPreview(glide = false) {
    const undraw = () => {
      $('daysTo').hidden = $('would').hidden = $('previewPill').hidden = true;
      if (previewDays && isActive(current)) renderBar(describe(current), false, 0, glide ? 'preview' : null);
    };
    if (glide) {
      for (const el of [$('previewPill'), $('daysTo'), $('would'), $('endCap').querySelector('.to')]) fadeAway(el);
      easeAside(undraw);
    } else {
      undraw();
    }
    previewDays = 0;
  }

  // Adding time: off when there is nothing to add to.
  function renderActions() {
    setDisabled('addBtn', !isActive(current));
  }

  // The live block in the header and the footer, and how long ago the balance was read. Counted from the wall
  // clock, so a tab or a laptop that slept catches up as soon as it is looked at. A stamp that ran out stays still.
  // The demo pretends the balance was read just now.
  function startBlockClock(stamp, view) {
    const { block, blockTime } = stamp.chain;
    const startedAt = Date.now();
    const lag = DEMO ? 0 : Math.max(0, Math.floor((startedAt - new Date(blockTime)) / 1000));
    paintBlockClock = () => {
      const ticks = Math.max(0, Math.round((Date.now() - startedAt) / (BLOCK_SECONDS * 1000)));
      $('hdrBlock').textContent = $('footBlock').textContent = block + Math.floor(lag / BLOCK_SECONDS) + ticks;
      $('readLine').textContent = lag + ticks * BLOCK_SECONDS + ' s ago, re read once per price round';
    };
    $('readBlock').textContent = '#' + block;
    $('beatLine').textContent = view.expired
      ? 'went by' + (stamp.expiry.lastBlock ? ', storers stopped being paid at block ' + stamp.expiry.lastBlock : '')
      : 'just paid for five more seconds';
    paintBlockClock();
    if (view.expired) stopBlockClock(); else every('blockClock', paintBlockClock, BLOCK_SECONDS * 1000);
  }

  function stopBlockClock() {
    stop('blockClock');
    paintBlockClock = null;
  }

  // Loading draws a skeleton. Not found and error show the notice card in place of the meter, the keepers and the details.
  function renderLoading() {
    setState('loading');
    hideNotice();
    stopBlockClock();
    countRun++;   // a number still counting up stops here
    document.title = 'Stamptime';
    $('days').textContent = '00';
    $('pill').textContent = 'Reading';
    $('until').textContent = 'Reading Gnosis…';
    $('hdrBlock').textContent = $('footBlock').textContent = '…';
    $('startCap').textContent = 'Created';
    $('endCap').textContent = '';
    $('months').innerHTML = '<i class="month"></i>'.repeat(3);
    $('months').reach = null;
    $('rank').innerHTML = '<li><span class="pos"></span><span class="who">Reading the history…</span><span class="amt"></span></li>';
    setDisabled('addBtn', true);
  }

  // `id` is what the visitor asked for: a valid id that was never created, or a malformed one. Null when none.
  function renderMissing(id) {
    setState('missing');
    stopBlockClock();
    const demoLink = html`<a class="btn" href="?demo=active">See a demo</a>`;
    showNotice(id
      ? html`<h1 tabindex="-1">No stamp with this id</h1>
        <p class="mono">${id}</p>
        <p>It may be a typo in the link, or it was never created on Gnosis. Check the link, or look it up on Batch Explorer.</p>
        <div class="actions">${externalLink(BATCH_EXPLORER + encodeURIComponent(id), 'Look it up on Batch Explorer', 'btn')}${demoLink}</div>`
      : html`<h1 tabindex="-1">Which stamp?</h1>
        <p>Add a batch id to the address, as /stamp/&lt;id&gt; or ?id=&lt;id&gt;.</p>
        <div class="actions">${demoLink}</div>`);
  }

  function renderError(id) {
    setState('error');
    stopBlockClock();
    showNotice(html`<h1 tabindex="-1">Could not read the stamp</h1>
      <p>${API ? 'The stamp service' : RPCS.length > 1 ? 'The Gnosis nodes this page reads from' : 'The Gnosis node this page reads from'} did not answer. The stamp itself may be fine: it lives on Gnosis, not here.</p>
      <div class="actions">
        <button class="btn" type="button" id="retry" data-action="retry">Try again</button>
        ${id ? externalLink(BATCH_EXPLORER + id, 'Check on Batch Explorer', 'btn') : ''}
      </div>`);
  }

  function showNotice(markup) {
    const notice = $('notice');
    notice.innerHTML = markup;
    notice.hidden = false;
    const heading = notice.querySelector('h1').textContent;
    document.title = heading + ' · Stamptime';
    announce(heading);
  }

  function hideNotice() {
    $('notice').hidden = true;
    $('notice').replaceChildren();   // so nothing, such as an old Try again button, lingers out of sight
  }


  // ---------- 6. Motion: new time arriving, and the preview moving in and out
  // Rendering never animates by itself, except the bar, whose months glide when renderBar() is given a pace. For an
  // update, showStamp() measures the old layout, renders the new one, and playArrival() moves the rest from where it
  // was to where it is now.

  function measureLayout() {
    const rect = el => el.getBoundingClientRect();
    return {
      rows: new Map([...$('rank').children].map(li => [li.dataset.key, rect(li).top])),
      listHeight: rect($('rank')).height,
      days: parseInt($('days').textContent, 10) || 0
    };
  }

  // First sight: the months fill in from the left, one after another, within half a second whatever their number.
  function playEnter(fills) {
    const { duration, stagger, spread } = MOTION.enter;
    const step = Math.min(stagger, spread / fills.length);
    fills.forEach((fill, i) => fill.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0)' }],
      { duration, easing: EASE_OUT, delay: i * step, fill: 'backwards' }));
  }

  function playArrival(before, view) {
    const rows = [...$('rank').children];
    const isNew = li => !before.rows.has(li.dataset.key);
    if (prefersReducedMotion()) {
      // no movement: the new keeper fades in, everything else is simply there
      rows.filter(isNew).forEach(li => li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fade.duration, easing: 'ease' }));
      return;
    }
    // the number counts up to the new total, and the sentence sharpens into its new date
    countTo($('days'), before.days, view.daysLeft);
    for (const el of [$('until'), $('endCap')]) {
      el.animate([{ filter: 'blur(4px)', opacity: .35 }, { filter: 'blur(0)', opacity: 1 }],
        { duration: MOTION.sharpen.duration, easing: EASE_OUT });
    }
    playRows(before, rows, isNew);
  }

  function countTo(el, from, to) {
    const run = ++countRun, startedAt = performance.now(), { duration } = MOTION.count;
    el.textContent = from;
    const step = now => {
      if (run !== countRun) return;
      const p = clamp01((now - startedAt) / duration), eased = 1 - Math.pow(1 - p, 4);
      el.textContent = Math.round(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    // a tab in the background pauses animation frames: make sure the number always lands on its value
    setTimeout(() => { if (run === countRun) el.textContent = to; }, duration + 80);
  }

  // What a change in the meter pushes aside slides there from where it was, instead of jumping: the number, the
  // sentences, the bar and its caption, Adding time, and "days left" beside the number. Translation only, so nothing
  // stretches. Pieces that appear or go are left out; they fade on their own.
  function easeAside(change) {
    if (prefersReducedMotion()) return change();
    const meter = document.querySelector('.meter'), label = $('daysLabel'), num = label.parentNode;
    const parts = [...meter.children].filter(el => !el.hidden && el.matches('.num, .until, .months, .months-caption, .adder') && !('ghost' in el.dataset));
    const at = el => el.getBoundingClientRect();
    const was = parts.map(at), labelWas = offsetIn(label, num);
    change();
    parts.forEach((el, i) => { if (!el.hidden) slide(el, was[i].left - at(el).left, was[i].top - at(el).top); });
    const labelNow = offsetIn(label, num);
    slide(label, labelWas.x - labelNow.x, labelWas.y - labelNow.y);
  }

  function offsetIn(el, box) {
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top };
  }

  function slide(el, dx, dy) {
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
    el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }],
      { duration: MOTION.preview.duration, easing: EASE_OUT });
  }

  // A piece the preview adds comes in from a few px off and slightly soft. With reduced motion it only fades.
  function fadeIn(el, from) {
    if (!el) return;
    el.animate(prefersReducedMotion()
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: from, filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
      { duration: MOTION.preview.enter, easing: EASE_OUT });
  }

  // A piece the preview removes fades out where it was, as a copy laid over its place, while what moves in slides
  // under it. The copy sits in the same positioned box, so it keeps its looks and moves with that box.
  function fadeAway(el) {
    if (!el || el.hidden || !el.offsetParent || prefersReducedMotion()) return;
    const box = el.offsetParent, a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    for (const node of [ghost, ...ghost.querySelectorAll('[id]')]) node.removeAttribute('id');
    ghost.removeAttribute('aria-live');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.dataset.ghost = '';
    Object.assign(ghost.style, {
      position: 'absolute', left: a.left - b.left - box.clientLeft + 'px', top: a.top - b.top - box.clientTop + 'px',
      width: a.width + 'px', margin: '0', pointerEvents: 'none'
    });
    box.append(ghost);
    ghost.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(2px)' }],
      { duration: MOTION.preview.exit, easing: EASE_OUT, fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove());
  }

  // A value that changes in place sharpens into the new one.
  function sharpenSoftly(el) {
    if (!el || prefersReducedMotion()) return;
    el.animate([{ opacity: .5, filter: 'blur(1.5px)' }, { opacity: 1, filter: 'blur(0)' }],
      { duration: MOTION.preview.swap, easing: EASE_OUT });
  }

  // The list grows by a row, the others slide to their new place, and each new keeper rises into its gap.
  function playRows(before, rows, isNew) {
    const list = $('rank'), { glide, card } = MOTION;
    const height = list.getBoundingClientRect().height;
    if (Math.abs(height - before.listHeight) > 0.5) {
      list.animate([{ height: before.listHeight + 'px' }, { height: height + 'px' }], { duration: glide.duration, easing: EASE_IN_OUT });
    }
    let arrivals = 0;
    for (const li of rows) {
      const top = li.getBoundingClientRect().top;
      if (isNew(li)) {
        // from the open slot it just took, or from a little below when there was none
        const rise = before.rows.has('slot') ? before.rows.get('slot') - top : card.rise;
        arriveAsCard(li, card.delay + arrivals++ * card.stagger, rise);
      } else {
        const dy = before.rows.get(li.dataset.key) - top;
        if (Math.abs(dy) > 0.5) {
          li.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: glide.duration, easing: EASE_IN_OUT });
        }
      }
    }
  }

  // A new keeper arrives as a card: it appears on the open slot it just took, rises over the list to its rank,
  // lands, keeps a tint for a moment, then becomes a row like the others. Opaque early, so it covers the rows it passes.
  function arriveAsCard(li, delay, rise) {
    const { duration, lands, untint, done } = MOTION.card;
    li.classList.add('arriving', 'lift');
    li.animate([
      { transform: 'translateY(' + rise + 'px) scale(.97)', opacity: 0 },
      { opacity: 1, offset: .22 },
      { transform: 'none', opacity: 1 }
    ], { duration, easing: EASE_IN_OUT, delay, fill: 'backwards' });
    setTimeout(() => li.classList.replace('lift', 'tint'), delay + lands);
    setTimeout(() => li.classList.remove('tint'), delay + untint);
    setTimeout(() => li.classList.remove('arriving'), delay + done);
  }


  // ---------- 7. Adding time: the preview under the bar

  // Adding time opens in the meter card, under the bar it changes: nothing covers the page, and each pick is drawn on
  // the bar as it is made. A preview only: nothing is paid or sent from here. Its tile toggles it; focus goes to the
  // chosen stretch, and back where it came from.
  const isAdderOpen = () => $('adder').hasAttribute('data-open');

  function toggleAdder(trigger) {
    if (isAdderOpen()) closeAdder(); else openAdder(trigger);
  }

  function openAdder(trigger) {
    if (!isActive(current)) return;
    opener = trigger;
    setAdderOpen(true);   // it unfolds by itself (stamp.css)
    showPreview(chosenDays, { glide: true });
    // opened from further down, as on a phone: the bar comes back into view, since that is where the pick shows
    if (!inView($('months'))) {
      document.querySelector('.meter').scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    checkedOption().focus({ preventScroll: true });
  }

  // Focus inside goes back to what opened it when that is in view, otherwise to the heading, so closing never
  // scrolls the page away from the bar.
  function closeAdder() {
    const hadFocus = $('adder').contains(document.activeElement);
    setAdderOpen(false);
    clearPreview(true);
    if (hadFocus) {
      const back = opener && opener.isConnected && !opener.disabled && inView(opener) ? opener : document.querySelector('.meter h1');
      back.focus({ preventScroll: true });
    }
    opener = null;
  }

  // Closed at once, with no glide and no focus to give back: the stamp ran out, or another state took the page.
  function hideAdder() {
    if (!isAdderOpen()) return;
    setAdderOpen(false);
    $('daysTo').hidden = $('would').hidden = $('previewPill').hidden = true;
    previewDays = 0;
    opener = null;
  }

  // Closed, Adding time is inert, so nothing in it can be reached while it folds away.
  function setAdderOpen(open) {
    $('adder').toggleAttribute('data-open', open);
    $('adder').inert = !open;
    $('addBtn').setAttribute('aria-expanded', open);
  }

  // In view below the sticky header and above the bottom edge.
  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.top >= document.querySelector('.hdr').getBoundingClientRect().bottom && r.bottom <= window.innerHeight;
  }

  const checkedOption = () => $('opts').querySelector('[aria-checked="true"]');

  function chooseDuration(option) {
    chosenDays = Number(option.dataset.days);
    for (const each of $('opts').children) {
      const on = each === option;
      each.setAttribute('aria-checked', on);
      each.tabIndex = on ? 0 : -1;
    }
    $('opts').style.setProperty('--pick', DURATIONS.findIndex(d => d.days === chosenDays));   // the thumb slides there
    if (previewDays !== chosenDays) showPreview(chosenDays, { glide: true });   // pointing at it may have drawn it already
  }

  // Arrow keys move the choice, as in any radio group.
  function moveChoice(e) {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const options = [...$('opts').children];
    const next = options[(options.indexOf(checkedOption()) + step + options.length) % options.length];
    chooseDuration(next);
    next.focus();
  }


  // ---------- 8. Feedback: toast, announcements, copy

  // A short note at the bottom of the screen. Screen readers hear `say`, which is the note itself by default.
  // It rises in a few px and fades out a little faster; a new note while one is leaving takes its place at once.
  let toastLeaving = null;
  function toast(message, { ms = TOAST_MS, say = message } = {}) {
    const el = $('toast');
    if (toastLeaving) toastLeaving.cancel();
    el.textContent = message;
    if (el.hidden) {
      el.hidden = false;
      if (!prefersReducedMotion()) {
        el.animate([{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }],
          { duration: MOTION.toast.enter, easing: EASE_OUT });
      }
    }
    announce(say);
    later('toast', () => {
      if (prefersReducedMotion()) { el.hidden = true; return; }
      toastLeaving = el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%, 4px)' }],
        { duration: MOTION.toast.exit, easing: EASE_OUT, fill: 'forwards' });
      toastLeaving.finished.then(() => { el.hidden = true; toastLeaving.cancel(); toastLeaving = null; }, () => {});
    }, ms);
  }

  // What the note says when time arrives.
  const addedNote = (days, stamp) => 'Added ' + formatDays(days) + '. Paid until about ' + formatDate(new Date(stamp.expiry.time)) + '.';
  const sinceNote = days => 'Since you last looked, ' + formatDays(days) + (Math.round(days) > 1 ? ' were' : ' was') + ' added.';

  // One polite live region for everything the page says out loud. Emptied first, so a repeat is read again.
  function announce(message) {
    const live = $('live');
    live.textContent = '';
    later('announce', () => { live.textContent = message; }, 50);
  }

  // Copies the batch id or the owner's address. Without the clipboard, the value stays on screen to copy by hand.
  function copy(button) {
    if (!current) return;
    const ofOwner = button.dataset.copy === 'owner';
    const text = ofOwner ? current.owner : current.batchId;
    const what = ofOwner ? 'address' : 'batch id';
    const done = () => toast(ofOwner ? 'Owner address copied' : 'Batch id copied');
    const fail = () => toast(text, { ms: TOAST_LONG_MS, say: 'Could not copy. The ' + what + ' is shown on screen.' });
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }


  // ---------- 9. Loading and keeping fresh

  // Reads the stamp in the URL, or the demo, and shows it. Safe to call again: the newest call wins.
  async function start(demo = DEMO) {
    const run = ++generation;
    stop('refresh', 'replay');
    const { id, asked } = idFromUrl();
    if (!demo && !id) return renderMissing(asked);
    if (demo === 'loading') return renderLoading();
    if (demo === 'error') return renderError(id);
    if (!current) renderLoading();

    let stamp;
    try {
      stamp = await fetchStamp(id, demo);
    } catch (e) {
      console.warn(e);   // no answer, an HTTP error, or a document that breaks the contract
      if (run === generation) renderError(id);
      return;
    }
    if (run !== generation) return;   // a newer read took over while this one was out
    try {
      showWithChanges(stamp);
      if (!demo && stamp.status !== 'not_found') keepFresh(stamp.batchId);
    } catch (e) {
      // checked() let the document through, so a throw here is a bug: log it, and never leave half a page
      console.error(e);
      renderError(id);
    }
  }

  // Shows a stamp and plays whatever time arrived since it was last seen:
  //   on screen already (the demo's After top up): the new time arrives in place
  //   seen on an earlier visit, in this browser: that version shows for a beat, then the new time arrives
  //   otherwise: the months add up on first sight
  function showWithChanges(stamp) {
    const onScreen = isActive(current) && current.batchId === stamp.batchId ? current : null;
    const remembered = onScreen ? null : rememberedVersion(stamp.batchId);
    const added = addedSince(onScreen || remembered, stamp);
    if (!added.length) return showStamp(stamp, { animate: onScreen ? null : 'enter' });

    const gained = daysIn(added);
    if (onScreen) {
      showStamp(stamp, { animate: 'update' });
      return toast(addedNote(gained, stamp));
    }
    showStamp(remembered);
    const run = generation;
    later('replay', () => whenVisible(() => {
      if (run !== generation || current !== remembered) return;   // something newer is on screen by now
      showStamp(stamp, { animate: 'update' });
      toast(sinceNote(gained));
    }), prefersReducedMotion() ? 0 : MOTION.replay);
  }

  // Runs fn now, or when the visitor comes back to this tab: news should not play to an empty room.
  function whenVisible(fn) {
    if (!document.hidden) return fn();
    document.addEventListener('visibilitychange', function onShow() {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onShow);
      fn();
    });
  }

  // Re reads once per price round. Time someone added in the meantime arrives in place.
  function keepFresh(batchId) {
    const run = generation;
    every('refresh', async () => {
      let fresh;
      try { fresh = await fetchStamp(batchId); } catch (e) { return; }   // keep what is on screen
      if (run !== generation) return;
      const arrived = addedSince(current, fresh).length > 0;
      keepingFocus(() => showStamp(fresh, { animate: arrived ? 'update' : null }));
    }, PRICE_ROUND_MS);
  }

  // A re read rebuilds the ranking: keyboard focus goes back to the same control in the same row.
  function keepingFocus(render) {
    const focused = document.activeElement;
    const row = focused && focused.closest('#rank > li');
    const index = row ? [...row.querySelectorAll('a, button')].indexOf(focused) : -1;
    render();
    if (index < 0) return;
    const again = [...$('rank').children].find(li => li.dataset.key === row.dataset.key);
    const target = again && again.querySelectorAll('a, button')[index];
    if (target) target.focus();
  }

  // Try again, from the error notice. Focus stays on the button while it still fails, else moves to what is showing.
  async function retry() {
    if (DEMO) markPressed(DEMO);   // Try again reads the demo in the URL, so the bar goes back to its button
    await start();
    const target = $('retry') || ($('notice').hidden ? document.querySelector('.meter h1') : $('notice').querySelector('h1'));
    if (target) target.focus();
  }

  // The demo bar, only with ?demo= and without &bare=1. Each button shows one example document; switching
  // cancels whatever the last state was still doing.
  function switchDemo(button) {
    const name = button.dataset.demo;
    markPressed(name);
    // these leave no stamp on screen: forget it, so the next one shows the skeleton and never animates from a hidden layout
    if (name === 'loading' || name === 'error' || name === 'not_found') current = null;
    start(name);
  }

  function markPressed(name) {
    for (const button of $('devbar').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.demo === name);
  }


  // ---------- 10. Wiring: the page's standing listeners, in one place (whenVisible() adds one-off ones)

  // Buttons say what they do with data-action; one listener runs it with the button.
  const ACTIONS = {
    'add-time': toggleAdder,
    'close-adder': closeAdder,
    'choose-duration': chooseDuration,
    'copy': copy,
    'point-qr': pointQr,
    'retry': retry,
    'demo': switchDemo
  };

  document.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target || target.disabled) return;
    ACTIONS[target.dataset.action](target);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isAdderOpen()) closeAdder();
    else if (e.target.closest('#opts')) moveChoice(e);
  });

  // Where there is a hover, pointing at a stretch draws it on the bar; leaving the options draws the chosen one again.
  // The bar's months move by transitions, so sweeping across the options retargets them smoothly instead of restarting.
  if (matchMedia('(hover: hover)').matches) {
    $('opts').addEventListener('pointerover', e => {
      const option = e.target.closest('.opt');
      if (option && Number(option.dataset.days) !== previewDays) showPreview(Number(option.dataset.days), { glide: true });
    });
    $('opts').addEventListener('pointerleave', () => {
      if (isAdderOpen() && previewDays !== chosenDays) showPreview(chosenDays, { glide: true });
    });
  }

  // The QR popover opens only on the stamp it was drawn for. Where popovers are not supported, the icons are not offered.
  if (HTMLElement.prototype.hasOwnProperty('popover')) {
    $('qrPop').addEventListener('beforetoggle', e => {
      if (e.newState === 'open' && !(current && $('qrId').textContent === current.batchId)) e.preventDefault();
    });
  } else {
    for (const button of document.querySelectorAll('.qr-btn')) button.hidden = true;
  }

  // The live block catches up as soon as the tab is looked at again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && paintBlockClock) paintBlockClock(); });

  // Back to the page in the same tab, it may come from the back/forward cache: read the stamp again.
  // The demo's documents never change, so a demo page comes back as it was left.
  window.addEventListener('pageshow', e => { if (e.persisted && !DEMO) start(); });

  if (DEMO && params.get('bare') !== '1') {
    $('devbar').hidden = false;
    markPressed(DEMO);
  }
  start();
})();
