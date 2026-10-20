/*
  Stamptime: one stamp read straight from Gnosis, in the browser. No server between the page and the chain.

  readStamp(id) returns the document described in api/stamp.schema.json, the same one an API would send, so the
  page does not need to know where it came from. Everything comes from the PostageStamp contract, through the first of
  the RPCs it is given that answers. A stamp seen for the first time costs three requests to the RPC, since calls made
  together go out as one JSON-RPC batch:
    1. the latest block, which every live value is read at
    2. the batch's own events (BatchCreated, BatchTopUp, BatchDepthIncrease), one eth_getLogs filtered by batch id,
       which is how Batch Explorer reads a batch; currentTotalOutPayment() and lastPrice(); and samples of the
       PriceUpdate events of the last 30 days, for the range (section 4)
    3. for each payment, the sender of its transaction, since BatchTopUp carries no payer, and the PriceUpdate in force
       at its block, for the days it bought; for an active stamp, the stretches of the 30 days that hold the lowest
       and the highest price
  A page can show the stamp before step 3: readStamp() hands it a first look as soon as the balance is read (section
  8). An expired stamp then walks the price history to find when it ran out (section 6). Plus, only when asked with
  `withUsd`, one request to CoinGecko for BZZ to USD over the last year, the source Batch Explorer uses. The page
  never asks: it shows BZZ alone.

  What cannot change (senders, past prices, block times, the samples and stretches of the range) is kept for the life
  of the tab, and the event lists only fetch what is new, so a re read while the page stays open costs two small
  requests.

  The file reads top to bottom:
    1. Constants                   5. The price a payment was made at
    2. What this tab remembers     6. When an expired stamp ran out
    3. Reading the chain           7. Dollars
    4. The range                   8. The document
*/
import { createClient, decodeEventLog, decodeFunctionResult, getAddress, http, numberToHex, toFunctionSelector } from './vendor/viem.js';


// ---------- 1. Constants

const CONTRACT = getAddress('0x45a1502382541cd610cc9068e88727426b696293');   // PostageStamp, as in Batch Explorer
const DEPLOY_BLOCK = 31305656n;
const CHAIN_ID = 100;
const BLOCK_SECONDS = 5;
const BLOCKS_PER_DAY = 17280;
const PLUR_PER_BZZ = 1e16;
const ROUND_BLOCKS = 152n;                         // the price changes at most once a round, in a block of that round
const RANGE_BLOCKS = 30n * 17280n;                 // the range uses the lowest and highest price of the last 30 days
const SAMPLE_STEP = 53n * ROUND_BLOCKS;            // the range samples one round in 53, about every 11 hours
const REFINE = 3;                                  // ...and reads whole the stretches beside its 3 highest and 3 lowest
const REORG_BLOCKS = 20n;                          // the newest blocks are read again each time, in case they changed
// How far before a payment to look for the price in force. The price changes about every 13 minutes, so the first
// window almost always has it.
const PRICE_WINDOWS = [2000n, 20000n, 200000n];
// How far to walk the price history for when an expired stamp ran out: six times 30 days from its creation, or seven
// back from today.
const WALK_FORWARD_BLOCKS = 6n * RANGE_BLOCKS;
const WALK_BACK_BLOCKS = 7n * RANGE_BLOCKS;
// Payments read at once: two calls each, all in one batch, so a stamp with up to 24 payments needs one round trip
// for them, not one per 6.
const CONCURRENCY = 24;
const BATCH_SIZE = 100;                            // calls in one JSON-RPC batch, at most
const PRICE_UPDATE_TOPIC = '0xae46785019700e30375a5d7b4f91e32f8060ef085111f896ebf889450aa2ab5a';   // PriceUpdate(uint256)
const USD_URL = 'https://api.coingecko.com/api/v3/coins/swarm-bzz/market_chart?vs_currency=usd&days=365&interval=daily';
const USD_TIMEOUT_MS = 5000;
const USD_MAX_AGE_MS = 60 * 60 * 1000;

