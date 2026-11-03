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
const url = pathToFileURL(resolve('index.html')).href + '?fine=1000&stall=3000&retry=300&save=500&stale=1000&sigshow=3000&ctl=1800';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const text = (id) => p.textContent('#' + id);
const CONNECTED = 'Connected';
const waitStatus = (s, timeout = 15000) => p.waitForFunction((x) => document.getElementById('status').textContent === x, s, { timeout });
const fake = (expr) => p.evaluate(`window.__fake.${expr}`);

await p.goto(url);
check('debug panel hidden by default', await p.isHidden('#debugPanel'));
check('help hidden by default, opens with the ? button', await p.isHidden('#help') && (await p.click('#helpBtn'), await p.isVisible('#help')) && /Close the EcoFlow phone app/.test(await text('help')));
await p.click('#helpBtn');
check('help closes again', await p.isHidden('#help'));
check('Advanced opens automatically on first run (no user ID yet)', !(await p.$eval('#advanced', (d) => d.hidden)) && (await p.getAttribute('#advBtn', 'aria-expanded')) === 'true');
check('idle: a single primary "Add battery" button (no Connect button), status Not connected', (await text('addBtn')) === 'Add battery' && /primary/.test(await p.getAttribute('#addBtn', 'class')) && !(await p.$('#connect')) && !(await p.isVisible('#stop')) && (await text('status')) === 'Not connected');
check('instructions paragraph no longer on the page body', !(await p.$('p.sub')));
await p.click('#ctlBtn');
check('controls are disabled until a battery is connected', (await p.isDisabled('#acBtn')) && (await p.isDisabled('#chgIn')) && (await p.isDisabled('#dsgApply')));
await p.click('#ctlBtn');
await p.fill('#userId', '1234');
await p.click('#addBtn');
await p.waitForFunction(() => document.getElementById('stop').textContent === 'Cancel', null, { timeout: 5000 }).catch(() => {});
await waitStatus(CONNECTED);
check('status reads Connected (not "authenticated") and the stop button reads Disconnect', (await text('status')) === 'Connected' && (await text('stop')) === 'Disconnect', `${await text('status')} / ${await text('stop')}`);
await p.waitForFunction(() => /dBm/.test(document.getElementById('sig').textContent), null, { timeout: 2000 }).catch(() => {});
check('signal strength is shown when connecting', /^-\d+ dBm/.test(await text('sig')) && !(await p.$eval('#sig', (e) => e.classList.contains('fade'))), await text('sig'));
await p.waitForSelector('#sig.fade', { timeout: 6000 });
check('then it fades out (CSS fade after the show period)', (await p.$eval('#sig', (e) => getComputedStyle(e).transitionProperty)).includes('opacity'));
await p.waitForFunction(() => document.getElementById('sig').textContent === '', null, { timeout: 5000 });
check('and is gone afterwards, while the message age stays', (await text('sig')) === '' && /^Updated /.test(await text('age')) && (await p.isVisible('#live')));
check('the new battery now shows as a named button, highlighted as connected', (await text('batts')) === 'Battery 0001' && /\bon\b/.test(await p.getAttribute('.batt', 'class')));
check('the serial override field is never filled in automatically', (await p.inputValue('#serial')) === '');
check('Advanced folds away again after the first successful connection', (await p.$eval('#advanced', (d) => d.hidden)) && !(await p.isVisible('#userId')));

// --- dashboard ---
await p.waitForTimeout(5000);
const dash = { soc: await p.textContent('#d-batts .tile:nth-child(1) .soc-pct'), inn: await text('d-in'), out: await text('d-out'), ac: await text('d-ac') };
check('dashboard decoded', dash.soc === '94.1%' && dash.inn === '899 W' && dash.out === '784 W' && dash.ac.startsWith('117.5 V'), JSON.stringify(dash));
check('no overlapping writes', (await fake('overlaps')) === 0);

