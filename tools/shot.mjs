// Headless-Chrome-Testwerkzeug (ohne Abhängigkeiten, nutzt das Chrome DevTools Protocol).
//
//   node tools/shot.mjs <url-or-path> [options]
//
//   <url-or-path>     z.B. "/?scene=viewer&model=tom" (relativ zu http://127.0.0.1:8123) oder volle URL
//   --out <file.png>  Screenshot-Datei (Standard: /tmp/tg-shot.png). Bei --shots N: file-0.png, file-1.png …
//   --size 1280x720   Viewport (CSS-Pixel), --dpr 1
//   --wait <ms>       Wartezeit nach dem Laden vor dem ersten Screenshot (Standard 2500)
//   --until <js>      JS-Ausdruck; wartet (max. --timeout ms), bis er truthy ist, bevor --wait beginnt
//   --eval <js>       JS-Ausdruck (darf Promise sein), wird nach dem Warten ausgeführt; Ergebnis wird ausgegeben.
//                     Mehrfach angebbar; wird in Reihenfolge ausgeführt.
//   --shots <n>       Anzahl Screenshots, --interval <ms> Abstand (Standard 1000)
//   --keys <seq>      Tastensequenz nach dem Warten, z.B. "KeyJ:down,wait:300,KeyJ:up,ArrowLeft:tap"
//   --timeout <ms>    Gesamt-Timeout (Standard 60000)
//   --nogpu           SwiftShader statt GPU erzwingen
//
// Gibt Konsolenmeldungen und Fehler aus. Exit-Code 2, wenn unbehandelte Fehler auftraten.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = { out: '/tmp/tg-shot.png', size: '1280x720', dpr: 1, wait: 2500, shots: 1, interval: 1000, timeout: 60000, evals: [] };
let target = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--eval') opt.evals.push(argv[++i]);
  else if (a === '--nogpu') opt.nogpu = true;
  else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
  else target = a;
}
if (!target) { console.error('usage: node tools/shot.mjs <url> [--out f.png] [--wait ms] [--eval js] ...'); process.exit(1); }
const url = /^https?:|^file:/.test(target) ? target : 'http://127.0.0.1:8123' + (target.startsWith('/') ? '' : '/') + target;
const [W, H] = String(opt.size).split('x').map(Number);

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'tg-chrome-'));
const flags = [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ...(opt.nogpu ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu']),
  'about:blank',
];
const proc = spawn(CHROME, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
let errors = 0;
const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
const hardTimer = setTimeout(() => { console.error('[shot] TIMEOUT'); cleanup(); process.exit(3); }, Number(opt.timeout));

const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  proc.on('exit', c => rej(new Error('chrome exited ' + c)));
});
const port = new URL(wsUrl).port;
let pageWs;
for (let i = 0; i < 50 && !pageWs; i++) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const p = list.find(t => t.type === 'page');
  if (p) pageWs = p.webSocketDebuggerUrl; else await new Promise(r => setTimeout(r, 100));
}
const ws = new WebSocket(pageWs);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let nextId = 1; const pending = new Map(); const listeners = [];
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method) listeners.forEach(l => l(msg));
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const fmt = (args) => args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : a.value) : (a.description || a.type)).join(' ');
listeners.push(msg => {
  if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params.type; if (t === 'error') errors++;
    console.log(`[console.${t}] ${fmt(msg.params.args)}`.slice(0, 2000));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors++;
    const d = msg.params.exceptionDetails;
    console.log(`[EXCEPTION] ${d.exception?.description || d.text} @ ${d.url || ''}:${d.lineNumber}:${d.columnNumber}`.slice(0, 3000));
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry; if (e.level === 'error' && !/favicon/.test(e.url || '')) { errors++; console.log(`[log.error] ${e.text} ${e.url || ''}`); }
  }
});
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: Number(opt.dpr), mobile: false });
const loaded = new Promise(r => listeners.push(m => { if (m.method === 'Page.loadEventFired') r(); }));
await send('Page.navigate', { url });
await loaded;
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { errors++; return 'EVAL-ERROR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text); }
  return r.result.value;
};
if (opt.until) {
  const t0 = Date.now();
  while (!(await evaluate(`!!(${opt.until})`))) { if (Date.now() - t0 > Number(opt.timeout) - 5000) { console.log('[shot] --until not reached'); break; } await new Promise(r => setTimeout(r, 200)); }
}
await new Promise(r => setTimeout(r, Number(opt.wait)));
if (opt.keys) {
  for (const step of String(opt.keys).split(',')) {
    const [k, mode = 'tap'] = step.split(':');
    if (k === 'wait') { await new Promise(r => setTimeout(r, Number(mode))); continue; }
    const key = k.startsWith('Key') ? k.slice(3).toLowerCase() : k === 'Space' ? ' ' : k;
    const base = { code: k, key, windowsVirtualKeyCode: k.startsWith('Key') ? k.charCodeAt(3) : ({ Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27 }[k] || 0) };
    if (mode === 'down' || mode === 'tap') await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    if (mode === 'tap') await new Promise(r => setTimeout(r, 60));
    if (mode === 'up' || mode === 'tap') await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
}
for (const e of opt.evals) { const v = await evaluate(e); console.log('[eval] ' + (typeof v === 'object' ? JSON.stringify(v) : v)); }
const n = Number(opt.shots);
for (let i = 0; i < n; i++) {
  if (i > 0) await new Promise(r => setTimeout(r, Number(opt.interval)));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = n > 1 ? opt.out.replace(/\.png$/, `-${i}.png`) : opt.out;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('[shot] ' + file);
}
clearTimeout(hardTimer);
ws.close(); cleanup();
console.log(errors ? `[shot] ${errors} error(s)` : '[shot] ok, no errors');
process.exit(errors ? 2 : 0);
