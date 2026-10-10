// Rauchtest: alle Node-Tests ausführen und alle Dev-Szenen headless laden (Screenshots + Fehler).
//   node tools/smoke.mjs [--scenes a,b] [--notests] [--noscenes] [--out /tmp/tg-smoke]
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const outDir = opt('out', '/tmp/tg-smoke');
mkdirSync(outDir, { recursive: true });
const results = [];

if (!opt('notests', false)) {
  for (const f of readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).sort()) {
    const t0 = Date.now();
    const r = spawnSync('node', [join('test', f)], { cwd: root, encoding: 'utf8', timeout: 180000 });
    const tail = (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ');
    results.push({ kind: 'test', name: f, ok: r.status === 0, ms: Date.now() - t0, info: tail.slice(0, 300) });
  }
}
if (!opt('noscenes', false)) {
  const only = opt('scenes', null);
  const scenes = only ? String(only).split(',') : readdirSync(join(root, 'test', 'scenes')).filter((f) => f.endsWith('.js') && f !== 'devkit.js').map((f) => f.replace(/\.js$/, '')).sort();
  for (const s of scenes) {
    const t0 = Date.now();
    const out = join(outDir, `${s}.png`);
    const r = spawnSync('node', ['tools/shot.mjs', `/dev.html?scene=${s}`, '--out', out, '--wait', '3500', '--timeout', '90000'], { cwd: root, encoding: 'utf8', timeout: 120000 });
    const errs = (r.stdout || '').split('\n').filter((l) => /EXCEPTION|console\.error|log\.error|TIMEOUT/.test(l));
    results.push({ kind: 'scene', name: s, ok: r.status === 0, ms: Date.now() - t0, info: errs.slice(0, 3).join(' | ').slice(0, 400) || out });
  }
}
let fails = 0;
for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.kind.padEnd(5)} ${r.name.padEnd(28)} ${String(r.ms).padStart(6)} ms  ${r.info}`); }
console.log(fails ? `\n${fails} Fehler` : '\nalles grün');
process.exit(fails ? 1 : 0);