const EVENTS = [
  { type: 'event', name: 'BatchCreated', inputs: [
    { name: 'batchId', type: 'bytes32', indexed: true }, { name: 'totalAmount', type: 'uint256' },
    { name: 'normalisedBalance', type: 'uint256' }, { name: 'owner', type: 'address' }, { name: 'depth', type: 'uint8' },
    { name: 'bucketDepth', type: 'uint8' }, { name: 'immutableFlag', type: 'bool' }] },
  { type: 'event', name: 'BatchTopUp', inputs: [
    { name: 'batchId', type: 'bytes32', indexed: true }, { name: 'topupAmount', type: 'uint256' },
    { name: 'normalisedBalance', type: 'uint256' }] },
  { type: 'event', name: 'BatchDepthIncrease', inputs: [
    { name: 'batchId', type: 'bytes32', indexed: true }, { name: 'newDepth', type: 'uint8' },
    { name: 'normalisedBalance', type: 'uint256' }] },
  { type: 'event', name: 'PriceUpdate', inputs: [{ name: 'price', type: 'uint256' }] }
];
const VIEWS = [
  { type: 'function', name: 'lastPrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'currentTotalOutPayment', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }
];

// Usable volume per depth, unencrypted and without erasure coding: the Effective Utilisation Tables in the Swarm docs
// (Postage Stamps). 2^depth x 4 KB would be the theoretical maximum, which overstates what fits.
const EFFECTIVE_VOLUME = {
  17: '44.70 kB', 18: '6.66 MB', 19: '112.06 MB', 20: '687.62 MB', 21: '2.60 GB', 22: '7.73 GB', 23: '19.94 GB',
  24: '47.06 GB', 25: '105.51 GB', 26: '227.98 GB', 27: '476.68 GB', 28: '993.65 GB', 29: '2.04 TB', 30: '4.17 TB',
  31: '8.45 TB', 32: '17.07 TB', 33: '34.36 TB', 34: '69.04 TB', 35: '138.54 TB', 36: '277.72 TB', 37: '556.35 TB',
  38: '1.11 PB', 39: '2.23 PB', 40: '4.46 PB', 41: '8.93 PB'
};


// ---------- 2. What this tab remembers

const clients = new Map();          // rpc url -> viem client
let lastAnswered = null;            // the rpc url that gave the last whole document
const histories = new Map();        // batch id -> { safe, events }: its events up to block `safe`, which cannot change
const sampledRounds = new Map();    // first block of a sampled round -> its PriceUpdate events (section 4)
const wholeStretches = new Map();   // first block of a stretch read whole -> its PriceUpdate events (section 4)
let sinceLastSample = { from: -1n, safe: -1n, events: [] };   // PriceUpdate events from the last sample on
const senders = new Map();          // tx hash -> who sent it
const pricesAt = new Map();         // 'block:logIndex' of a payment -> the price it was made at
const blockTimes = new Map();       // block number -> unix seconds
const ranOut = new Map();           // batch id -> the block an expired batch ran out at, or null
let usd = { at: 0, series: null };  // BZZ to USD, one point a day, the last one live


// ---------- 3. Reading the chain

const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const minOf = (list, start) => list.reduce((min, x) => x < min ? x : min, start);
const maxOf = (list, start) => list.reduce((max, x) => x > max ? x : max, start);
const byValue = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// One client per RPC. Calls made in the same tick go out as one JSON-RPC batch, so each step of a read is one request
// however many calls it makes. A short timeout and one retry, so that a node that hangs leaves the next one time to
// answer within the page's 10 s.
function clientFor(rpc) {
  if (!clients.has(rpc)) {
    clients.set(rpc, createClient({ transport: http(rpc, { batch: { batchSize: BATCH_SIZE }, timeout: 4000, retryCount: 1 }) }));
  }
  return clients.get(rpc);
}

// `fn` over `items` with at most `limit` in flight, results in order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// `read()` once per key for the life of the tab, for what cannot change any more.
async function once(map, key, read) {
  if (!map.has(key)) map.set(key, await read());
  return map.get(key);
}

// The calls below are raw JSON-RPC, decoded with viem: its readContract, getBlock and getTransaction actions would
// bring 72 KB of formatters and contract error handling for the two fields each of them is read for.

// PostageStamp events between two blocks. Raw eth_getLogs rather than viem's getLogs, to keep the blockTimestamp the
// Gnosis nodes return with each log, which saves a block read per event. Events of other shapes are skipped.
async function eventsBetween(client, topics, from, to) {
  if (to < from) return [];
  const raw = await client.request({
    method: 'eth_getLogs',
    params: [{ address: CONTRACT, topics, fromBlock: numberToHex(from), toBlock: numberToHex(to) }]
  });
  const events = [];
  for (const log of raw) {
    let decoded;
    try { decoded = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics }); } catch (e) { continue; }
    events.push({
      name: decoded.eventName,
      args: decoded.args,
      block: BigInt(log.blockNumber),
      index: Number(log.logIndex),
      tx: log.transactionHash,
      time: log.blockTimestamp ? Number(log.blockTimestamp) : null
    });
  }
  return events.sort((a, b) => a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1);
}

