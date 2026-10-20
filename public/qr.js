/*
  Stamptime: a QR code for a short text, here the batch id, so a phone or a wallet app can read it off the screen.
  No dependencies. It follows ISO/IEC 18004 the way Project Nayuki's QR Code generator (MIT) lays it out, cut down to
  what the page needs: byte mode, error correction level M (about 15% of the code can be lost), versions 1 to 10,
  which is up to 213 bytes. A 64 character batch id needs version 5, 37 modules a side.

  qrSvg(text) returns the code as SVG markup made of numbers only, with the quiet zone of four modules around it.
*/

// Level M, versions 1 to 10: error correction codewords per block, and how many blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0;   // level M in the format bits
const MAX_VERSION = 10;

export function qrSvg(text, { dark = '#020817', light = '#FFFFFF', quiet = 4 } = {}) {
  const { size, modules } = qrModules(text);
  const side = size + quiet * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) path += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + side + ' ' + side + '" shape-rendering="crispEdges">' +
    '<rect width="' + side + '" height="' + side + '" fill="' + light + '"/><path fill="' + dark + '" d="' + path + '"/></svg>';
}

// The modules, dark as true, row by row.
export function qrModules(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const version = smallestVersion(bytes.length);
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };

  drawFunctionPatterns(version, size, set);
  drawCodewords(withErrorCorrection(dataCodewords(bytes, version), version), size, modules, reserved);

  // Every mask decodes; the one that leaves the fewest patterns a reader could stumble on is kept.
  let best = 0, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask, size, modules, reserved);
    drawFormatBits(mask, size, set);
    const penalty = penaltyScore(size, modules);
    if (penalty < bestPenalty) { best = mask; bestPenalty = penalty; }
    applyMask(mask, size, modules, reserved);   // a mask is its own undo
  }
  applyMask(best, size, modules, reserved);
  drawFormatBits(best, size, set);
  return { size, modules };
}


// ---------- the data

const rawDataModules = version => {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
};
const dataCapacity = version => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
const countBits = version => version < 10 ? 8 : 16;

function smallestVersion(length) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (4 + countBits(version) + length * 8 <= dataCapacity(version) * 8) return version;
  }
  throw new RangeError('Too long for a QR code here: ' + length + ' bytes');
}

// Byte mode: the mode, the length, the bytes, a terminator, then padding to fill the version.
function dataCodewords(bytes, version) {
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  const capacity = dataCapacity(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((byte, bit) => byte << 1 | bit, 0));
  return words;
}

// Split into blocks, add Reed-Solomon codewords to each, and interleave them.
function withErrorCorrection(data, version) {
  const blocks = BLOCKS[version], eccLength = ECC_PER_BLOCK[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - raw % blocks, shortLength = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLength);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);   // a placeholder, so every block lines up; skipped below
    all.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]); });
  }
  return result;
}

// Multiplication in GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = Array(degree - 1).fill(0).concat(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
  }
  return result;
}


// ---------- the matrix

function drawFunctionPatterns(version, size, set) {
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(version, size), last = align.length - 1;
  align.forEach((ay, i) => align.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;   // the finder corners
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormatBits(0, size, set);   // reserves their place; the real bits come with the mask
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormatBits(mask, size, set) {
  const data = FORMAT_M << 3 | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (data << 10 | rem) ^ 0x5412;
  const bit = i => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);   // the dark module
}

// Two columns at a time from the right, zigzagging up and down, skipping the vertical timing line.
function drawCodewords(codewords, size, modules, reserved) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
];

function applyMask(mask, size, modules, reserved) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  }
}

// The standard's penalty: long runs, 2x2 blocks, finder look-alikes and an uneven share of dark modules.
function penaltyScore(size, modules) {
  let result = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i]);
    lines.push(modules.map(row => row[i]));
  }
  for (const line of lines) {
    let color = false, run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (const module of line) {
      if (module === color) {
        run++;
        if (run === 5) result += 3;
        else if (run > 5) result++;
      } else {
        addHistory(run, history, size);
        if (!color) result += finderLike(history) * 40;
        color = module;
        run = 1;
      }
    }
    if (color) { addHistory(run, history, size); run = 0; }
    addHistory(run + size, history, size);
    result += finderLike(history) * 40;
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0), total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

function addHistory(run, history, size) {
  if (history[0] === 0) run += size;   // the light border before the first run
  history.pop();
  history.unshift(run);
}

function finderLike(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}
