/*
  Stamptime: the page logic. No build step, no dependencies.

  The page renders one Swarm postage stamp from one JSON document, described in api/stamp.schema.json:
    production   GET {meta stamptime-api}/stamps/{batchId}
    demo         ./examples/{name}.json, when the URL has ?demo={name}

  The batch id comes from ?id= when present, otherwise from the last path segment (/stamp/{id}).
  Everything visual lives here; the backend only has to return the JSON.

  The file reads top to bottom:
     1. Configuration            6. Motion: new time arriving
     2. Helpers                  7. Add time: the sheet, the hand off, the wait
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
  const FETCH_TIMEOUT_MS = 10 * 1000;
  const PREFLIGHT_TIMEOUT_MS = 4 * 1000;       // shorter: the Beeport tab is already open, and blank, while it runs
  const POLL_MS = 10 * 1000;                   // while waiting for a top up
  const DEMO_POLL_MS = 2500;
  const WAIT_MAX_MS = 10 * 60 * 1000;
  const JUST_NOW_MS = 60 * 60 * 1000;          // your own top up reads "just now" for an hour
  const TOAST_MS = 3500;
  const TOAST_LONG_MS = 10 * 1000;             // long enough to copy a value by hand
  const OPEN_SLOT_DAYS = 30;

  // The Add time sheet. Six months starts selected.
  const DURATIONS = [
    { days: 30, label: '30 days' },
    { days: 182, label: '6 months' },
    { days: 365, label: '1 year' }
  ];
  const DEFAULT_DAYS = 182;

  const readMeta = name => { const meta = document.querySelector('meta[name="' + name + '"]'); return meta ? meta.content : null; };
  const API = (readMeta('stamptime-api') || '/api/v1').replace(/\/$/, '');
  const BEEPORT = readMeta('stamptime-beeport') || 'https://beeport.eth.limo/?topup={id}';   // {id}, and optionally {days}
  const GNOSISSCAN = 'https://gnosisscan.io';
  const BATCH_EXPLORER = 'https://batch-explorer.github.io/batch/';
  const BADGE_JS = 'https://ethswarm.org/stamp/badge.js';
  const DONATE_JS = 'https://ethswarm.org/stamp/donate.js';

  // What this browser remembers. Nothing is ever sent anywhere.
  const KEYS = {
    handoff: 'stamptime.handoff',              // sessionStorage: a top up handed to Beeport and not seen yet
    you: 'stamptime.you',                      // sessionStorage: which contribution was yours
    seen: id => 'stamptime.seen.' + id         // localStorage: the last version of each stamp shown
  };

  const params = new URLSearchParams(location.search);
  const DEMOS = ['active', 'topped', 'expiring', 'expired', 'not_found', 'loading', 'error'];
  const DEMO = DEMOS.includes(params.get('demo')) ? params.get('demo') : null;

  // Motion. EASE_OUT for things arriving, EASE_IN_OUT for things moving on screen. Durations in ms.
  const EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
  const EASE_IN_OUT = 'cubic-bezier(.77,0,.175,1)';
  const GROW = [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }];   // from a little smaller, never from nothing
  const MOTION = {
    enter: { duration: 320, stagger: 40 },                         // first sight: the months add up one by one
    glide: { duration: 560 },                                      // months, rows and the list moving to their new place
    settle: { duration: 340, delay: 440, stagger: 45, todayAfter: 260 },   // new months, once the old ones made room
    sharpen: { duration: 380 },                                    // the sentence blurring into its new date
    count: { duration: 720 },                                      // the number counting up
    card: { duration: 680, delay: 120, stagger: 90, rise: 22,     // a new keeper rising to its rank
      lands: 820, untint: 2000, done: 3000 },                      // done outlasts the .9s tint fade in stamp.css
    fade: { duration: 240 },                                       // reduced motion: the new keeper only fades in
    replay: 520                                                    // how long a remembered version shows before the new time arrives
  };


  // ---------- 2. Helpers: no page state

  const $ = id => document.getElementById(id);
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const daysBetween = (from, to) => (to - from) / DAY_MS;
  const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const formatDate = date => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });   // 27 Dec 2026
  const formatDayMonth = date => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });              // 27 Dec
  const formatNumericDate = date => date.toLocaleDateString('en-GB');                                                // 27/12/2026
  const formatUsd = n => '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US'));
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
    set(key, value) { try { area().setItem(key, JSON.stringify(value)); } catch (e) { /* storage off */ } },
    remove(key) { try { area().removeItem(key); } catch (e) { /* storage off */ } }
  });
  const session = storageIn(() => sessionStorage);
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
        PATTERNS.tx.test(c.tx) && isTime(c.time) && typeof c.days === 'number' && isNumberOrNull(c.usd))
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

  // The ranking: one row per address, days and dollars added up, most days first. Owner is the batch owner from
  // the document; whoever paid for BatchCreated may be someone else, such as a relayer.
  function keepersOf(stamp, yourTx) {
    const ownerKey = stamp.owner.toLowerCase();
    const byAddress = new Map();
    for (const c of stamp.contributions) {
      const key = c.address.toLowerCase();
      const keeper = byAddress.get(key) ||
        { key, address: c.address, owner: key === ownerKey, created: false, you: false, days: 0, usd: 0, usdKnown: true, payments: 0, last: null };
      keeper.days += c.days;
      if (c.usd == null) keeper.usdKnown = false; else keeper.usd += c.usd;
      if (c.kind === 'created') keeper.created = true;
      if (yourTx && c.tx === yourTx) keeper.you = true;
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

  // The visitor's top up: the newest contribution that was not there when they left for Beeport. If someone else
  // tops up in the same minutes, theirs may be taken for the visitor's: the chain does not say who used Beeport.
  function landedTopUp(stamp, handoff) {
    if (!isActive(stamp)) return null;
    return contributionsSince(handoff.txs, stamp).sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;
  }

  // Which contribution was yours, when you topped this stamp up from this tab.
  function yourTxFor(batchId) {
    const you = session.get(KEYS.you);
    return you && you.id === batchId ? you.tx : null;
  }

  // The version of this stamp shown on an earlier visit, when this browser kept one the page can still draw.
  function rememberedVersion(batchId) {
    try { return checked(local.get(KEYS.seen(batchId)), batchId); } catch (e) { return null; }
  }


  // ---------- 4. Page state and timers
  // Everything that changes while the page is open. Each variable names what writes it.

  let current = null;              // the stamp on screen: showStamp(); switchDemo() clears it
  let pending = null;              // a top up handed to Beeport that has not landed yet: setPending()
  let chosenDays = DEFAULT_DAYS;   // the duration picked in the sheet, kept across re reads: chooseDuration()
  let opener = null;               // what opened the sheet, to give focus back on close: openSheet()
  let handingOff = false;          // Continue was pressed and the stamp is being checked once more: continueToBeeport()
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
    // the skeleton's "00 days left" is decoration, not a number to read out
    const number = document.querySelector('.num');
    if (name === 'loading') number.setAttribute('aria-hidden', 'true'); else number.removeAttribute('aria-hidden');
  }

  // Draws a stamp document. animate: 'enter' on first sight, 'update' when new time arrives in place.
  function showStamp(stamp, { animate = null, yourTx = yourTxFor(stamp.batchId) } = {}) {
    // for an update, measure what is on screen before anything changes, so it can move from there
    const before = animate === 'update' && isActive(current) ? measureLayout() : null;
    current = stamp;
    hideNotice();
    if (stamp.status === 'not_found') return renderMissing(stamp.batchId);

    const view = describe(stamp);
    setState(view.expired ? 'expired' : view.soon ? 'soon' : 'paid');
    renderHeadline(stamp, view);
    renderBar(view, animate === 'enter');
    renderKeepers(stamp, view, yourTx);
    renderDetails(stamp, view);
    renderSheet(stamp, view);
    renderActions();
    startBlockClock(stamp, view);
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
    return html`Paid until about <b>${formatDate(view.end)}</b>${range}, at today's storage price.`;
  }

  // The bar: the whole life of the stamp, one block per month, always filling the width. Spent time veiled,
  // today as the line, the time ahead bright, and the estimate dissolving across the end.
  // Each month is an <i>; its colour layers, the fill and the spent veil, are <b>s.
  function renderBar(view, enter) {
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
    const count = Math.max(1, Math.ceil(life));
    const opacity = x => view.expired ? 1 : clamp01((fadeEnd - x) / (fadeEnd - fadeStart));

    const fills = [];
    const months = Array.from({ length: count }, (_, m) => {
      const month = document.createElement('i');
      month.className = 'month';
      if (life - m > 0) {
        const fill = layer('fill');
        fill.style.webkitMask = fill.style.mask = fadeMask(m, fadeStart, fadeEnd, opacity);
        month.append(fill);
        fills.push(fill);
      }
      const spentShare = clamp01(spent - m);
      if (spentShare > 0 && !view.expired) {
        const veil = layer('spent');
        veil.style.setProperty('--q', spentShare * 100 + '%');
        month.append(veil);
      }
      if (!view.expired && spent >= m && spent < m + 1) {
        month.classList.add('now');
        month.style.setProperty('--x', (spent - m) * 100 + '%');
      }
      return month;
    });
    bar.style.setProperty('--n', count);
    bar.replaceChildren(...months);
    if (enter && !view.expired && !prefersReducedMotion()) playEnter(fills);

    $('startCap').textContent = 'Created ' + formatDayMonth(view.created);
    $('endCap').innerHTML = view.expired
      ? (view.end ? html`ran out ${formatDayMonth(view.end)}` : '')
      : html`<span aria-hidden="true">~</span><span class="sr">about </span>${formatDayMonth(view.end)}`;
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

  // The names, ranked by days given, and the open slot as the quiet way in while the stamp is paid.
  function renderKeepers(stamp, view, yourTx) {
    const keepers = keepersOf(stamp, yourTx);
    const recent = view.now - JUST_NOW_MS;
    const rows = keepers.map((keeper, i) =>
      listItem(keeper.key, keeper.you ? 'you' : '', keeperRow(keeper, i + 1, view, new Date(keeper.last.time) >= recent)));
    if (!view.expired) rows.push(listItem('slot', 'slot', openSlotRow(keepers.length + 1, stamp)));
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

  function keeperRow(keeper, rank, view, justNow) {
    const who = keeper.you
      ? html`<span>You</span>`
      : externalLink(GNOSISSCAN + '/address/' + keeper.address, abbreviate(keeper.address, 6, 4), 'chain-link', 'address on Gnosisscan');
    const tx = externalLink(GNOSISSCAN + '/tx/' + keeper.last.tx, abbreviate(keeper.last.tx, 8, 0), 'chain-link', 'transaction on Gnosisscan');
    const usd = !view.expired && keeper.usdKnown ? html`<span class="usd">${formatUsd(keeper.usd)}</span>` : '';
    return html`<span class="pos">${rank}</span>
      <span class="who">${who}<small>${keeperLine(keeper, justNow)} · tx ${tx}</small></span>
      <span class="amt">${formatDays(keeper.days)}${usd}</span>`;
  }

  // "Owner, created the stamp, 9 Oct", "Kept it alive 3 times, last 12 Oct", "Kept it alive, just now"…
  function keeperLine(keeper, justNow) {
    const when = formatDayMonth(new Date(keeper.last.time));
    if (keeper.created) {
      const who = keeper.owner ? 'Owner, created' : 'Created';
      return keeper.payments > 1
        ? who + ' it and kept it alive ' + plural(keeper.payments - 1, 'time') + ', last ' + when
        : who + ' the stamp, ' + when;
    }
    if (keeper.you && justNow) return 'Kept it alive, just now';
    const kept = keeper.owner ? 'Owner, kept' : 'Kept';
    return keeper.payments > 1
      ? kept + ' it alive ' + plural(keeper.payments, 'time') + ', last ' + when
      : kept + ' it alive, ' + when;
  }

  function openSlotRow(rank, stamp) {
    const perDay = stamp.pricing && stamp.pricing.usdPerDay;
    const from = perDay ? ' from about ' + formatUsd(perDay * OPEN_SLOT_DAYS) : '';
    return html`<span class="pos">${rank}</span>
      <span class="who">Open<small>Keep it alive: ${OPEN_SLOT_DAYS} days${from}, any wallet</small></span>
      <span class="amt"><button type="button" class="btn slot-btn" data-action="add-time" aria-haspopup="dialog"
        aria-label="Take it, add time to this stamp">Take it</button></span>`;
  }

  // The facts, as Batch Explorer shows them, and the embed lines.
  function renderDetails(stamp, view) {
    const ownerShort = abbreviate(stamp.owner, 6, 4);
    $('batchId').textContent = stamp.batchId;
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
    $('donateCode').textContent = '<script src="' + DONATE_JS + '" data-batch="' + stamp.batchId + '"></script>';
    $('donateOwner').textContent = ownerShort;
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

  // The Add time sheet: three durations, each counted from the current end and priced at today's price.
  // Each BZZ amount has its dollar equivalent underneath.
  function renderSheet(stamp, view) {
    const options = $('opts');
    const hadFocus = options.contains(document.activeElement);
    $('sheetLead').textContent = 'Extends the whole stamp, ' + stamp.capacity + ', for everyone who uses it. It does not make it yours.';
    options.innerHTML = html`${DURATIONS.map(duration => durationOption(duration, view.end, stamp.pricing || {}))}`;
    if (hadFocus) checkedOption().focus();
  }

  function durationOption({ days, label }, end, { bzzPerDay, usdPerDay }) {
    const on = days === chosenDays;
    const until = end ? 'to about ' + formatDate(new Date(end.getTime() + days * DAY_MS)) : '';
    const usd = usdPerDay ? '≈ ' + formatUsd(usdPerDay * days) : '';
    const price = bzzPerDay
      ? html`<b>≈ ${formatBzz(bzzPerDay * days)}</b>${usd ? html`<small>${usd}</small>` : ''}`
      : usd ? html`<b>${usd}</b>` : '';
    return html`<button type="button" class="opt" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}"
        data-action="choose-duration" data-days="${days}">
      <span><b>${label}</b><small>${until}</small></span><span class="price">${price}</span>
    </button>`;
  }

  // Add time and Take it: off when there is nothing to add to, and while a top up is being handed off or on its way.
  function renderActions() {
    const busy = Boolean(pending) || handingOff;
    $('addBtn').disabled = !isActive(current) || busy;
    $('addSub').textContent = current && current.status === 'expired' ? 'the stamp has run out' : 'Extend with any wallet';
    for (const button of document.querySelectorAll('.slot-btn')) button.disabled = busy;
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
    $('months').style.setProperty('--n', 3);
    $('months').innerHTML = '<i class="month"></i>'.repeat(3);
    $('rank').innerHTML = '<li><span class="pos"></span><span class="who">Reading the history…</span><span class="amt"></span></li>';
    $('addBtn').disabled = true;
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
      <p>The stamp service did not answer. The stamp itself may be fine: it lives on Gnosis, not here.</p>
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


  // ---------- 6. Motion: new time arriving
  // Rendering never animates by itself. For an update, showStamp() measures the old layout, renders the new one,
  // and playArrival() moves everything from where it was to where it is now.

  function measureLayout() {
    const rect = el => el.getBoundingClientRect();
    return {
      months: [...$('months').children].map(month => { const r = rect(month); return { left: r.left, width: r.width }; }),
      rows: new Map([...$('rank').children].map(li => [li.dataset.key, rect(li).top])),
      listHeight: rect($('rank')).height,
      days: parseInt($('days').textContent, 10) || 0
    };
  }

  // First sight: the months add up one by one.
  function playEnter(fills) {
    const { duration, stagger } = MOTION.enter;
    fills.forEach((fill, i) => fill.animate(GROW, { duration, easing: EASE_OUT, delay: i * stagger, fill: 'backwards' }));
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
    playMonths(before);
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

  // The months already on the bar glide narrower to make room, then the new months settle in at the end.
  // When the new time fits inside the last month, that block refreshes in place.
  function playMonths(before) {
    const bar = $('months'), months = [...bar.children], oldCount = before.months.length;
    const grew = months.length > oldCount;
    if (grew) {
      months.slice(0, oldCount).forEach((month, i) => {
        const now = month.getBoundingClientRect(), was = before.months[i];
        const from = 'translateX(' + (was.left - now.left) + 'px) scaleX(' + (was.width / now.width) + ')';
        month.animate([{ transformOrigin: 'left center', transform: from }, { transformOrigin: 'left center', transform: 'none' }],
          { duration: MOTION.glide.duration, easing: EASE_IN_OUT });
      });
    }
    const fresh = months.slice(grew ? oldCount : months.length - 1);
    const { duration, delay, stagger, todayAfter } = MOTION.settle;
    fresh.forEach((month, i) => month.animate(GROW, { duration, easing: EASE_OUT, delay: delay + i * stagger, fill: 'backwards' }));
    // the Today line steps aside while the months move, and comes back once they have settled
    bar.classList.add('morphing');
    later('morphing', () => bar.classList.remove('morphing'), delay + fresh.length * stagger + todayAfter);
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


  // ---------- 7. Add time: the sheet, the hand off to Beeport, waiting for the chain

  // The sheet is modal: the page behind it is inert while it is open, and focus goes back where it came from.
  function openSheet(trigger) {
    if (!isActive(current) || pending || handingOff) return;
    opener = trigger;
    setSheetOpen(true);
    checkedOption().focus();
  }

  function closeSheet() {
    setSheetOpen(false);
    if (opener && opener.isConnected && !opener.disabled) opener.focus();
    opener = null;
  }

  function setSheetOpen(open) {
    $('sheet').hidden = $('scrim').hidden = !open;
    for (const el of document.querySelectorAll('#devbar, .hdr, main, footer')) el.inert = open;
  }

  const checkedOption = () => $('opts').querySelector('[aria-checked="true"]');

  function chooseDuration(option) {
    chosenDays = Number(option.dataset.days);
    for (const each of $('opts').children) {
      const on = each === option;
      each.setAttribute('aria-checked', on);
      each.tabIndex = on ? 0 : -1;
    }
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

  // Continue to Beeport: check the stamp once more, then hand off. The tab is opened inside the click, so popup
  // blockers allow it, and pointed at Beeport once the check is done. Without a tab, Beeport opens in this one.
  async function continueToBeeport() {
    closeSheet();
    const tab = DEMO ? null : window.open('about:blank', '_blank');
    handingOff = true;
    renderActions();
    const stamp = await checkAgain(current);
    handingOff = false;
    if (!isActive(stamp)) {
      if (tab) tab.close();
      showStamp(stamp);
      return toast(stamp.status === 'expired' ? 'This stamp has run out. Time can no longer be added to it.' : 'This stamp could not be found.');
    }
    // txs: every contribution there before paying, so the visitor's own can be told apart when it lands
    const handoff = { id: stamp.batchId, at: Date.now(), txs: txsOf(stamp) };
    session.set(KEYS.handoff, handoff);
    const url = BEEPORT.replace('{id}', stamp.batchId).replace('{days}', chosenDays);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else if (!DEMO) {
      location.href = url;
      return;
    }
    waitForTopUp(handoff);
    $('waiting').focus({ preventScroll: true });   // somewhere sensible for keyboard focus while the buttons are off
  }

  // The stamp once more, just before paying. Without an answer, hand off with the last read: the chain itself
  // refuses a top up on a batch that ran out.
  async function checkAgain(stamp) {
    if (DEMO) return stamp;
    try { return await fetchStamp(stamp.batchId, null, PREFLIGHT_TIMEOUT_MS); } catch (e) { return stamp; }
  }

  // The waiting note, with Add time off, from the hand off until the top up is seen or given up on. Keyboard focus
  // parked on the note moves to the heading when the note goes.
  function setPending(handoff) {
    const hadFocus = document.activeElement === $('waiting');
    pending = handoff;
    $('waiting').hidden = !handoff;
    if (!handoff) stop('wait');
    renderActions();
    if (!handoff && hadFocus) document.querySelector('.meter h1').focus({ preventScroll: true });
  }

  // The top up landed: this tab remembers it as the visitor's and forgets the hand off.
  function claimTopUp(handoff, yours) {
    session.set(KEYS.you, { id: handoff.id, tx: yours.tx });
    session.remove(KEYS.handoff);
  }

  // Polls for the visitor's top up. When it lands, it plays once the visitor is looking, with You on their row.
  function waitForTopUp(handoff) {
    setPending(handoff);
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const interval = DEMO ? DEMO_POLL_MS : POLL_MS;
    const tick = async () => {
      let stamp = null;
      try { stamp = await fetchStamp(handoff.id, DEMO ? 'topped' : null); } catch (e) { /* try again on the next tick */ }
      if (pending !== handoff) return;   // cancelled while the request was out
      const yours = stamp && landedTopUp(stamp, handoff);
      if (yours) {
        claimTopUp(handoff, yours);
        return whenVisible(() => {
          if (pending !== handoff) return;
          setPending(null);
          showStamp(stamp, { animate: 'update' });
          toast(addedNote(yours.days, stamp));
        });
      }
      const timedOut = Date.now() - handoff.at > WAIT_MAX_MS;
      // still away, perhaps paying across chains: look once more when the visitor is back, then give up
      if (timedOut && document.hidden && !DEMO) return whenVisible(() => { if (pending === handoff) tick(); });
      // the demo has one top up to show; for real, give up after ten minutes
      if (DEMO || timedOut) {
        session.remove(KEYS.handoff);
        setPending(null);
        return toast('Not seen on chain yet. Check Batch Explorer in a minute.');
      }
      later('wait', tick, interval);
    };
    later('wait', tick, interval);
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


  // ---------- 8. Feedback: toast, announcements, copy

  // A short note at the bottom of the screen. Screen readers hear `say`, which is the note itself by default.
  function toast(message, { ms = TOAST_MS, say = message } = {}) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    announce(say);
    later('toast', () => { el.hidden = true; }, ms);
  }

  // What the note says when time arrives.
  const addedNote = (days, stamp) => 'Added ' + formatDays(days) + '. Paid until about ' + formatDate(new Date(stamp.expiry.time)) + '.';
  const landedNote = days => 'Your top up landed: ' + formatDays(days) + ' added.';
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
    if (pending) setPending(null);    // the hand off lives in sessionStorage: the wait is rebuilt below if still needed
    try {
      const { landed, onTheWay } = settleHandoff(stamp);
      showWithChanges(stamp, demo, landed);
      if (onTheWay) waitForTopUp(onTheWay);
      if (!demo && stamp.status !== 'not_found') keepFresh(stamp.batchId);
    } catch (e) {
      // checked() let the document through, so a throw here is a bug: log it, and never leave half a page
      console.error(e);
      renderError(id);
    }
  }

  // A top up handed off from this tab earlier. If it landed, it becomes yours before anything is drawn; if it is
  // still on its way, the wait resumes. Returns { landed } or { onTheWay }, or neither.
  function settleHandoff(stamp) {
    const handoff = session.get(KEYS.handoff);
    if (!handoff || handoff.id !== stamp.batchId || !Array.isArray(handoff.txs)) return {};
    if (Date.now() - handoff.at > WAIT_MAX_MS || !isActive(stamp)) {
      session.remove(KEYS.handoff);
      return {};
    }
    const landed = landedTopUp(stamp, handoff);
    if (!landed) return { onTheWay: handoff };
    claimTopUp(handoff, landed);
    return { landed };
  }

  // Shows a stamp and plays whatever time arrived since it was last seen:
  //   on screen already (a return from Beeport, the demo's After top up): the new time arrives in place
  //   seen on an earlier visit, in this browser: that version shows for a beat, then the new time arrives
  //   otherwise: the months add up on first sight
  // `landed` is the visitor's own top up, just settled, so the note can say so.
  function showWithChanges(stamp, demo, landed) {
    const onScreen = isActive(current) && current.batchId === stamp.batchId ? current : null;
    const remembered = onScreen ? null : rememberedVersion(stamp.batchId);
    const added = addedSince(onScreen || remembered, stamp);
    if (!added.length) return showStamp(stamp, { animate: onScreen ? null : 'enter' });

    const gained = daysIn(added);
    const yours = Boolean(landed) && added.some(c => c.tx === landed.tx);
    if (onScreen) {
      // the demo's After top up plays as if the newest top up were yours
      const yourTx = demo === 'topped' ? added[added.length - 1].tx : yourTxFor(stamp.batchId);
      showStamp(stamp, { animate: 'update', yourTx });
      return toast(yours ? landedNote(gained) : addedNote(gained, stamp));
    }
    showStamp(remembered);
    const run = generation;
    later('replay', () => whenVisible(() => {
      if (run !== generation || current !== remembered) return;   // something newer is on screen by now
      showStamp(stamp, { animate: 'update' });
      toast(yours ? landedNote(gained) : sinceNote(gained));
    }), prefersReducedMotion() ? 0 : MOTION.replay);
  }

  // Re reads once per price round. Skipped while a top up is on its way: the wait polls more often and plays the arrival.
  function keepFresh(batchId) {
    const run = generation;
    every('refresh', async () => {
      if (pending) return;
      let fresh;
      try { fresh = await fetchStamp(batchId); } catch (e) { return; }   // keep what is on screen
      if (run !== generation || pending) return;
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
    session.remove(KEYS.handoff);
    setPending(null);
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
    'add-time': openSheet,
    'close-sheet': closeSheet,
    'choose-duration': chooseDuration,
    'continue': continueToBeeport,
    'copy': copy,
    'retry': retry,
    'demo': switchDemo
  };

  document.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (target && !target.disabled) ACTIONS[target.dataset.action](target);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
    else if (e.target.closest('#opts')) moveChoice(e);
  });

  // The live block catches up as soon as the tab is looked at again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && paintBlockClock) paintBlockClock(); });

  // Back from Beeport in the same tab, the page may come from the back/forward cache: read the stamp again.
  // The demo's documents never change, so a demo page comes back as it was left.
  window.addEventListener('pageshow', e => { if (e.persisted && !DEMO) start(); });

  if (DEMO && params.get('bare') !== '1') {
    $('devbar').hidden = false;
    markPressed(DEMO);
  }
  start();
})();
