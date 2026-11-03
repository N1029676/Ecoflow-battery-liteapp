// Usage: node tests/e2e/pwa.mjs   (needs playwright; index.html must be built)
// Serves the repo over HTTP and checks installability pieces + offline loading via the service worker.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const PORT = 8139;
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const base = `http://127.0.0.1:${PORT}/`;
let b;
try {
  b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(base + 'index.html');

  const mf = await p.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]').href;
    const m = await (await fetch(href)).json();
    const icons = await Promise.all(m.icons.map(async (i) => { const r = await fetch(new URL(i.src, href)); return [i.src, r.status, r.headers.get('content-type')]; }));
    return { m, icons };
  });
  check('manifest has name, standalone display, start_url', mf.m.name === 'EcoFlow Monitor' && mf.m.display === 'standalone' && mf.m.start_url === './', JSON.stringify(mf.m));
  check('manifest icons all load', mf.icons.every(([, s]) => s === 200), JSON.stringify(mf.icons));
  check('has 192 and 512 png icons incl. maskable', ['192x192', '512x512'].every((s) => mf.m.icons.some((i) => i.sizes === s && i.type === 'image/png')) && mf.m.icons.some((i) => i.purpose === 'maskable'));
  check('theme-color + apple-touch-icon present', await p.evaluate(() => !!document.querySelector('meta[name=theme-color]') && !!document.querySelector('link[rel=apple-touch-icon]')));

  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); // now controlled by the SW
  check('service worker active and controlling', await p.evaluate(() => !!navigator.serviceWorker.controller));
  const cached = await p.evaluate(async () => (await (await caches.open('ecoflow-monitor-v1')).keys()).map((r) => new URL(r.url).pathname));
  check('app shell precached', ['/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'].every((x) => cached.includes(x)), JSON.stringify(cached));

  await ctx.setOffline(true);
  await p.reload();
  check('opens offline from cache', (await p.title()) === 'EcoFlow Monitor' && (await p.isVisible('#connect')));
  await p.goto(base + 'index.html?fine=1000');
  check('offline load with query string works', (await p.title()) === 'EcoFlow Monitor');
  await ctx.setOffline(false);

  // The SW must never intercept cross-origin requests (e.g. the EcoFlow login).
  const sw = await (await fetch(base + 'sw.js')).text();
  check('service worker ignores cross-origin requests', /origin !== self\.location\.origin\) return/.test(sw));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
} finally {
  await b?.close();
  srv.kill();
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `PWA FAIL (${failed} failed)` : 'PWA PASS');
process.exit(failed ? 1 : 0);
