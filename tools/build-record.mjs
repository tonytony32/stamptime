#!/usr/bin/env node
/*
  The record build: the page as a public record, for places where only the record should be reachable.

    node tools/build-record.mjs            writes dist/record/
    node tools/build-record.mjs out/dir    writes somewhere else

  public/ carries both builds. The full page's own markup sits between <!-- full-only --> and <!-- /full-only -->
  markers in index.html; the record build is the page without those blocks, fixed in record mode on <html> so it
  does not depend on the visitor's clock. The script is the same file, with no destination to hand off to, and the
  demo documents are the record as the page reads it. The build checks its output before it finishes.

  Node only, no dependencies. The build refuses to run if a marker is unbalanced.
*/
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'public');
const out = resolve(process.argv[2] || join(root, 'dist', 'record'));

const OPEN = '<!-- full-only -->';
const CLOSE = '<!-- /full-only -->';

// index.html without the full page's blocks, in record mode.
function recordPage(html) {
  const opens = html.split(OPEN).length - 1;
  const closes = html.split(CLOSE).length - 1;
  if (opens !== closes) throw new Error('index.html: ' + opens + ' opening and ' + closes + ' closing full-only markers');
  let page = '';
  let rest = html;
  let blocks = 0;
  for (;;) {
    const a = rest.indexOf(OPEN);
    if (a < 0) { page += rest; break; }
    const b = rest.indexOf(CLOSE, a);
    if (b < 0) throw new Error('index.html: a full-only block is never closed');
    page += rest.slice(0, a).replace(/[ \t]+$/, '');
    rest = rest.slice(b + CLOSE.length).replace(/^[ \t]*\r?\n/, '');
    blocks++;
  }
  if (!/<html\b[^>]*>/.test(page)) throw new Error('index.html: no <html> tag');
  page = page.replace(/<html\b([^>]*)>/, (tag, attrs) =>
    /\bclass=/.test(attrs) ? tag.replace(/class="([^"]*)"/, 'class="$1 mode-record"') : '<html' + attrs + ' class="mode-record">');
  return { page, blocks };
}

// stamp.js with no destination to hand off to: the record has nowhere to send anyone.
function recordScript(js) {
  const script = js.replace(/'https:\/\/beeport\.eth\.limo\/\?topup=\{id\}'/g, "''");
  if (script === js) throw new Error('stamp.js: the hand off address was not where the build expects it');
  return script;
}

// A demo document as the record reads it: days, BZZ and the chain, nothing the record does not show.
function recordExample(json) {
  const doc = JSON.parse(json);
  if (doc.pricing && 'usdPerDay' in doc.pricing) doc.pricing.usdPerDay = null;
  for (const c of doc.contributions || []) if ('usd' in c) c.usd = null;
  return JSON.stringify(doc, null, 2) + '\n';
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });

const { page, blocks } = recordPage(readFileSync(join(src, 'index.html'), 'utf8'));
writeFileSync(join(out, 'index.html'), page);
writeFileSync(join(out, 'stamp.js'), recordScript(readFileSync(join(src, 'stamp.js'), 'utf8')));
const examples = readdirSync(join(src, 'examples')).filter(name => name.endsWith('.json'));
for (const name of examples) {
  writeFileSync(join(out, 'examples', name), recordExample(readFileSync(join(src, 'examples', name), 'utf8')));
}

// The output, checked as served: the record and nothing of the full page.
const servedPage = readFileSync(join(out, 'index.html'), 'utf8');
for (const word of [OPEN, CLOSE, 'stamptime-topups-from', 'id="sheet"', 'id="addBtn"', 'id="donateCode"', '$']) {
  if (servedPage.includes(word)) throw new Error('record build: index.html still contains ' + word);
}
if (readFileSync(join(out, 'stamp.js'), 'utf8').includes('beeport.eth.limo')) throw new Error('record build: stamp.js still carries a hand off address');

console.log('record build: ' + out);
console.log('  index.html: the record, ' + blocks + ' full-only blocks aside, <html class="mode-record">');
console.log('  stamp.js: no hand off destination');
console.log('  examples: ' + examples.length + ' documents as the record reads them');
