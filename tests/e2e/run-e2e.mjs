// Usage: node tests/e2e/run-e2e.mjs   (needs playwright + esbuild; index.html must be built)
// Drives the real bundled page against a fake Bluetooth device: connect, dashboard, history, debug toggle,
// auto-reconnect after a dropped link, stall watchdog, wake lock, persistence.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const out = await build({ entryPoints: ['tests/e2e/fake-bluetooth.js'], bundle: true, write: false, format: 'iife' });
const WAKELOCK_STUB = `(() => {
  const w = { requests: 0, releases: 0, listeners: [] };
  window.__wl = w;
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { w.requests++;
    const l = { addEventListener: (t, fn) => w.listeners.push(fn), release: async () => { w.releases++; } }; return l; } } });
  w.forceRelease = () => { w.listeners.splice(0).forEach((fn) => fn()); };
})();`;

const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('dialog', (d) => d.accept());
await p.addInitScript(WAKELOCK_STUB);
await p.addInitScript(out.outputFiles[0].text);
const url = pathToFileURL(resolve('index.html')).href + '?fine=1000&stall=3000&retry=300&save=500';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const text = (id) => p.textContent('#' + id);
const waitStatus = (s, timeout = 15000) => p.waitForFunction((x) => document.getElementById('status').textContent === x, s, { timeout });
const fake = (expr) => p.evaluate(`window.__fake.${expr}`);

await p.goto(url);
check('debug panel hidden by default', await p.isHidden('#debugPanel'));
await p.fill('#userId', '1234');
await p.click('#connect');
await waitStatus('authenticated');

// --- dashboard ---
await p.waitForTimeout(5000);
const dash = { soc: await text('d-soc'), inn: await text('d-in'), out: await text('d-out'), ac: await text('d-ac') };
check('dashboard decoded', dash.soc === '94.1%' && dash.inn === '899 W' && dash.out === '784 W' && dash.ac.startsWith('117.5 V'), JSON.stringify(dash));
check('no overlapping writes', (await fake('overlaps')) === 0);

// --- debug off: quiet log ---
const quiet = await text('log');
check('verbose logging suppressed when debug is off', !/rx src|state:|connecting GATT|tx raw/.test(quiet), quiet.slice(0, 200));
check('essential message still shown', (await text('msg')) === 'Connected');
await p.check('#debug');
check('debug panel visible after toggle', await p.isVisible('#debugPanel'));
await p.waitForTimeout(2500);
check('verbose logging appears when debug is on', /rx src/.test(await text('log')));
check('debug setting persisted', await p.evaluate(() => localStorage.getItem('ef.debug')) === '1');
await p.uncheck('#debug');

// --- wake lock ---
check('wake lock requested on connect', (await p.evaluate('window.__wl.requests')) >= 1);

// --- history ---
await p.waitForFunction(() => /^([4-9]|\d\d+) readings/.test(document.getElementById('h-count').textContent), null, { timeout: 15000 });
await p.waitForTimeout(500); // chart redraw is throttled
await p.click('#tableView summary');
await p.waitForSelector('#histTable tbody tr');
const rows = await p.$$eval('#histTable tbody tr', (r) => r.map((x) => x.textContent));
check('history recorded and shown in table view', rows.length >= 2 && /94\.1/.test(rows[0]) && /899/.test(rows[0]), JSON.stringify(rows.slice(0, 2)));
await p.hover('#c-soc canvas', { position: { x: 200, y: 80 } }); // crosshair marker is drawn at the nearest reading
await p.waitForTimeout(100);
const painted = await p.$eval('#c-soc canvas', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i + 2] > d[i] + 80) n++; return n; });
check('chart draws series-colored marks', painted > 20, String(painted));
await p.hover('#c-power canvas', { position: { x: 200, y: 80 } });
check('tooltip shows on hover', await p.isVisible('#c-power .tip') && /W/.test(await text('c-power')), '');
await p.click('#ranges button[data-range="7d"]');
check('range selection persisted', (await p.evaluate(() => localStorage.getItem('ef.range'))) === '7d');
await p.click('#ranges button[data-range="1h"]');

// --- auto-reconnect after link drop ---
await fake('drop()');
await p.waitForFunction(() => /^reconnecting/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
await waitStatus('authenticated');
check('auto-reconnects after the link drops', (await fake('connects')) === 2 && (await text('msg')) === 'Reconnected', `connects=${await fake('connects')} msg=${await text('msg')}`);
await p.waitForTimeout(2500);
check('telemetry resumes after reconnect', (await text('d-soc')) === '94.1%');

// --- stall watchdog ---
await p.evaluate('window.__fake.mute = true');
await p.waitForFunction(() => /^No data for/.test(document.getElementById('msg').textContent) || /reconnecting/.test(document.getElementById('status').textContent), null, { timeout: 12000 });
await p.evaluate('window.__fake.mute = false');
await waitStatus('authenticated');
check('stall watchdog forces a reconnect', (await fake('connects')) === 3, `connects=${await fake('connects')}`);

// --- wake lock re-acquired when the page becomes visible again ---
const before = await p.evaluate('window.__wl.requests');
await p.evaluate(() => { window.__wl.forceRelease(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
await p.waitForTimeout(300);
check('wake lock re-acquired after release', (await p.evaluate('window.__wl.requests')) === before + 1);

// --- history persisted ---
await p.waitForTimeout(1200);
const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('ef.history') ?? 'null'));
check('history saved to localStorage', saved?.v === 1 && saved.fine.length >= 3, JSON.stringify(saved)?.slice(0, 100));

// --- user disconnect stops everything ---
await p.click('#disconnect');
const connectsAtStop = await fake('connects');
await p.waitForTimeout(1500);
check('disconnect does not auto-reconnect', (await fake('connects')) === connectsAtStop && (await text('status')) === 'disconnected');
check('wake lock released on disconnect', (await p.evaluate('window.__wl.releases')) >= 1);

// --- history survives a reload ---
await p.reload();
await p.waitForFunction(() => /\d+ readings/.test(document.getElementById('h-count').textContent), null, { timeout: 5000 });
check('history survives reload', true);
await p.click('#clearHist');
check('clear history', /no readings/.test(await text('h-count')));

check('no page errors', errs.length === 0, JSON.stringify(errs));
await b.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? `E2E FAIL (${failed} failed)` : 'E2E PASS');
process.exit(failed ? 1 : 0);