const priceUpdatesBetween = (client, from, to) => eventsBetween(client, [PRICE_UPDATE_TOPIC], from, to);

// A view of PostageStamp at one block, decoded by its ABI.
async function view(client, functionName, blockNumber) {
  const fn = VIEWS.find(f => f.name === functionName);
  const data = await client.request({
    method: 'eth_call',
    params: [{ to: CONTRACT, data: toFunctionSelector(fn) }, numberToHex(blockNumber)]
  });
  return decodeFunctionResult({ abi: [fn], functionName, data });
}

// The latest block, or the one numbered `blockNumber`: its number and its time.
async function blockAt(client, blockNumber) {
  const block = await client.request({
    method: 'eth_getBlockByNumber',
    params: [blockNumber == null ? 'latest' : numberToHex(blockNumber), false]
  });
  if (!block) throw new Error('No block ' + (blockNumber ?? 'latest'));
  return { number: BigInt(block.number), timestamp: Number(block.timestamp) };
}

async function timeOfBlock(client, blockNumber) {
  if (!blockTimes.has(blockNumber)) blockTimes.set(blockNumber, (await blockAt(client, blockNumber)).timestamp);
  return blockTimes.get(blockNumber);
}

const timeOf = (client, event) => event.time != null ? Promise.resolve(event.time) : timeOfBlock(client, event.block);

async function senderOf(client, hash) {
  if (!senders.has(hash)) {
    const tx = await client.request({ method: 'eth_getTransactionByHash', params: [hash] });
    if (!tx) throw new Error('No transaction ' + hash);
    senders.set(hash, getAddress(tx.from));
  }
  return senders.get(hash);
}

// Every event of one batch, from the contract's deployment to `head`. The first read asks for all of it; later ones
// keep what is older than REORG_BLOCKS and ask only for the rest.
async function batchEvents(client, id, head) {
  const known = histories.get(id) || { safe: DEPLOY_BLOCK - 1n, events: [] };
  const kept = known.events.filter(e => e.block <= known.safe);
  const fresh = await eventsBetween(client, [null, '0x' + id], known.safe + 1n, head);
  const events = kept.concat(fresh);
  histories.set(id, { safe: head - REORG_BLOCKS, events });
  return events;
}


// ---------- 4. The range: the lowest and the highest price of the last 30 days
//
// Every PriceUpdate of 30 days is about 3,300 events: 1.6 MB of JSON, 300 KB gzipped, four times the page's own code.
// The price changes at most once a round, by at most 0.08%, so its lowest and highest points lie next to the lowest
// and highest of a few samples taken across the 30 days, or at either end when it trends. So this reads:
//   - in step 2 of a read, the samples: one whole round every SAMPLE_STEP blocks, 64 or 65 rounds, each holding that
//     round's PriceUpdate unless the oracle skipped it, and every block after the last sample
//   - in step 3, for an active stamp only, whole stretches: where the 30 days start, and on either side of the REFINE
//     highest and the REFINE lowest samples, past any sample that came back empty
// About 500 events instead of 3,300. Replayed every 3 hours over 430 days of real prices, it found the same lowest and
// highest price as reading all of them at 2,580 of 2,581 heads; the one miss moved an end by 50 minutes, and the "give
// or take" shown never changed.
// Samples and stretches start at fixed blocks, so a re read finds them again in what this tab remembers, and asks
// only for what came after the last sample.

// Where the samples of the 30 days before `head` start: at the start of a round every SAMPLE_STEP blocks, once the
// round is complete and cannot change.
function sampleStarts(head) {
  const starts = [];
  const first = (head - RANGE_BLOCKS + SAMPLE_STEP - 1n) / SAMPLE_STEP * SAMPLE_STEP;
  for (let start = first; start + ROUND_BLOCKS - 1n <= head - REORG_BLOCKS; start += SAMPLE_STEP) starts.push(start);
  return starts;
}