// --- tiles: two columns, details in a popover ---
const boxes = await p.$$eval('.tiles .tile', (e) => e.map((t) => { const r = t.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), label: t.dataset.label }; }));
check('four tiles in two columns', boxes.length === 4 && boxes[0].y === boxes[1].y && boxes[2].y === boxes[3].y && boxes[2].y > boxes[0].y && boxes[1].x > boxes[0].x && boxes[0].x === boxes[2].x, JSON.stringify(boxes));
check('tile details hidden until clicked', await p.$$eval('.tiles .pop', (e) => e.every((x) => x.hidden)));
check('tile shows no sub-text line', (await p.$$eval('.tiles .tile small', (e) => e.length)) === 0);
await p.click('.tiles .tile:nth-child(1) .lab');
check('clicking a tile opens its details popover', await p.isVisible('.tiles .tile:nth-child(1) .pop') && /AC\s+899 W/.test(await p.textContent('.tiles .tile:nth-child(1) .pop')) && /Solar/.test(await p.textContent('.tiles .tile:nth-child(1) .pop')), await p.textContent('.tiles .tile:nth-child(1) .pop'));
await p.click('.tiles .tile:nth-child(2) .ib');
check('only one popover open at a time', (await p.$$eval('.tiles .pop:not([hidden])', (e) => e.length)) === 1 && await p.isVisible('.tiles .tile:nth-child(2) .pop'));
check('button reports expanded state', (await p.getAttribute('.tiles .tile:nth-child(2) .ib', 'aria-expanded')) === 'true' && (await p.getAttribute('.tiles .tile:nth-child(1) .ib', 'aria-expanded')) === 'false');
const popBox = await p.$eval('.tiles .tile:nth-child(2) .pop', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
check('popover stays inside the viewport', popBox.l >= 0 && popBox.r <= popBox.w, JSON.stringify(popBox));
await p.keyboard.press('Escape');
check('Escape closes the popover', (await p.$$eval('.tiles .pop:not([hidden])', (e) => e.length)) === 0);
await p.click('.tiles .tile:nth-child(3)');
await p.click('h1');
check('clicking elsewhere closes the popover', (await p.$$eval('.tiles .pop:not([hidden])', (e) => e.length)) === 0);
await p.click('.tiles .tile:nth-child(4) .big');
check('AC output tile', /Off|On/.test(await text('d-acout')) && /Set to\s+120 V/.test(await p.textContent('.tiles .tile:nth-child(4) .pop')));
await p.keyboard.press('Escape');

// --- state-of-charge bars ---
const GREEN = 'rgb(12, 163, 12)', YELLOW = 'rgb(250, 178, 25)', RED = 'rgb(208, 59, 59)';
const segs = (sel) => p.$$eval(`${sel} .seg`, (e) => e.map((s) => ({ w: s.firstChild.style.width, pulse: s.classList.contains('pulse') })));
const fillColor = (sel) => p.$eval(`${sel} .seg i`, (i) => getComputedStyle(i).backgroundColor);
const patch = (...a) => p.evaluate(`window.__fake.patch(...${JSON.stringify(a)})`);
const main = await segs('#d-batts .tile:nth-child(1)');
check('main battery bar: 20 whole segments, 19 lit at 94.1% (5% steps, no partials)', main.length === 20 && main.slice(0, 19).every((x) => x.w === '100%') && main[19].w === '0%', JSON.stringify(main.map((x) => x.w)));
check('bar is green above 25%', (await fillColor('#d-batts .tile:nth-child(1)')) === GREEN);
check('no pulse while idle', main.every((x) => !x.pulse));
const packBars = await p.$$eval('#d-batts .soc', (e) => e.map((x) => ({ n: x.querySelectorAll('.seg').length, t: x.previousSibling?.textContent })));
check('no average battery bar; one bar per pack (main + extra)', !(await p.$('#b-main')) && packBars.length === 2 && packBars.every((x) => x.n === 20), JSON.stringify(packBars));
const order = await p.evaluate(() => { const y = (q) => document.querySelector(q).getBoundingClientRect().top; return y('#d-batts') < y('.tiles'); });
check('battery bars sit where the average bar was (above the summary tiles)', order);
await p.click('#d-batts .tile:nth-child(1) .ib');
check('pack details (volts, amps, temperature, capacity, cycles, health, cells, limits) in the popover', /Voltage\s+51\.05 V/.test(await p.textContent('#d-batts .tile:nth-child(1) .pop')) && /Temperature\s+28 °C/.test(await p.textContent('#d-batts .tile:nth-child(1) .pop')) && /Capacity\s+79\.9 \/ 80 Ah/.test(await text('d-batts')) && /Cycles\s+9/.test(await p.textContent('#d-batts .tile:nth-child(1) .pop')) && /Charge limit\s+100%/.test(await p.textContent('#d-batts .tile:nth-child(1) .pop')) && /Discharge limit\s+0%/.test(await p.textContent('#d-batts .tile:nth-child(1) .pop')));
await p.click('#d-batts .tile:nth-child(1) .ib');
const cellInfo = await p.$$eval('#d-batts .tile:nth-child(1) .pop .cells span', (e) => e.map((x) => ({ t: x.textContent, c: x.className, title: x.title })));
check('every cell voltage is listed (15 cells, in order)', cellInfo.length === 15 && cellInfo[0].t === '3.396' && cellInfo[14].t === '3.384', JSON.stringify(cellInfo.map((c) => c.t)));
check('lowest and highest cells are marked', cellInfo.filter((c) => c.c === 'lo').map((c) => c.t).join() === '3.381' && cellInfo.filter((c) => c.c === 'hi').map((c) => c.t).join() === '3.499' && /Cell 10: 3381 mV \(lowest\)/.test(cellInfo[9].title) && /Cell 7: 3499 mV \(highest\)/.test(cellInfo[6].title), JSON.stringify(cellInfo.filter((c) => c.c)));
check('cell spread and cell temperatures are shown', /Cell spread\s+118 mV \(3\.381–3\.499 V\)/.test(await p.textContent('#d-batts .tile:nth-child(1) .pop')) && /Cell temperatures\s+28 \/ 27 \/ 27 \/ 26 °C/.test(await p.textContent('#d-batts .tile:nth-child(1) .pop')));
await p.keyboard.press('Escape');
check('pack names are in a rail on the left, rotated 90 degrees', JSON.stringify(await p.$$eval('#d-batts .rail', (e) => e.map((x) => x.textContent))) === '["Main","Extra 1"]');
const geo = await p.$eval('#d-batts .tile:nth-child(1)', (t) => { const r = t.querySelector('.rail').getBoundingClientRect(), b = t.querySelector('.soc-bar').getBoundingClientRect(), tr = t.getBoundingClientRect(); const cs = getComputedStyle(t.querySelector('.rail')); return { railLeft: Math.round(r.left - tr.left), barRight: b.left >= r.right, mode: cs.writingMode, rot: cs.transform, h: Math.round(tr.height) }; });
check('rail is flush with the widget\'s left edge, bar to its right, text vertical', geo.railLeft <= 2 && geo.barRight && /vertical/.test(geo.mode) && geo.rot !== 'none', JSON.stringify(geo));
check('battery widgets are short (about 2 lines tall)', geo.h <= 70, JSON.stringify(geo));

await patch('6:50', 'BMS', 'amp', 15000); // extra pack starts charging
await p.waitForTimeout(2600);
const extraC = await segs('#d-batts .tile:nth-child(2)'), mainPackC = await segs('#d-batts .tile:nth-child(1)');
check('the charging pack pulses only its last lit segment', extraC.filter((x) => x.pulse).length === 1 && extraC.findIndex((x) => x.pulse) === extraC.filter((x) => x.w === '100%').length - 1, JSON.stringify(extraC.map((x) => x.pulse)));
check('an idle pack does not pulse', mainPackC.every((x) => !x.pulse));
check('charging label and accessible text', /Charging/.test(await p.textContent('#d-batts .tile:nth-child(2) .soc-flow')) && /charging/.test(await p.getAttribute('#d-batts .tile:nth-child(2) .soc-bar', 'aria-label')), await p.getAttribute('#d-batts .tile:nth-child(2) .soc-bar', 'aria-label'));
const pulses = () => p.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.('.seg.pulse')).map((a) => a.startTime));
const t0 = await pulses();
await p.waitForTimeout(1500); // several data refreshes later
const t1 = await pulses();
check('pulse is not restarted by data refreshes', t0.length >= 1 && JSON.stringify(t0) === JSON.stringify(t1), `${t0} vs ${t1}`);
await p.emulateMedia({ reducedMotion: 'reduce' });
check('no animation with prefers-reduced-motion', (await p.evaluate(() => document.getAnimations().length)) === 0);
await p.emulateMedia({ reducedMotion: 'no-preference' });

