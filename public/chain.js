/*
  Stamptime: one stamp read straight from Gnosis, in the browser. No server between the page and the chain.

  readStamp(id) returns the document described in api/stamp.schema.json, the same one an API would send, so the
  page does not need to know where it came from. Everything comes from the PostageStamp contract, through the first of
  the RPCs it is given that answers:
    - the batch's own events (BatchCreated, BatchTopUp, BatchDepthIncrease), one eth_getLogs filtered by batch id,
      which is how Batch Explorer reads a batch
    - currentTotalOutPayment() and lastPrice(), both at the same block
    - PriceUpdate events: the last 30 days for the range, and the one in force at each payment for the days it bought
    - the sender of each payment's transaction, since BatchTopUp carries no payer
  plus, only when asked with `withUsd`, one request to CoinGecko for BZZ to USD over the last year, the source Batch
  Explorer uses. The page never asks: it shows BZZ alone.

  What cannot change (senders, past prices, block times) is kept for the life of the tab, and the event lists only
  fetch what is new, so the page's re reads while it stays open cost four small requests.
*/
import { createClient, decodeEventLog, getAddress, getBlock, getTransaction, http, numberToHex, readContract } from './vendor/viem.js';


// ---------- Constants

const CONTRACT = getAddress('0x45a1502382541cd610cc9068e88727426b696293');   // PostageStamp, as in Batch Explorer
const DEPLOY_BLOCK = 31305656n;
const CHAIN_ID = 100;
const BLOCK_SECONDS = 5;
const BLOCKS_PER_DAY = 17280;
const PLUR_PER_BZZ = 1e16;
const RANGE_BLOCKS = 30n * 17280n;                 // the range uses the lowest and highest price of the last 30 days
const REORG_BLOCKS = 20n;                          // the newest blocks are read again each time, in case they changed
// How far before a payment to look for the price in force. The price changes about every 13 minutes, so the first
// window almost always has it.
const PRICE_WINDOWS = [2000n, 20000n, 200000n];
const RAN_OUT_WINDOWS = 6;                         // how many 30 day windows to walk back for when an expired stamp ran out
const CONCURRENCY = 6;                             // requests in flight while reading the payments
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


// ---------- What this tab remembers

const clients = new Map();          // rpc url -> viem client
let lastAnswered = null;            // the rpc url that gave the last whole document
const histories = new Map();        // batch id -> { safe, events }: its events up to block `safe`, which cannot change
let recentPrices = { safe: -1n, list: [] };   // PriceUpdate events of the last 30 days, oldest first
const senders = new Map();          // tx hash -> who sent it
const pricesAt = new Map();         // 'block:logIndex' of a payment -> the price it was made at
const blockTimes = new Map();       // block number -> unix seconds
const ranOut = new Map();           // batch id -> the block an expired batch ran out at, or null
let usd = { at: 0, series: null };  // BZZ to USD, one point a day, the last one live


// ---------- Helpers

const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const minOf = (list, start) => list.reduce((min, x) => x < min ? x : min, start);
const maxOf = (list, start) => list.reduce((max, x) => x > max ? x : max, start);