// The samples, each a list of PriceUpdate events, and the events from the end of the last sample to `head`.
async function samplePrices(client, head) {
  const starts = sampleStarts(head);
  for (const map of [sampledRounds, wholeStretches]) {
    for (const start of map.keys()) if (start < starts[0] - SAMPLE_STEP) map.delete(start);   // out of the 30 days
  }
  const [rounds, tail] = await Promise.all([
    Promise.all(starts.map(start => once(sampledRounds, start, () => priceUpdatesBetween(client, start, start + ROUND_BLOCKS - 1n)))),
    pricesSince(client, starts[starts.length - 1] + ROUND_BLOCKS, head)
  ]);
  return { starts, rounds, tail };
}

// PriceUpdate events from `from` to `head`, asking only for what is new: what is older than REORG_BLOCKS is kept.
async function pricesSince(client, from, head) {
  const known = sinceLastSample.from <= from ? sinceLastSample : { from, safe: from - 1n, events: [] };
  const kept = known.events.filter(e => e.block >= from && e.block <= known.safe);
  const start = known.safe >= from ? known.safe + 1n : from;
  const fresh = await priceUpdatesBetween(client, start, head);
  sinceLastSample = { from, safe: head - REORG_BLOCKS, events: kept.concat(fresh) };
  return sinceLastSample.events;
}

// The lowest and the highest price of the 30 days before `head`, today's `price` among them. Stretch i runs from the
// end of sample i to the start of sample i + 1; the one before the first sample takes in the whole step before it,
// since the 30 days may start there; the one after the last sample is the `tail`, already read.
// A sample whose round had no PriceUpdate says nothing: the oracle sometimes skips dozens of rounds. So from each
// chosen sample the stretches are read on either side up to the nearest sample that holds one, and so are all of them
// before the first sample that holds one, where the 30 days start.
async function priceRange(client, head, price, { starts, rounds, tail }) {
  const prices = events => events.map(e => e.args.price);
  const held = rounds.map((events, i) => ({ i, prices: prices(events) })).filter(sample => sample.prices.length)
    .map(({ i, prices: p }) => ({ i, low: minOf(p, p[0]), high: maxOf(p, p[0]) }));
  const highest = [...held].sort((a, b) => byValue(b.high, a.high)).slice(0, REFINE);
  const lowest = [...held].sort((a, b) => byValue(a.low, b.low)).slice(0, REFINE);
  const holds = i => rounds[i].length > 0;
  const beside = new Set();
  if (!held.length) for (let k = -1; k < starts.length - 1; k++) beside.add(k);   // no sample said anything: all of it
  for (const { i } of held.length ? [held[0], ...highest, ...lowest] : []) {
    for (let k = i - 1; k >= -1; k--) { beside.add(k); if (k < 0 || holds(k)) break; }
    for (let k = i; k < starts.length - 1; k++) { beside.add(k); if (holds(k + 1)) break; }
  }
  const stretches = await Promise.all([...beside].filter(i => i < starts.length - 1).map(i => {
    const from = i < 0 ? starts[0] - SAMPLE_STEP : starts[i] + ROUND_BLOCKS;
    return once(wholeStretches, from, () => priceUpdatesBetween(client, from, starts[i + 1] - 1n));
  }));
  const from = head - RANGE_BLOCKS;
  const all = [rounds, tail, stretches].flat(2).filter(e => e.block >= from);
  return { lowest: minOf(prices(all), price), highest: maxOf(prices(all), price) };
}


// ---------- 5. The price a payment was made at

// The last PriceUpdate before the payment, in the same block counting only the ones before it, from a window of
// blocks before it, a wider one if that holds none.
async function priceAt(client, payment) {
  const key = payment.block + ':' + payment.index;
  if (pricesAt.has(key)) return pricesAt.get(key);
  const before = p => p.block < payment.block || (p.block === payment.block && p.index < payment.index);
  let found = null;
  for (const span of PRICE_WINDOWS) {
    found = (await priceUpdatesBetween(client, payment.block - span, payment.block)).filter(before).pop();
    if (found) break;
  }
  if (!found) throw new Error('No PriceUpdate before block ' + payment.block);
  pricesAt.set(key, found.args.price);
  return found.args.price;
}