await patch('3:50', 'BMS', 'f32ShowSoc', 22.3);
await patch('6:50', 'BMS', 'f32ShowSoc', 7.6);
await p.waitForTimeout(2600);
check('bar turns yellow at/below 25% with a Low label', (await fillColor('#d-batts .tile:nth-child(1)')) === YELLOW && /Low/.test(await p.textContent('#d-batts .tile:nth-child(1) .soc-warn')));
check('pack bar turns red at/below 10% with a Critical label', (await fillColor('#d-batts .tile:nth-child(2)')) === RED && /Critical/.test(await p.textContent('#d-batts .tile:nth-child(2) .soc-warn')));
await patch('3:50', 'BMS', 'f32ShowSoc', 94.1);
await patch('6:50', 'BMS', 'f32ShowSoc', 100);
await patch('6:50', 'BMS', 'amp', 0);

// --- condensed connection bar + live readout ---
const pill = await p.$eval('#status', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, text: e.textContent }; });
check('"Connected" label is not shown visually (the green dot says it), but stays for screen readers', pill.w <= 1 && pill.text === 'Connected', JSON.stringify(pill));
check('live readout is visible while connected', await p.isVisible('#live'));
const ageNow = async () => parseFloat(/([\d.]+) s ago/.exec(await text('age'))?.[1]);
const ages = []; for (let i = 0; i < 12; i++) { ages.push(await ageNow()); await p.waitForTimeout(130); }
check('"Updated N s ago" is live and stays small while data flows', ages.every((a) => a < 3) && new Set(ages).size >= 2, JSON.stringify(ages));
check('age label wording', /^Updated [\d.]+ s ago$/.test(await text('age')));
const bar = await p.evaluate(() => { const c = document.querySelector('#batts').closest('.card'); const r1 = document.querySelector('.batt.on').getBoundingClientRect(), r2 = document.getElementById('stop').getBoundingClientRect(); const m = document.getElementById('msg'); const noteH = m.offsetHeight ? m.offsetHeight + 8 : 0; /* the temporary notice line is not part of the bar */
  return { h: Math.round(c.getBoundingClientRect().height - noteH), sameRow: Math.abs(r1.top - r2.top) < 6 }; });
