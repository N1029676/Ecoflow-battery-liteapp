// Usage: node tests/e2e/run-e2e.mjs   (needs playwright + esbuild; index.html must be built)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const out = await build({ entryPoints: ['tests/e2e/fake-bluetooth.js'], bundle: true, write: false, format: 'iife' });
const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.addInitScript(out.outputFiles[0].text);
await p.goto(pathToFileURL(resolve('index.html')).href);
await p.fill('#userId', '1234');
await p.click('#connect');
await p.waitForFunction(() => document.getElementById('status').textContent === 'authenticated', null, { timeout: 15000 });
await p.waitForTimeout(6000); // let the poll loop cycle through all five requests
const t = (id) => p.textContent('#' + id);
const r = { soc: await t('d-soc'), in: await t('d-in'), out: await t('d-out'), ac: await t('d-ac'), time: await t('d-time'),
  batt: await p.$$eval('#d-batts .tile', (e) => e.map((x) => x.textContent)), log: await t('log'),
  overlaps: await p.evaluate(() => window.__fake.overlaps), writes: await p.evaluate(() => window.__fake.writes) };
console.log(JSON.stringify({ ...r, log: undefined }, null, 1));
const ok = r.soc === '94.1%' && r.in === '899 W' && r.out === '784 W' && r.ac.startsWith('117.5 V') && r.batt.length === 1 && r.overlaps === 0 && !/poll error/.test(r.log) && errs.length === 0;
console.log(ok ? 'E2E PASS' : `E2E FAIL errs=${JSON.stringify(errs)}`);
await b.close();
process.exit(ok ? 0 : 1);