// ---------- 6. When an expired stamp ran out

// The contract forgets when a batch ran out, but the price history does not. The total paid out per chunk grows by
// the price in force every block (a price set at block b applies from b + 1), and the batch ran out at the first
// block where that total reached its balance. Two ends to walk from:
//   - today, where the total has run past the balance by `overshoot`, walking back
//   - the creation, where BatchCreated pins the total exactly (its balance minus what it paid per chunk), forward
// It starts from the end that looks closer, judging by `lifeBlocks`, the life its payments bought, and tries the other
// if that one gives up. Expired is final, the contract refuses top ups on it, so this runs once per batch and tab.
// Null when the block is further than the walks go: WALK_FORWARD_BLOCKS from the creation, WALK_BACK_BLOCKS from today.
//
// Every PriceUpdate a walk passes has to be read, about 110 a day, so it reads in windows sized by a guess at how far
// it has to go: the guess, a quarter more and a day, then twice as much each time, never more than 30 days at once. A
// stamp that ran out a week after its creation costs a week and a half of prices, not 30 days of them.
async function ranOutBlock(client, { created, createdPrice, balance, totalOut, head, lowPrice, lastEvent, lifeBlocks }) {
  const overshoot = totalOut - balance;
  const back = () => walkBack(client, overshoot, head, overshoot / lowPrice);
  const forward = () => walkForward(client, created, createdPrice, balance, head, lifeBlocks);
  const [first, second] = lifeBlocks <= head - created.block - lifeBlocks ? [forward, back] : [back, forward];
  const block = (await first()) ?? (await second());
  return block != null && block > lastEvent && block <= head ? block : null;
}

const firstWindow = guess => minOf([guess + guess / 4n + BigInt(BLOCKS_PER_DAY)], RANGE_BLOCKS);
const nextWindow = span => minOf([span * 2n], RANGE_BLOCKS);

// `guess`: the blocks since it ran out at the lowest price sampled in the last 30 days, which is more blocks than at
// today's price when the price has risen.
async function walkBack(client, overshoot, head, guess) {
  const limit = maxOf([head - WALK_BACK_BLOCKS], DEPLOY_BLOCK);   // the oldest block it reads
  const older = [];                           // popped newest first
  let end = head;                             // blocks (update, end] were paid at that update's price
  let windowStart = head + 1n;                // the oldest block read so far
  let span = firstWindow(guess);
  for (;;) {
    if (!older.length) {
      if (windowStart <= limit) return null;
      const from = maxOf([windowStart - span], limit);
      older.push(...await priceUpdatesBetween(client, from, windowStart - 1n));
      windowStart = from;
      span = nextWindow(span);
      continue;
    }
    const update = older.pop();
    const cost = update.args.price * (end - update.block);
    if (cost >= overshoot) return end - overshoot / update.args.price;
    overshoot -= cost;
    end = update.block;
  }
}

// `guess`: the blocks its payments bought, at the prices they were made at.
async function walkForward(client, created, createdPrice, balance, head, guess) {
  const perChunk = created.args.totalAmount / (1n << BigInt(created.args.depth));
  let need = balance - (created.args.normalisedBalance - perChunk);   // what is left to pay out after the creation
  let start = created.block;                  // blocks (start, update] are paid at `price`
  let price = createdPrice;
  const limit = created.block - 1n + WALK_FORWARD_BLOCKS;              // the newest block it reads
  let windowEnd = created.block - 1n;         // the newest block read so far
  let span = firstWindow(guess);
  const after = u => u.block > created.block || u.index > created.index;
  for (;;) {
    const updates = [];
    if (windowEnd < head) {
      if (windowEnd >= limit) return null;
      const to = minOf([windowEnd + span, head], limit);
      updates.push(...(await priceUpdatesBetween(client, windowEnd + 1n, to)).filter(after));
      windowEnd = to;
      span = nextWindow(span);
    }
    for (const update of updates) {
      const cost = price * (update.block - start);
      if (cost >= need) return start + (need + price - 1n) / price;
      need -= cost;
      start = update.block;
      price = update.args.price;
    }
    if (windowEnd >= head) return price * (head - start) >= need ? start + (need + price - 1n) / price : null;
  }
}