check('connection bar is two rows: battery, + and Disconnect share the first row', bar.sameRow && bar.h <= 112, JSON.stringify(bar));
await p.evaluate('window.__fake.mute = true');
await p.waitForTimeout(1500);
check('readout turns amber when messages stop arriving', await p.$eval('#live', (e) => e.classList.contains('stale')) && (await ageNow()) >= 1);
await p.evaluate('window.__fake.mute = false');
await p.waitForFunction(() => !document.getElementById('live').classList.contains('stale'), null, { timeout: 4000 });
check('and back to normal once data resumes', !(await p.$eval('#live', (e) => e.classList.contains('stale'))));

// --- controls: AC output, charge and discharge limits ---
const wlog = () => p.evaluate('window.__fake.writesLog');
const waitCtl = (re, timeout = 8000) => p.waitForFunction((r) => new RegExp(r).test(document.getElementById('ctlMsg').textContent), re, { timeout });
check('controls are hidden by default', (await p.isHidden('#controls')) && (await p.getAttribute('#ctlBtn', 'aria-expanded')) === 'false' && !(await p.isVisible('#acBtn')) && !(await p.isVisible('#chgIn')) && !(await p.isVisible('#dsgIn')));
await p.click('#ctlBtn');
check('controls expand on demand and show the battery\'s current values', (await p.isVisible('#acBtn')) && (await text('acNow')) === 'Off' && (await text('chgNow')) === 'Currently 100%' && (await text('dsgNow')) === 'Currently 0%' && (await p.inputValue('#chgIn')) === '100');
check('controls are enabled while connected', !(await p.isDisabled('#acBtn')) && !(await p.isDisabled('#chgApply')));

// AC output: two-step confirm, exact bytes, confirmed by the battery's own report
await p.click('#acBtn');
check('the confirm prompt appears right under the row that was tapped', await p.evaluate(() => document.getElementById('acBtn').closest('.ctl').nextElementSibling.id === 'ctlConfirm'));
check('turning AC on asks first and explains the consequence', (await p.isVisible('#ctlConfirm')) && /ON.*live/.test(await text('ctlConfirmText')), await text('ctlConfirmText'));
await p.click('#ctlNo');
check('cancelling sends nothing', (await wlog()).length === 0 && (await p.isHidden('#ctlConfirm')));
await p.click('#acBtn'); await p.click('#ctlYes');
await waitCtl('AC output on: confirmed by the battery');
check('AC on: exact command bytes (inverter, 0x42, [01, FF x6]) and confirmed from telemetry', JSON.stringify(await wlog()) === JSON.stringify([{ src: 0x21, dst: 4, cmdId: 0x42, payload: '01ffffffffffff' }]) && (await text('acNow')) === 'On', JSON.stringify(await wlog()));
await p.waitForFunction(() => document.getElementById('d-acout').textContent === 'On', null, { timeout: 4000 });
check('the AC output tile follows', (await text('d-acout')) === 'On' && (await text('acBtn')) === 'Turn off…');
await p.click('#acBtn');
check('turning AC off warns that connected devices lose power', /OFF.*lose power/.test(await text('ctlConfirmText')), await text('ctlConfirmText'));
await p.click('#ctlYes');
await waitCtl('AC output off: confirmed by the battery');
check('AC off: exact command bytes [00, FF x6]', (await wlog()).at(-1).payload === '00ffffffffffff' && (await text('acNow')) === 'Off');