// A short timeout and one retry, so that a node that hangs leaves the next one time to answer within the page's 10 s.
function clientFor(rpc) {
  if (!clients.has(rpc)) clients.set(rpc, createClient({ transport: http(rpc, { timeout: 4000, retryCount: 1 }) }));
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

// PostageStamp events between two blocks. Raw eth_getLogs rather than viem's getLogs, to keep the blockTimestamp the
// Gnosis nodes return with each log, which saves a getBlock per event. Events of other shapes are skipped.
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

const view = (client, functionName, blockNumber) =>
  readContract(client, { address: CONTRACT, abi: VIEWS, functionName, blockNumber });

async function timeOfBlock(client, blockNumber) {
  if (!blockTimes.has(blockNumber)) blockTimes.set(blockNumber, Number((await getBlock(client, { blockNumber })).timestamp));
  return blockTimes.get(blockNumber);
}

const timeOf = (client, event) => event.time != null ? Promise.resolve(event.time) : timeOfBlock(client, event.block);

async function senderOf(client, hash) {
  if (!senders.has(hash)) senders.set(hash, getAddress((await getTransaction(client, { hash })).from));
  return senders.get(hash);
}


// ---------- Event lists that only fetch what is new

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

// PriceUpdate events of the 30 days before `head`, oldest first.
async function pricesOfRange(client, head) {
  const from = head - RANGE_BLOCKS;
  const kept = recentPrices.list.filter(p => p.block >= from && p.block <= recentPrices.safe);
  const start = recentPrices.safe >= from ? recentPrices.safe + 1n : from;
  const fresh = await eventsBetween(client, [PRICE_UPDATE_TOPIC], start, head);
  recentPrices = { safe: head - REORG_BLOCKS, list: kept.concat(fresh) };
  return recentPrices.list;
}

// The price a payment was made at: the last PriceUpdate before it, in the same block counting only the ones before
// it. From the 30 day list when it reaches back far enough, otherwise from a window of blocks before the payment.
async function priceAt(client, payment, recent) {
  const key = payment.block + ':' + payment.index;
  if (pricesAt.has(key)) return pricesAt.get(key);
  const before = p => p.block < payment.block || (p.block === payment.block && p.index < payment.index);
  let found = recent.length && recent[0].block < payment.block ? recent.filter(before).pop() : null;
  for (const span of PRICE_WINDOWS) {
    if (found) break;
    found = (await eventsBetween(client, [PRICE_UPDATE_TOPIC], payment.block - span, payment.block)).filter(before).pop();
  }
  if (!found) throw new Error('No PriceUpdate before block ' + payment.block);
  pricesAt.set(key, found.args.price);
  return found.args.price;
}


// ---------- When an expired stamp ran out

// The contract forgets when a batch ran out, but the price history does not. The total paid out per chunk grows by
// the price in force every block (a price set at block b applies from b + 1), and the batch ran out at the first
// block where that total reached its balance. Two ends to walk from:
//   - today, where the total has run past the balance by `overshoot`, walking back
//   - the creation, where BatchCreated pins the total exactly (its balance minus what it paid per chunk), forward
// It starts from the end that looks closer, judging by `lifeBlocks`, the life its payments bought, and tries the other
// if that one gives up. Expired is final, the contract refuses top ups on it, so this runs once per batch and tab.
// Null when the block is more than RAN_OUT_WINDOWS x 30 days of price history from both ends.
async function ranOutBlock(client, { created, createdPrice, balance, totalOut, head, recent, lastEvent, lifeBlocks }) {
  const back = () => walkBack(client, totalOut - balance, head, recent);
  const forward = () => walkForward(client, created, createdPrice, balance, head);
  const [first, second] = lifeBlocks <= head - created.block - lifeBlocks ? [forward, back] : [back, forward];
  const block = (await first()) ?? (await second());
  return block != null && block > lastEvent && block <= head ? block : null;
}

async function walkBack(client, overshoot, head, recent) {
  const older = recent.slice();               // popped newest first
  let end = head;                             // blocks (update, end] were paid at that update's price
  let windowStart = head - RANGE_BLOCKS;
  for (let windows = 0; ;) {
    if (!older.length) {
      if (++windows > RAN_OUT_WINDOWS || windowStart <= DEPLOY_BLOCK) return null;
      const from = windowStart - RANGE_BLOCKS > DEPLOY_BLOCK ? windowStart - RANGE_BLOCKS : DEPLOY_BLOCK;
      older.push(...await eventsBetween(client, [PRICE_UPDATE_TOPIC], from, windowStart - 1n));
      windowStart = from;
      continue;
    }
    const update = older.pop();
    const cost = update.args.price * (end - update.block);
    if (cost >= overshoot) return end - overshoot / update.args.price;
    overshoot -= cost;
    end = update.block;
  }
}

async function walkForward(client, created, createdPrice, balance, head) {
  const perChunk = created.args.totalAmount / (1n << BigInt(created.args.depth));
  let need = balance - (created.args.normalisedBalance - perChunk);   // what is left to pay out after the creation
  let start = created.block;                  // blocks (start, update] are paid at `price`
  let price = createdPrice;
  let windowEnd = created.block - 1n;
  const after = u => u.block > created.block || u.index > created.index;
  for (let windows = 0; ;) {
    const updates = [];
    if (windowEnd < head) {
      if (++windows > RAN_OUT_WINDOWS) return null;
      const to = windowEnd + RANGE_BLOCKS < head ? windowEnd + RANGE_BLOCKS : head;
      updates.push(...(await eventsBetween(client, [PRICE_UPDATE_TOPIC], windowEnd + 1n, to)).filter(after));
      windowEnd = to;
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


// ---------- Dollars

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


// ---------- The document

// `id`: 64 lower case hex characters, no 0x. `rpcs`: Gnosis JSON-RPC urls, tried in order until one gives the whole
// document, starting from the one that answered last, so a node that is down costs one wait, not one per read.
// `withUsd`: true adds dollars from CoinGecko, for a document served to others. The page leaves it off.
export async function readStamp(id, { rpcs, withUsd = false }) {
  const ordered = rpcs.includes(lastAnswered) ? [lastAnswered, ...rpcs.filter(rpc => rpc !== lastAnswered)] : rpcs;
  let failure = new Error('No RPC to read from');
  for (const rpc of ordered) {
    try {
      const doc = await readFrom(rpc, id, withUsd);
      lastAnswered = rpc;
      return doc;
    } catch (e) {
      failure = e;
      console.warn('Stamptime: could not read the stamp through ' + rpc + '.', e);
    }
  }
  throw failure;
}

async function readFrom(rpc, id, withUsd) {
  const client = clientFor(rpc);
  const dollars = withUsd ? usdSeries() : Promise.resolve(null);   // alongside the chain reads, never in their way

  // Every live value is read at this one block, and its time is the page's "now".
  const block = await getBlock(client);
  const head = block.number;
  const now = Number(block.timestamp);
  const [events, totalOut, price, recent] = await Promise.all([
    batchEvents(client, id, head),
    view(client, 'currentTotalOutPayment', head),
    view(client, 'lastPrice', head),
    pricesOfRange(client, head)
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

  const series = await dollars;
  const contributions = await mapLimit(payments, CONCURRENCY, async ({ event, kind, amount, depth: depthThen }) => {
    const [address, priceThen, time] = await Promise.all([senderOf(client, event.tx), priceAt(client, event, recent), timeOf(client, event)]);
    const perChunk = amount / (1n << BigInt(depthThen));
    const bzz = Number(amount) / PLUR_PER_BZZ;
    const rate = rateAt(series, time * 1000);
    return {
      kind, address, time: iso(time), block: Number(event.block), tx: event.tx,
      days: Number(perChunk) / Number(priceThen) * BLOCK_SECONDS / 86400,
      usd: rate == null ? null : bzz * rate,
      bzz
    };
  });

  const remaining = balance - totalOut;   // per chunk
  const active = remaining > 0n;
  let expiry;
  if (active) {
    const end = p => iso(now + Number(remaining / p) * BLOCK_SECONDS);
    const prices = recent.map(p => p.args.price);
    expiry = { time: end(price), earliest: end(maxOf(prices, price)), latest: end(minOf(prices, price)), lastBlock: null };
  } else {
    if (!ranOut.has(id)) {
      const createdPrice = await priceAt(client, created, recent);
      const lastEvent = events[events.length - 1].block;
      const lifeBlocks = BigInt(Math.round(contributions.reduce((sum, c) => sum + c.days, 0) * BLOCKS_PER_DAY));
      ranOut.set(id, await ranOutBlock(client, { created, createdPrice, balance, totalOut, head, recent, lastEvent, lifeBlocks }));
    }
    const block = ranOut.get(id);
    expiry = { time: block == null ? null : iso(await timeOfBlock(client, block)), earliest: null, latest: null,
      lastBlock: block == null ? null : Number(block) };
  }

  const bzzPerDay = active ? Number(price) * 2 ** depth * BLOCKS_PER_DAY / PLUR_PER_BZZ : null;
  const rate = rateNow(series);
  return {
    batchId: id,
    status: active ? 'active' : 'expired',
    chain: { id: CHAIN_ID, contract: CONTRACT, rpc: new URL(rpc).host, block: Number(head), blockTime: iso(now) },
    owner: getAddress(created.args.owner),
    depth,
    immutable: created.args.immutableFlag,
    capacity: capacityOf(depth),
    created: { time: iso(await timeOf(client, created)), block: Number(created.block), tx: created.tx },
    expiry,
    pricing: { bzzPerDay, usdPerDay: bzzPerDay == null || rate == null ? null : bzzPerDay * rate },
    contributions
  };
}