// ---------- 7. Dollars

// BZZ to USD over the last year, a point a day, refreshed every hour. Null when CoinGecko does not answer.
async function usdSeries() {
  if (usd.series && Date.now() - usd.at < USD_MAX_AGE_MS) return usd.series;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), USD_TIMEOUT_MS);
  try {
    const res = await fetch(USD_URL, { headers: { accept: 'application/json' }, signal: abort.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const series = (body.prices || []).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0);
    if (series.length) usd = { at: Date.now(), series };
  } catch (e) {
    console.warn('Stamptime: no BZZ to USD rate, showing BZZ alone.', e);
  } finally {
    clearTimeout(timer);
  }
  return usd.series;
}

// The rate on the day of `ms`, or null before the series starts.
function rateAt(series, ms) {
  if (!series || ms < series[0][0] - 864e5) return null;
  let rate = series[0][1];
  for (const [t, value] of series) { if (t > ms) break; rate = value; }
  return rate;
}

const rateNow = series => series ? series[series.length - 1][1] : null;

function capacityOf(depth) {
  const [value, unit] = (EFFECTIVE_VOLUME[depth] || '').split(' ');
  if (!unit) return 'about ' + (2 ** depth * 4096 / 1e12).toPrecision(2) + ' TB';
  const n = Number(value);
  return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + ' ' + unit;   // 7.7 GB, 688 MB, 45 kB
}


// ---------- 8. The document

// `id`: 64 lower case hex characters, no 0x. `rpcs`: Gnosis JSON-RPC urls, tried in order until one gives the whole
// document, starting from the one that answered last, so a node that is down costs one wait, not one per read.
// `withUsd`: true adds dollars from CoinGecko, for a document served to others. The page leaves it off.
// For a page that shows the stamp while it is read, two optional callbacks:
//   `onStep(name)`: 'block', then 'history', as each step of the read starts
//   `onFirstLook(doc, txs)`: once the balance is read, before step 3, the document as far as it is known: no
//     contributions yet, no range, and for an expired stamp no end. `txs` are the hashes of its payments, so a page
//     can tell whether time was added since it last showed the stamp. Called again if the read moves to another RPC.
export async function readStamp(id, { rpcs, withUsd = false, onStep = () => {}, onFirstLook = () => {} }) {
  const ordered = rpcs.includes(lastAnswered) ? [lastAnswered, ...rpcs.filter(rpc => rpc !== lastAnswered)] : rpcs;
  // a page's callback that throws is the page's bug: it is logged, and never stops the read
  const tell = fn => (...args) => { try { fn(...args); } catch (e) { console.error(e); } };
  const progress = { onStep: tell(onStep), onFirstLook: tell(onFirstLook) };
  let failure = new Error('No RPC to read from');
  for (const rpc of ordered) {
    try {
      const doc = await readFrom(rpc, id, withUsd, progress);
      lastAnswered = rpc;
      return doc;
    } catch (e) {
      failure = e;
      console.warn('Stamptime: could not read the stamp through ' + rpc + '.', e);
    }
  }
  throw failure;
}