// the battery ignores a command: the page says so instead of pretending
await p.evaluate('window.__fake.ignoreWrites = true');
await p.click('#acBtn'); await p.click('#ctlYes');
await waitCtl('AC output on: the battery did not confirm');
check('an ignored command is reported honestly and the shown state stays true', (await text('acNow')) === 'Off' && /ignored the command/.test(await text('ctlMsg')), await text('ctlMsg'));
await p.evaluate('window.__fake.ignoreWrites = false');

// charge limit
await p.fill('#chgIn', '40'); await p.click('#chgApply');
const writes0 = (await wlog()).length;
check('out-of-range charge limit is rejected without sending', /from 50 to 100/.test(await text('ctlMsg')) && (await wlog()).length === writes0, await text('ctlMsg'));
await p.fill('#chgIn', '90'); await p.click('#chgApply');
await waitCtl('Charge limit 90%: confirmed');
check('charge limit: exact bytes (EMS, 0x31, [5A]) and confirmed', (await wlog()).at(-1).dst === 3 && (await wlog()).at(-1).cmdId === 0x31 && (await wlog()).at(-1).payload === '5a' && (await text('chgNow')) === 'Currently 90%', JSON.stringify((await wlog()).at(-1)));
await p.fill('#chgIn', '90'); await p.click('#chgApply');
check('re-applying the current value does nothing', /Already set to 90%/.test(await text('ctlMsg')) && (await wlog()).length === writes0 + 1);

// discharge limit
await p.fill('#dsgIn', '31'); await p.click('#dsgApply');
check('out-of-range discharge limit is rejected', /from 0 to 30/.test(await text('ctlMsg')));
await p.fill('#dsgIn', '10'); await p.click('#dsgApply');
await waitCtl('Discharge limit 10%: confirmed');
check('discharge limit: exact bytes (EMS, 0x33, [0A]) and confirmed', (await wlog()).at(-1).cmdId === 0x33 && (await wlog()).at(-1).payload === '0a' && (await text('dsgNow')) === 'Currently 10%');
await patch('3:2', 'EMS', 'f32LcdShowSoc', 20);
await p.waitForTimeout(2600);
const nWrites = (await wlog()).length;
await p.fill('#dsgIn', '25'); await p.click('#dsgApply');
check('a discharge limit above the current charge needs an explicit confirm (output would stop)', (await p.isVisible('#ctlConfirm')) && /Current charge is 20\.0%/.test(await text('ctlConfirmText')) && (await wlog()).length === nWrites, await text('ctlConfirmText'));
await p.click('#ctlNo');
check('and cancelling leaves the battery untouched', (await wlog()).length === nWrites && (await text('dsgNow')) === 'Currently 10%');
await patch('3:2', 'EMS', 'f32LcdShowSoc', 94.1147);
check('typing is not overwritten by incoming readings', (await p.inputValue('#dsgIn')) === '25');

// AC charging power (watts) and DC charging current (amps, sent as milliamps)
check('AC charging power and DC charging current show the battery\'s current settings', (await text('acwNow')) === 'Currently 900 W' && (await text('dcaNow')) === 'Currently 6 A' && (await p.inputValue('#acwIn')) === '900' && (await p.inputValue('#dcaIn')) === '6');
check('AC charging power shows the equivalent current and the unit\'s range', /≈ 7\.\d A at 11\d V/.test(await text('acwHint')) && /200–1800 W/.test(await text('acwRange')), `${await text('acwHint')} | ${await text('acwRange')}`);
await p.fill('#acwIn', '1200');
check('the amps hint follows what is typed', /≈ 10\.\d A/.test(await text('acwHint')), await text('acwHint'));
const wAc = (await wlog()).length;
await p.fill('#acwIn', '100'); await p.click('#acwApply');
check('AC charging power below the range is rejected without sending', /from 200 to 1800/.test(await text('ctlMsg')) && (await wlog()).length === wAc, await text('ctlMsg'));
await p.fill('#acwIn', '1900'); await p.click('#acwApply');
check('AC charging power above the rated maximum is rejected', /from 200 to 1800/.test(await text('ctlMsg')) && (await wlog()).length === wAc);
await p.fill('#acwIn', '1200'); await p.click('#acwApply');
await waitCtl('AC charging power 1200 W: confirmed');
const lastAc = (await wlog()).at(-1);
check('AC charging power: exact command (src 0x20, inverter, 0x45, [FF FF B0 04 FF]) and confirmed', lastAc.src === 0x20 && lastAc.dst === 4 && lastAc.cmdId === 0x45 && lastAc.payload === 'ffffb004ff' && (await text('acwNow')) === 'Currently 1200 W', JSON.stringify(lastAc));

