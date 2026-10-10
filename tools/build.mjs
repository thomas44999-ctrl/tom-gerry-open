// Packt das Spiel in EINE eigenständige HTML-Datei (Doppelklick genügt, kein Server nötig).
//   node tools/build.mjs [out.html]      (Standard: dist/tom-gerry-open.html)
// Prinzip: Alle ES-Module ab src/main.js einsammeln, relative Importe auf feste Namen
// ("tg/src/…") umschreiben und per Import-Map auf data:-URLs abbilden. Kein Code wird
// umgebaut, die Modul-Semantik bleibt exakt erhalten (auch zirkuläre Importe).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'dist', 'tom-gerry-open.html'));
let html = readFileSync(join(root, 'index.html'), 'utf8');
const tag = html.match(/<script\s+type="module"\s+src="\.?\/?([^"]+)"\s*><\/script>/);
if (!tag) throw new Error('index.html: <script type="module" src="…"> nicht gefunden');

const mods = new Map();
const spec = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
function visit(rel) {
  if (mods.has(rel)) return;
  mods.set(rel, '');
  const src = readFileSync(join(root, rel), 'utf8');
  const code = src.replace(spec, (all, pre, q, s) => {
    const dep = posix.normalize(posix.join(posix.dirname(rel), s));
    visit(dep);
    return `${pre}${q}tg/${dep}${q}`;
  });
  mods.set(rel, code);
}
visit(tag[1]);

const imports = {};
let bytes = 0;
for (const [rel, code] of mods) {
  bytes += code.length;
  imports[`tg/${rel}`] = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
}
const importMap = JSON.stringify({ imports }).replace(/</g, '\\u003c');
html = html.replace(tag[0], () =>
  `<script type="importmap">${importMap}</script>\n<script type="module">import 'tg/${tag[1]}';</script>`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`[build] ${mods.size} Module, ${(bytes / 1024).toFixed(0)} KB Quelltext -> ${out} (${(html.length / 1024).toFixed(0)} KB)`);