async function readFrom(rpc, id, withUsd, { onStep, onFirstLook }) {
  const client = clientFor(rpc);
  const dollars = withUsd ? usdSeries() : Promise.resolve(null);   // alongside the chain reads, never in their way

  // Step 1. Every live value is read at this one block, and its time is the page's "now".
  onStep('block');
  const block = await blockAt(client);
  const head = block.number;
  const now = block.timestamp;

  // Step 2, one batch: the batch's history, what is left, and the samples of the range.
  onStep('history');
  const [events, totalOut, price, sampled] = await Promise.all([
    batchEvents(client, id, head),
    view(client, 'currentTotalOutPayment', head),
    view(client, 'lastPrice', head),
    samplePrices(client, head)
  ]);

  const created = events.find(e => e.name === 'BatchCreated');
  if (!created) return { batchId: id, status: 'not_found' };
  if (price === 0n) throw new Error('lastPrice is zero at block ' + head);

  // Replay the batch: the depth each payment was made at, and the balance after the last event. normalisedBalance is
  // per chunk and on the same scale as currentTotalOutPayment, which is how the contract itself tells what is left.
  let depth = created.args.depth;
  let balance = created.args.normalisedBalance;
  const payments = [];
  for (const e of events) {
    if (e.name === 'BatchDepthIncrease') depth = e.args.newDepth;
    if (e.name === 'BatchCreated') payments.push({ event: e, kind: 'created', amount: e.args.totalAmount, depth });
    if (e.name === 'BatchTopUp') payments.push({ event: e, kind: 'topup', amount: e.args.topupAmount, depth });
    if (e.args.normalisedBalance != null) balance = e.args.normalisedBalance;
  }
  const remaining = balance - totalOut;   // per chunk
  const active = remaining > 0n;
  const end = p => iso(now + Number(remaining / p) * BLOCK_SECONDS);
  const bzzPerDay = active ? Number(price) * 2 ** depth * BLOCKS_PER_DAY / PLUR_PER_BZZ : null;
  const stamp = { id, rpc, head, now, created, depth, active, bzzPerDay };

  // What is known now is most of what the page shows: the first look. Its creation time comes with its log.
  if (created.time != null) {
    const expiry = { time: active ? end(price) : null, earliest: null, latest: null, lastBlock: null };
    onFirstLook(stampDocument(stamp, { createdTime: created.time, expiry, rate: null, contributions: [] }),
      payments.map(p => p.event.tx));
  }

  // Step 3, one batch: who paid and the days each payment bought, and for an active stamp where its range lies.
  const [range, paid] = await Promise.all([
    active ? priceRange(client, head, price, sampled) : null,
    mapLimit(payments, CONCURRENCY, async ({ event, kind, amount, depth: depthThen }) => {
      const [address, priceThen, time] = await Promise.all([senderOf(client, event.tx), priceAt(client, event), timeOf(client, event)]);
      const perChunk = amount / (1n << BigInt(depthThen));
      return { event, kind, address, time, amount, days: Number(perChunk) / Number(priceThen) * BLOCK_SECONDS / 86400 };
    })
  ]);

  let expiry;
  if (active) {
    expiry = { time: end(price), earliest: end(range.highest), latest: end(range.lowest), lastBlock: null };
  } else {
    if (!ranOut.has(id)) {
      const createdPrice = await priceAt(client, created);
      const lastEvent = events[events.length - 1].block;
      const lifeBlocks = BigInt(Math.round(paid.reduce((sum, p) => sum + p.days, 0) * BLOCKS_PER_DAY));
      const lowPrice = minOf([sampled.rounds, sampled.tail].flat(2).map(e => e.args.price), price);
      ranOut.set(id, await ranOutBlock(client, { created, createdPrice, balance, totalOut, head, lowPrice, lastEvent, lifeBlocks }));
    }
    const block = ranOut.get(id);
    expiry = { time: block == null ? null : iso(await timeOfBlock(client, block)), earliest: null, latest: null,
      lastBlock: block == null ? null : Number(block) };
  }

  const series = await dollars;
  const contributions = paid.map(({ event, kind, address, time, amount, days }) => {
    const bzz = Number(amount) / PLUR_PER_BZZ;
    const rate = rateAt(series, time * 1000);
    return { kind, address, time: iso(time), block: Number(event.block), tx: event.tx, days, usd: rate == null ? null : bzz * rate, bzz };
  });
  return stampDocument(stamp, { createdTime: await timeOf(client, created), expiry, rate: rateNow(series), contributions });
}

// The document, from what readFrom() has read: whole at the end, or as far as it is known for the first look.
function stampDocument({ id, rpc, head, now, created, depth, active, bzzPerDay }, { createdTime, expiry, rate, contributions }) {
  return {
    batchId: id,
    status: active ? 'active' : 'expired',
    chain: { id: CHAIN_ID, contract: CONTRACT, rpc: new URL(rpc).host, block: Number(head), blockTime: iso(now) },
    owner: getAddress(created.args.owner),
    depth,
    immutable: created.args.immutableFlag,
    capacity: capacityOf(depth),
    created: { time: iso(createdTime), block: Number(created.block), tx: created.tx },
    expiry,
    pricing: { bzzPerDay, usdPerDay: bzzPerDay == null || rate == null ? null : bzzPerDay * rate },
    contributions
  };
}