const wDc = (await wlog()).length;
await p.fill('#dcaIn', '9'); await p.click('#dcaApply');
check('DC charging current above 8 A is rejected', /from 4 to 8 A/.test(await text('ctlMsg')) && (await wlog()).length === wDc);
await p.fill('#dcaIn', '3'); await p.click('#dcaApply');
check('DC charging current below 4 A is rejected', /from 4 to 8 A/.test(await text('ctlMsg')) && (await wlog()).length === wDc);
await p.fill('#dcaIn', '8'); await p.click('#dcaApply');
check('DC charging current always asks first and is anchored to its row', (await p.isVisible('#ctlConfirm')) && /8 A.*car socket/.test(await text('ctlConfirmText')) && (await p.evaluate(() => document.getElementById('dcaApply').closest('.ctl').nextElementSibling.id === 'ctlConfirm')), await text('ctlConfirmText'));
await p.click('#ctlNo');
check('cancelling sends nothing', (await wlog()).length === wDc);
await p.click('#dcaApply'); await p.click('#ctlYes');
await waitCtl('DC charging current 8 A: confirmed');
const lastDc = (await wlog()).at(-1);
check('DC charging current: exact command (MPPT, 0x47, 8000 mA = 40 1F 00 00) and confirmed from telemetry', lastDc.dst === 5 && lastDc.cmdId === 0x47 && lastDc.payload === '401f0000' && (await text('dcaNow')) === 'Currently 8 A', JSON.stringify(lastDc));
await patch('4:2', 'INV', 'cfgSlowChgWatts', 900); await patch('5:2', 'MPPT', 'cfgDcChgCurrent', 6000);

await p.click('#ctlBtn');
check('controls can be collapsed again', await p.isHidden('#controls'));
await patch('3:2', 'EMS', 'maxChargeSoc', 100); await patch('3:2', 'EMS', 'minDsgSoc', 0);
await p.waitForTimeout(2200);

// --- debug off: quiet log ---
const quiet = await text('log');
check('verbose logging suppressed when debug is off', !/rx src|state:|connecting GATT|tx raw/.test(quiet), quiet.slice(0, 200));
check('first add shows a short "Added ..." notice (not a duplicate of the status pill)', /^Added Battery 0001\./.test(await text('msg')) && !/^Connected/.test(await text('msg')), await text('msg'));
check('debug toggle is inside Advanced (hidden until opened)', !(await p.isVisible('#debug')));
await p.click('#advBtn');
await p.check('#debug');
check('debug panel visible after toggle', await p.isVisible('#debugPanel'));
await p.waitForTimeout(2500);
check('verbose logging appears when debug is on', /rx src/.test(await text('log')));
check('debug setting persisted', await p.evaluate(() => localStorage.getItem('ef.debug')) === '1');
await p.uncheck('#debug');
await p.click('#advBtn');

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
await p.waitForTimeout(2300); // two more history samples arrive (1 s interval in this test)
check('a hovered tooltip survives new readings arriving', await p.isVisible('#c-power .tip'));
check('tooltip shows on hover', await p.isVisible('#c-power .tip') && /W/.test(await text('c-power')), '');
await p.click('#ranges button[data-range="7d"]');
check('range selection persisted', (await p.evaluate(() => localStorage.getItem('ef.range'))) === '7d');
await p.click('#ranges button[data-range="1h"]');

// --- auto-reconnect after link drop ---
await fake('drop()');
await p.waitForFunction(() => /^Reconnecting/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
check('stop button reads Cancel while reconnecting', (await text('stop')) === 'Cancel');
await waitStatus(CONNECTED);
check('auto-reconnects after the link drops', (await fake('connects')) === 2 && (await text('status')) === 'Connected' && (await text('msg')) === '', `connects=${await fake('connects')} msg=${await text('msg')}`);
check('an automatic reconnect does not show an old signal reading', (await text('sig')) === '');
await p.waitForTimeout(2500);
check('telemetry resumes after reconnect', (await p.textContent('#d-batts .tile:nth-child(1) .soc-pct')) === '94.1%');

// --- stall watchdog ---
await p.evaluate('window.__fake.mute = true');
await p.waitForFunction(() => /^No data for/.test(document.getElementById('msg').textContent) || /^Reconnecting/.test(document.getElementById('status').textContent), null, { timeout: 12000 });
await p.evaluate('window.__fake.mute = false');
await waitStatus(CONNECTED);
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
await p.click('#stop');
const connectsAtStop = await fake('connects');
await p.waitForTimeout(1500);
check('after disconnecting the status pill is visible again and the readout is gone', (await p.$eval('#status', (e) => e.getBoundingClientRect().width)) > 20 && !(await p.isVisible('#live')));
check('disconnect does not auto-reconnect', (await fake('connects')) === connectsAtStop && (await text('status')) === 'Disconnected' && !(await p.isVisible('#stop')) && !/\bon\b/.test(await p.getAttribute('.batt', 'class')));
check('wake lock released on disconnect', (await p.evaluate('window.__wl.releases')) >= 1);

// --- history survives a reload ---
await p.reload();
await p.waitForFunction(() => /\d+ readings/.test(document.getElementById('h-count').textContent), null, { timeout: 5000 });
check('history survives reload', true);
await p.click('#clearHist');
check('clear history', /no readings/.test(await text('h-count')));

// --- batteries ---
const batt = (sel) => p.evaluate((q) => JSON.parse(localStorage.getItem('ef.batteries')), sel);
const names = () => p.$$eval('.batt', (e) => e.map((x) => x.textContent));
const activeName = () => p.$$eval('.batt.on', (e) => e.map((x) => x.textContent));
const saved1 = await batt();
check('battery saved after connecting + authenticating (serial and browser device id)', saved1?.list?.length === 1 && saved1.list[0].serial === 'TESTX0000000001' && saved1.list[0].deviceId === 'fake-device-id-0000', JSON.stringify(saved1));
check('Add button turns secondary once a battery exists', (await text('addBtn')) === '+' && (await p.getAttribute('#addBtn', 'aria-label')) === 'Add battery' && !/primary/.test(await p.getAttribute('#addBtn', 'class')));

await p.reload(); // a fresh visit: the fake browser still remembers the permission
check('after reload the saved battery is listed (not connected)', JSON.stringify(await names()) === '["Battery 0001"]' && (await activeName()).length === 0 && (await text('status')) === 'Not connected');
await p.click('.batt');
await waitStatus(CONNECTED);
check('tapping the battery connects WITHOUT the chooser', (await fake('picks')) === 0 && (await fake('connects')) === 1 && JSON.stringify(await fake('connectedIds')) === '["fake-device-id-0000"]', `picks=${await fake('picks')}`);

// pressing Add and picking a battery that is already saved: no duplicate, and the user is told
await p.click('#addBtn');
await waitStatus(CONNECTED);
check('adding an already-saved battery says so and creates no duplicate', /already saved as Battery 0001/.test(await text('msg')) && JSON.stringify(await names()) === '["Battery 0001"]' && (await fake('picks')) === 1, `${await text('msg')} ${JSON.stringify(await names())}`);

// add a second battery while connected to the first (only one connection at a time)
await p.evaluate("window.__fake.nextPick = 'B'");
await p.click('#addBtn');
await p.waitForFunction(() => document.querySelectorAll('.batt').length === 2 && document.getElementById('status').textContent === 'Connected', null, { timeout: 15000 });
check('second battery is added only after it connected, and becomes the active one', JSON.stringify(await names()) === '["Battery 0001","Battery 0002"]' && JSON.stringify(await activeName()) === '["Battery 0002"]' && (await fake('picks')) === 2, JSON.stringify([await names(), await activeName()]));
check('a newly added battery is announced', /^Added Battery 0002\./.test(await text('msg')), await text('msg'));
check('switching closed the first connection (one at a time)', (await fake('disconnects')) >= 1 && (await fake('serial')) === 'TESTX0000000002');

// switch back with one tap, no chooser; the right serial must be used for authentication
await p.click('.batt[data-serial="TESTX0000000001"]');
await waitStatus(CONNECTED);
await p.waitForFunction(() => /dBm/.test(document.getElementById('sig').textContent), null, { timeout: 2000 }).catch(() => {});
check('a new connection (switching battery) shows a fresh signal reading', /^-\d+ dBm/.test(await text('sig')), await text('sig'));
check('tapping the other battery switches to it without the chooser', JSON.stringify(await activeName()) === '["Battery 0001"]' && (await fake('picks')) === 2 && (await fake('serial')) === 'TESTX0000000001', `${await activeName()} picks=${await fake('picks')}`);
await p.waitForFunction(() => /%/.test(document.querySelector('#d-batts .tile:nth-child(1) .soc-pct')?.textContent), null, { timeout: 10000 }).catch(() => {});
check('dashboard refills with the switched-to battery\'s data', /%/.test(await p.textContent('#d-batts .tile:nth-child(1) .soc-pct')));

// rename + manage
await p.click('#advBtn');
await p.fill('#battList .battrow:nth-child(1) input', 'Garage');
await p.keyboard.press('Enter');
await p.click('#battList .battrow:nth-child(1) small'); // blur commits the change
check('rename updates the button and is saved', JSON.stringify(await names()) === '["Garage","Battery 0002"]' && (await batt()).list[0].nickname === 'Garage', JSON.stringify(await names()));
await p.click('#battList .battrow:nth-child(2) .rm');
const granted1 = await p.evaluate(() => JSON.parse(localStorage.getItem('fake.granted')));
check('removing a battery deletes it and revokes the browser permission; the connected one is unaffected', JSON.stringify(await names()) === '["Garage"]' && !granted1.includes('fake-device-id-0001') && (await text('status')) === 'Connected', JSON.stringify(granted1));
await p.click('#battList .battrow:nth-child(1) .rm');
check('removing the connected battery disconnects and returns to "Add battery"', (await names()).length === 0 && (await text('status')) === 'Disconnected' && /primary/.test(await p.getAttribute('#addBtn', 'class')) && (await p.evaluate(() => JSON.parse(localStorage.getItem('fake.granted')).length)) === 0);
await p.click('#advBtn');

// a saved battery whose browser permission is gone falls back to the chooser (and heals the saved id)
await p.evaluate(() => { localStorage.setItem('ef.batteries', JSON.stringify({ v: 1, last: 'TESTX0000000001', list: [{ serial: 'TESTX0000000001', deviceId: 'gone', nickname: '' }] })); localStorage.removeItem('fake.granted'); });
await p.reload();
await p.click('.batt');
await waitStatus(CONNECTED);
check('stale browser permission: the chooser is used and the saved id is refreshed', (await fake('picks')) === 1 && (await batt()).list[0].deviceId === 'fake-device-id-0000');
await p.click('#stop');

// the chooser returned a DIFFERENT battery than the one tapped: identity follows the serial
await p.evaluate(() => { localStorage.setItem('ef.batteries', JSON.stringify({ v: 1, last: 'TESTX0000000001', list: [{ serial: 'TESTX0000000001', deviceId: 'gone', nickname: '' }] })); localStorage.removeItem('fake.granted'); });
await p.reload();
await p.evaluate("window.__fake.nextPick = 'B'");
await p.click('.batt');
await waitStatus(CONNECTED);
check('wrong-battery notice explains what happened', /different battery, not Battery 0001\. Added it as Battery 0002/.test(await text('msg')), await text('msg'));
check('picking another battery connects to that one and saves it', JSON.stringify(await activeName()) === '["Battery 0002"]' && JSON.stringify(await names()) === '["Battery 0001","Battery 0002"]' && (await fake('serial')) === 'TESTX0000000002', JSON.stringify([await names(), await activeName()]));
await p.click('#stop');

// the single device remembered by the previous version is migrated into the list
await p.evaluate(() => { localStorage.removeItem('ef.batteries'); localStorage.setItem('ef.device', JSON.stringify({ id: 'fake-device-id-0000', name: 'ECOFLOW_BLE', serial: 'TESTX0000000001' })); localStorage.setItem('fake.granted', JSON.stringify(['fake-device-id-0000'])); });
await p.reload();
check('legacy single saved device is migrated to a battery', JSON.stringify(await names()) === '["Battery 0001"]' && (await p.evaluate(() => localStorage.getItem('ef.device'))) === null);
await p.click('.batt');
await waitStatus(CONNECTED);
check('migrated battery connects without the chooser', (await fake('picks')) === 0);
await p.click('#stop');

// browser without getDevices(): still works through the chooser, and switching within a visit needs no chooser
const p2 = await b.newPage();
await p2.addInitScript('window.__noGetDevices = true;');
await p2.addInitScript(WAKELOCK_STUB);
await p2.addInitScript(out.outputFiles[0].text);
await p2.goto(url);
await p2.evaluate(() => localStorage.setItem('ef.userId', '1234'));
await p2.reload();
await p2.click('#addBtn');
await p2.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, { timeout: 15000 });
check('unsupported browser: first add goes through the chooser', (await p2.evaluate('window.__fake.picks')) === 1);
await p2.click('#stop');
await p2.click('.batt');
await p2.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, { timeout: 15000 });
check('unsupported browser: reconnecting within the same visit needs no chooser', (await p2.evaluate('window.__fake.picks')) === 1);
await p2.click('#advBtn');
check('unsupported browser: explains it cannot remember across visits', /can't remember devices across visits/.test(await p2.textContent('#battNote')));
await p2.close();

check('no page errors', errs.length === 0, JSON.stringify(errs));
await b.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? `E2E FAIL (${failed} failed)` : 'E2E PASS');
process.exit(failed ? 1 : 0);
