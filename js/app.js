// EcoFlow Delta Pro monitor UI: connect, authenticate, live dashboard, history charts.
import { BleLink } from './ble.js';
import { EfSession } from './session.js';
import { hex } from './protocol.js';
import { fetchUserId } from './login.js';
import { decodeTelemetry, summarize } from './decode.js';
import { History, toCsv } from './history.js';
import { LineChart, fullTime } from './chart.js';
import { createSocBar } from './socbar.js';
import { Batteries, displayName, connectNotice } from './batteries.js';
import { EtaEstimator, fmtEta } from './eta.js';
import { fmtAge, signalText } from './live.js';
import { OPTIONS, cmdAcCharging, cmdAcOutput, cmdChargeLimit, cmdDischargeLimit, cmdAcChargePower, cmdDcChargeCurrent, acChargeMax, validateLimit, validateAcChargePower, validateDcChargeCurrent, dischargeLimitStopsOutput, confirmed, LIMITS } from './controls.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('ef.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('ef.' + k, v); } catch {} },
  remove: (k) => { try { localStorage.removeItem('ef.' + k); } catch {} },
};

// Tunables (URL params exist so the end-to-end tests can run fast: ?fine=1000&stall=3000&retry=200&save=500)
const q = new URLSearchParams(location.search);
const T = {
  fineMs: +q.get('fine') || 15000,     // history sample interval
  saveMs: +q.get('save') || 60000,     // how often history is written to localStorage
  stallMs: +q.get('stall') || 20000,   // no packets for this long => reconnect
  retryMs: +q.get('retry') || 2000,
  staleMs: +q.get('stale') || 5000,       // no message for this long: the readout turns amber
  ctlConfirmMs: +q.get('ctl') || 6000,     // how long to wait for the battery to report a changed setting
  sigShowMs: +q.get('sigshow') || 10000,   // the signal reading is shown for this long after connecting, then fades out    // reconnect backoff base (doubles up to x16, max 30 s)
};

// Delta Pro heartbeat requests, from the ha-ef-ble Delta Pro driver: [src, dst, cmdSet, cmdId]
const POLL_MAP = [[0x21, 0x02, 0x20, 0x02], [0x21, 0x05, 0x20, 0x02], [0x21, 0x04, 0x20, 0x02],
  [0x21, 0x03, 0x20, 0x02], [0x21, 0x03, 0x20, 0x32]];

let link = null, session = null, ctx = null; // ctx = { userId, serial } once a device has been picked
let pollTimer = null, pollIdx = 0, pollBusy = false;
let picking = false; // device chooser is open
let restored = false; // the current device came from the browser's remembered devices (no chooser)
const batteries = new Batteries(store);
let signal = null; // { rssi } measured from the battery's advertisement just before connecting
let signalShownAt = null; // when the reading started showing (first connection only), for the 10 s fade
let requestedSerial = null; // serial of the battery the user tapped (null = Add)
let advancedAutoOpened = false; // we opened Advanced for first-run setup (so we may fold it away again)
let want = false, establishing = false, attempt = 0, reconnectTimer = null, watchdog = null, lastRx = 0, hadSession = false;
let state = { bms: {} }; // latest decoded message of each kind
const eta = new EtaEstimator();
let etaView = null; // latest estimate; shown only while connected and data is fresh (see renderLive)
let mpptDst = 0x05; // address the MPPT answers from (0x05 on the Delta Pro; some models use 0x07)
let debug = store.get('debug') === '1';
const capture = []; // what was logged, for the downloadable log
const seen = new Map(); // "src dst set id" -> {count, last, len}

// ---------- logging: info always, debug only when the toggle is on ----------
function log(msg, cls = '', level = 'info') {
  if (level === 'debug' && !debug) return;
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  capture.push(line);
  if (capture.length > 20000) capture.shift();
  const el = $('log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  el.appendChild(div);
  while (el.childElementCount > 400) el.firstChild.remove();
  if ($('follow').checked) el.scrollTop = el.scrollHeight;
}
const dlog = (msg, cls = '') => log(msg, cls, 'debug');
/** Routine status belongs to the status pill; the message line is for things that need attention. */
function clearMsg() { const e = $('msg'); e.textContent = ''; e.className = ''; }
/** A message the user should see even with debug off. */
function say(msg, cls = '') { const e = $('msg'); e.textContent = msg; e.className = cls; log(msg, cls); }

function setStatus(s, cls = '') { const e = $('status'); e.textContent = s; e.className = 'pill ' + cls + (s === 'Connected' ? ' quiet' : ''); syncButton(); renderLive(); }
/** Stop button (Cancel while connecting, Disconnect once connected) and the battery buttons. */
function syncButton() {
  renderControls();
  const connected = want && session?.authenticated && !establishing && !reconnectTimer;
  if (!connected) { etaView = null; eta.reset(); } // never show an estimate from before a disconnect
  const stop = $('stop');
  stop.hidden = !want;
  stop.textContent = connected ? 'Disconnect' : 'Cancel';
  renderBatteries(connected);
}
const h2 = (n) => n.toString(16).padStart(2, '0');

/** Advanced is a plain disclosure (not <details>) so the status readout can share its row. */
function setAdvanced(open) {
  $('advanced').hidden = !open;
  $('advBtn').setAttribute('aria-expanded', String(open));
  $('advBtn').textContent = open ? 'Advanced ▴' : 'Advanced ▾';
}

function applyDebug() {
  $('debug').checked = debug;
  $('debugPanel').hidden = !debug;
}

function renderSeen() {
  const rows = [...seen.entries()].sort().map(([k, v]) =>
    `<tr><td>${k}</td><td>${v.count}</td><td>${v.len}</td><td class="mono">${v.last.slice(0, 120)}${v.last.length > 120 ? '…' : ''}</td></tr>`);
  $('seen').innerHTML = rows.join('') || '<tr><td colspan="4">nothing yet</td></tr>';
}

function onPacket(p) {
  lastRx = Date.now();
  beat();
  const t = decodeTelemetry(p);
  if (t) {
    if (t.kind === 'bms') state.bms[t.data.num] = t.data; else state[t.kind] = t.data;
    if (t.kind === 'mppt') mpptDst = p.src;
    scheduleRender();
  }
  if (!debug) return;
  const key = `src ${h2(p.src)} → dst ${h2(p.dst)}  set ${h2(p.cmdSet)} id ${h2(p.cmdId)}`;
  const e = seen.get(key) ?? { count: 0 };
  seen.set(key, { count: e.count + 1, last: hex(p.payload), len: p.payload.length });
  if (e.count < 3) dlog(`rx ${key} v${p.version.toString(16)} payload[${p.payload.length}]=${hex(p.payload)}`);
  if (!renderSeen.pending) { renderSeen.pending = true; setTimeout(() => { renderSeen.pending = false; renderSeen(); }, 250); }
}

// ---------- dashboard ----------
const fmt = (v, d = 0, unit = '') => (v == null || Number.isNaN(v) ? '—' : `${Number(v).toFixed(d)}${unit}`);
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; setTimeout(() => { renderQueued = false; render(); }, 250); } }
function set(id, text) { $(id).textContent = text; }
// ---------- tiles whose extra details open in a popover ----------
function setInfo(tile, open) {
  tile.classList.toggle('open', open);
  tile.querySelector('.pop').hidden = !open;
  tile.querySelector('.ib').setAttribute('aria-expanded', String(open));
}
const closeInfo = (except) => document.querySelectorAll('.tile.info.open').forEach((t) => { if (t !== except) setInfo(t, false); });
function attachInfo(tile) {
  const btn = tile.querySelector('.ib');
  btn.setAttribute('aria-label', `Details: ${tile.dataset.label}`);
  const toggle = () => { const open = !tile.classList.contains('open'); closeInfo(tile); setInfo(tile, open); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); }); // the button is the keyboard/screen-reader control
  tile.addEventListener('click', (e) => { if (!e.target.closest('.pop')) toggle(); }); // tapping anywhere on the tile works too
}
document.addEventListener('click', (e) => { if (!e.target.closest('.tile.info')) closeInfo(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInfo(); });
/** rows: [label, value] pairs, or { label, grid: [{ text, title, cls }] } for a small grid. Text only (no HTML). */
function setDetails(tile, rows) {
  tile.querySelector('.pop').replaceChildren(...rows.map((row) => {
    const d = document.createElement('div'), l = document.createElement('span');
    if (Array.isArray(row)) { l.textContent = `${row[0]} `; d.append(l, document.createTextNode(row[1])); return d; }
    l.textContent = row.label;
    const g = document.createElement('div');
    g.className = 'cells';
    for (const c of row.grid) { const x = document.createElement('span'); x.textContent = c.text; x.title = c.title; if (c.cls) x.className = c.cls; g.append(x); }
    d.append(l, g);
    return d;
  }));
}
document.querySelectorAll('.tile.info').forEach(attachInfo);
const tileOf = (id) => $(id).closest('.tile');
const tIn = tileOf('d-in'), tOut = tileOf('d-out'), tAc = tileOf('d-ac'), tAcOut = tileOf('d-acout');

// ---------- dashboard ----------
const packs = new Map(); // pack number -> { tile, rail, stats, bar }; kept alive so bar animations are not restarted
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
function packEntry(num, label) {
  let e = packs.get(num);
  if (!e) {
    const tile = el('div', 'tile info pack'), rail = el('div', 'rail'), body = el('div', 'pack-body'), slot = el('div'), stats = el('span', 'soc-extra'), btn = el('button', 'ib'), pop = el('div', 'pop');
    tile.dataset.label = label;
    btn.type = 'button'; btn.textContent = 'ⓘ'; btn.setAttribute('aria-expanded', 'false');
    pop.hidden = true;
    const bar = createSocBar(slot, { compact: true });
    bar.info.append(stats, btn); // percent · state · stats ... (i)
    body.append(slot);
    tile.append(rail, body, pop);
    attachInfo(tile);
    e = { tile, rail, stats, bar };
    packs.set(num, e);
  }
  return e;
}
/** Wording for the charge / discharge estimate (see js/eta.js for how it is calculated). */
function renderEta(est, wallW) {
  etaView = est;
  if (est.mode !== 'charging' && est.mode !== 'discharging') return;
  const charging = est.mode === 'charging';
  let main;
  if (est.done) main = `${charging ? 'Charge' : 'Discharge'} limit reached (${est.targetPct}%)`;
  else {
    const dur = fmtEta(est.minutes, est.over);
    main = charging ? (est.targetPct >= 100 ? `Full in ≈ ${dur}` : `${est.targetPct}% in ≈ ${dur}`) : (est.targetPct <= 0 ? `Empty in ≈ ${dur}` : `Down to ${est.targetPct}% in ≈ ${dur}`);
  }
  let at = '';
  if (!est.done && !est.over) {
    const now = new Date(), when = new Date(now.getTime() + est.minutes * 60000), day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day0(when) - day0(now)) / 86400000); // 0 = today
    const day = diff === 0 ? '' : `${when.toLocaleDateString([], { weekday: 'short' })} `; // a short day name keeps the line from being cut off
    at = `${day}${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  // Two short lines that never wrap: the time left and when, then the power. The wall figure sits next to the battery-side one:
  // the difference is charging losses (about 12 %) and anything running from the outlets.
  const pw = Math.round(est.powerW);
  const sub = charging ? (Number.isFinite(wallW) && wallW > 0 ? `${Math.round(wallW)} W in · ${pw} W to batteries` : `${pw} W to batteries`) : `${pw} W out`;
  $('etaMain').textContent = main;
  $('etaAt').textContent = at;
  $('etaSub').textContent = sub;
}

function render() {
  const m = summarize(state);
  set('d-in', fmt(m.inW, 0, ' W'));
  setDetails(tIn, [['AC', fmt(m.acInW, 0, ' W')], ['Solar / DC', fmt(m.solarW, 0, ' W')]]);
  set('d-out', fmt(m.outW, 0, ' W'));
  setDetails(tOut, [['AC', fmt(m.acOutW, 0, ' W')], ['12 V', fmt(m.carW, 0, ' W')], ['USB-A', fmt(m.usbA, 0, ' W')], ['USB-C', fmt(m.usbC, 0, ' W')]]);
  set('d-ac', m.acInV == null ? '—' : fmt(m.acInV, 1, ' V'));
  setDetails(tAc, [['Current', fmt(m.acInA, 2, ' A')], ['Frequency', fmt(m.acInHz, 0, ' Hz')], ['Power', fmt(m.acInW, 0, ' W')], ['Charging', m.acChargingPaused == null ? '—' : m.acChargingPaused ? 'Paused' : 'Allowed']]);
  $('pauseNote').hidden = !m.acChargingPaused;
  $('resumeBtn').disabled = !isConnected() || ctlBusy;
  set('d-acout', m.acOutEnabled == null ? '—' : m.acOutEnabled ? 'On' : 'Off');
  setDetails(tAcOut, [['Power', fmt(m.acOutW, 0, ' W')], ['Set to', fmt(m.acOutV, 0, ' V')]]);
  const box = $('d-batts'), live = new Set(m.batteries.map((b) => b.num));
  for (const [num, e] of packs) if (!live.has(num)) { e.tile.remove(); packs.delete(num); }
  m.batteries.forEach((b, i) => {
    const label = b.num === 0 ? 'Main battery' : `Extra battery ${b.num}`, e = packEntry(b.num, label);
    if (box.children[i] !== e.tile) box.insertBefore(e.tile, box.children[i] ?? null); // moving a node restarts animations, so only when needed
    e.rail.textContent = b.num === 0 ? 'Main' : `Extra ${b.num}`;
    e.bar.update({ soc: b.soc, flow: b.flow, label });
    e.stats.textContent = `${fmt(b.volts, 2, ' V')} · ${fmt(b.amps, 2, ' A')} · ${fmt(b.tempC, 0, ' °C')}`;
    const rows = [['Voltage', fmt(b.volts, 2, ' V')], ['Current', fmt(b.amps, 2, ' A')], ['Temperature', fmt(b.tempC, 0, ' °C')], ['Capacity', `${fmt(b.remainAh, 1)} / ${fmt(b.designAh, 0, ' Ah')}`], ['Cycles', String(b.cycles)], ['Health', `${b.sohPct}%`],
      ['Cell spread', b.cellSpreadMv == null ? '—' : `${b.cellSpreadMv} mV (${(b.cellMinMv / 1000).toFixed(3)}–${(b.cellMaxMv / 1000).toFixed(3)} V)`]];
    if (b.cells?.length) {
      const lo = b.cells.indexOf(Math.min(...b.cells)), hi = b.cells.indexOf(Math.max(...b.cells));
      rows.push({ label: `Cell voltages (V), cells 1–${b.cells.length}`, grid: b.cells.map((v, i) => ({ text: (v / 1000).toFixed(3), title: `Cell ${i + 1}: ${v} mV${i === lo ? ' (lowest)' : i === hi ? ' (highest)' : ''}`, cls: i === lo && lo !== hi ? 'lo' : i === hi && lo !== hi ? 'hi' : '' })) });
    }
    if (b.cellTemps?.length) rows.push(['Cell temperatures', `${b.cellTemps.join(' / ')} °C`]);
    rows.push(['Charge limit', fmt(m.chargeLimitMax, 0, '%')], ['Discharge limit', fmt(m.dischargeLimitMin, 0, '%')]);
    setDetails(e.tile, rows);
  });
  renderEta(isConnected() ? eta.update(Date.now(), m.batteries.map((b) => ({ soc: b.soc, volts: b.volts, amps: b.amps, fullAh: b.fullAh })), { chargeMax: m.chargeLimitMax, dischargeMin: m.dischargeLimitMin }) : (eta.reset(), { mode: 'unknown' }), m.inW);
  renderControls();
  if (debug) $('d-json').textContent = JSON.stringify(state, (k, v) => (v instanceof Uint8Array ? hex(v) : v), 1);
}

// ---------- history + charts ----------
// One history per battery (keyed by serial), so each battery's charts show only its own readings.
const histories = new Map(); // serial -> { h: History, dirty: boolean }
const histKey = (serial) => `history.${serial}`;
function histFor(serial) {
  let e = histories.get(serial);
  if (!e) {
    let h;
    try { h = History.fromJSON(JSON.parse(store.get(histKey(serial), 'null')), { fineMs: T.fineMs }); } catch { h = new History({ fineMs: T.fineMs }); }
    histories.set(serial, e = { h, dirty: false });
  }
  return e;
}
/** Earlier versions kept one history for everything. It cannot be split by battery, so it goes to the battery used last. */
(function migrateHistory() {
  const old = store.get('history', '');
  if (!old) return;
  if (batteries.last && !store.get(histKey(batteries.last), '')) store.set(histKey(batteries.last), old);
  if (batteries.last) store.remove('history');
})();
/** The battery whose history the charts show: the one connected (or last connected), else the most recently used. */
const viewSerial = () => (ctx?.serial && batteries.get(ctx.serial) ? ctx.serial : batteries.last);
const viewName = () => { const b = batteries.get(viewSerial()); return b ? displayName(b) : ''; };
function saveHistory() {
  for (const [serial, e] of histories) {
    if (!e.dirty) continue;
    try { localStorage.setItem('ef.' + histKey(serial), JSON.stringify(e.h)); e.dirty = false; } catch (err) { dlog(`could not save history: ${err.message}`, 'err'); }
  }
}

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '14d': 14 * 86400e3 };
let range = RANGES[store.get('range')] ? store.get('range') : '6h';
const charts = [
  new LineChart($('c-soc'), { title: 'Battery charge', series: [{ key: 'soc', label: 'Charge', color: '--series-1' }], unit: '%', decimals: 1, yMin: 0, yMax: 100 }),
  new LineChart($('c-power'), { title: 'Power', series: [{ key: 'inW', label: 'In', color: '--series-1' }, { key: 'outW', label: 'Out', color: '--series-2' }], unit: ' W', yMin: 0, minSpan: 100 }),
  new LineChart($('c-temp'), { title: 'Battery temperature (hottest pack)', series: [{ key: 'tempC', label: 'Temp', color: '--series-1' }], unit: ' °C', minSpan: 10 }),
];
let histOpen = false; // History is collapsed by default (recording continues either way)
function setHistory(open) {
  histOpen = open;
  $('histBody').hidden = !open;
  $('histBtn').setAttribute('aria-expanded', String(open));
  $('histBtn').textContent = open ? 'Hide ▴' : 'Show ▾';
  if (open) updateCharts();
}
let chartsQueued = false;
function scheduleCharts() { if (!chartsQueued) { chartsQueued = true; setTimeout(() => { chartsQueued = false; updateCharts(); }, 300); } }
let lastQuery = null;
function updateCharts() {
  const serial = viewSerial();
  lastQuery = serial ? histFor(serial).h.query(RANGES[range]) : { from: Date.now() - RANGES[range], to: Date.now(), stepMs: T.fineMs, points: [] };
  const { points, from, to, stepMs } = lastQuery;
  const name = viewName();
  set('h-count', (name ? `${name}: ` : '') + (points.length ? `${points.length} reading${points.length === 1 ? '' : 's'}` : 'no readings in this range'));
  if (!histOpen) return; // nothing to draw while collapsed; it is redrawn when opened
  for (const c of charts) c.setData({ points, from, to, stepMs });
  for (const b of $('ranges').children) b.setAttribute('aria-pressed', String(b.dataset.range === range));
  if ($('tableView').open) renderTable(points);
}
function renderTable(points) {
  const rows = points.length > 60 ? points.filter((_, i) => i % Math.ceil(points.length / 60) === 0 || i === points.length - 1) : points;
  const tb = $('histTable').tBodies[0];
  tb.replaceChildren(...rows.slice().reverse().map((p) => {
    const tr = document.createElement('tr');
    for (const v of [fullTime(p.t), fmt(p.soc, 1), fmt(p.inW), fmt(p.outW), fmt(p.tempC)]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    return tr;
  }));
}
function sampleHistory() {
  if (!session?.authenticated || Date.now() - lastRx > 5000) return;
  const m = summarize(state);
  if (m.soc == null || m.inW == null) return; // wait until both the EMS and PD packets have arrived
  if (!ctx?.serial) return;
  const temps = m.batteries.map((b) => b.tempC).filter((v) => v != null);
  const e = histFor(ctx.serial); // always the battery that is connected right now
  if (e.h.add(Date.now(), { soc: m.soc, inW: m.inW, outW: m.outW, tempC: temps.length ? Math.max(...temps) : null })) { e.dirty = true; scheduleCharts(); }
}
setInterval(sampleHistory, 1000);
setInterval(saveHistory, T.saveMs);
setInterval(updateCharts, 30000); // slide the time window
addEventListener('pagehide', saveHistory);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => charts.forEach((c) => c.draw()));

$('histBtn').onclick = () => setHistory(!histOpen);
$('ranges').onclick = (e) => { const r = e.target.dataset?.range; if (r) { range = r; store.set('range', r); updateCharts(); } };
$('tableView').addEventListener('toggle', () => { if ($('tableView').open && lastQuery) renderTable(lastQuery.points); });
$('exportCsv').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(lastQuery?.points ?? [])], { type: 'text/csv' }));
  a.download = `ecoflow-history-${viewName().replace(/[^\w-]+/g, '_') || 'battery'}-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};
$('clearHist').onclick = () => {
  const serial = viewSerial();
  if (!serial || !confirm(`Delete the recorded history of ${viewName()} on this device?`)) return;
  const e = histFor(serial); e.h.clear(); e.dirty = true; saveHistory(); updateCharts();
};

// ---------- live readout: time since the last message, and signal strength ----------
const isConnected = () => want && !!session?.authenticated && !establishing && !reconnectTimer;
function beat() { // a short blink on every message, so you can see it working without reading numbers
  const b = $('beat');
  b.classList.remove('b'); void b.offsetWidth; b.classList.add('b');
}
function renderLive() {
  const live = $('live'), on = isConnected();
  live.hidden = !on;
  if (!on) { $('eta').hidden = true; return; }
  const age = Date.now() - lastRx, stale = age > T.staleMs;
  $('eta').hidden = !(etaView && (etaView.mode === 'charging' || etaView.mode === 'discharging') && age < 10000);
  $('eta').title = "Estimated from the packs' current and charge level, smoothed over about 15 seconds. It uses the power going into the packs, which is lower than the wall power because of charging losses. Charging slows near full, so the last few percent take longer.";
  live.classList.toggle('stale', stale);
  $('age').textContent = `Updated ${fmtAge(age)} ago`;
  const since = signalShownAt ? Date.now() - signalShownAt : Infinity; // signal: shown on connecting, faded out after sigShowMs
  $('sig').classList.toggle('fade', since >= T.sigShowMs);
  $('sig').textContent = signal && since < T.sigShowMs + 1200 ? signalText(signal) : '';
  live.title = `Last message from the battery ${fmtAge(age)} ago.` + (signalShownAt ? ' The signal strength was measured when connecting (Chrome cannot read it from an open connection).' : '');
}
setInterval(renderLive, 200);

// ---------- batteries: one button per saved battery, plus Add ----------
function renderBatteries(connected = want && session?.authenticated && !establishing && !reconnectTimer) {
  const btns = batteries.list.map((b) => {
    const el = document.createElement('button');
    const active = want && ctx?.serial === b.serial;
    el.type = 'button';
    el.className = 'batt' + (active ? ' active' : '') + (active && connected ? ' on' : '') + (!want && batteries.last === b.serial ? ' last' : '');
    el.dataset.serial = b.serial;
    el.textContent = displayName(b);
    el.title = `Serial ${b.serial}`;
    el.setAttribute('aria-pressed', String(active));
    el.disabled = picking;
    el.onclick = () => { if (!active) startConnect(b); }; // tapping another battery switches to it
    return el;
  });
  $('batts').replaceChildren(...btns);
  const add = $('addBtn');
  add.className = batteries.list.length ? '' : 'primary';
  add.textContent = batteries.list.length ? '+' : 'Add battery';
  add.setAttribute('aria-label', 'Add battery');
  add.disabled = picking || !BleLink.supported;
}

/** The Advanced list: rename / remove. Rebuilt only when the list changes (so typing is not interrupted). */
function renderBatteryManager() {
  $('battList').replaceChildren(...batteries.list.map((b) => {
    const row = document.createElement('div'), name = document.createElement('input'), ser = document.createElement('small'), rm = document.createElement('button');
    row.className = 'battrow';
    name.value = displayName(b); name.maxLength = 40; name.setAttribute('aria-label', `Name for serial ${b.serial}`);
    name.onchange = () => { batteries.rename(b.serial, name.value === `Battery ${b.serial.slice(-4)}` ? '' : name.value); renderBatteries(); updateCharts(); };
    ser.textContent = b.serial;
    rm.type = 'button'; rm.textContent = 'Remove'; rm.className = 'rm';
    rm.onclick = () => removeBattery(b.serial);
    row.append(name, ser, rm);
    return row;
  }));
  $('battNote').textContent = batteries.list.length ? (BleLink.canRemember ? '' : "This browser can't remember devices across visits: after a reload you will choose the battery again (the page checks it is the right one).")
    : 'No batteries yet. Press Add battery.';
}

/** Called once a battery has connected AND authenticated: only then is it saved. */
function rememberBattery() {
  if (!link?.device || !ctx) return;
  const wasKnown = !!batteries.get(ctx.serial);
  batteries.upsert({ serial: ctx.serial, deviceId: link.device.id });
  if (!wasKnown) log(`Added battery ${ctx.serial}`);
  renderBatteryManager(); renderBatteries(); updateCharts(); // the charts follow the battery that is connected
  if (!hadSession) { const n = connectNotice(batteries, requestedSerial, ctx.serial, wasKnown); if (n) say(n, 'dim'); } // only on the first connection, not on automatic reconnects
}

async function removeBattery(serial) {
  const b = batteries.get(serial);
  if (!b) return;
  if (want && ctx?.serial === serial) { stopAll(); setStatus('Disconnected'); }
  batteries.remove(serial);
  histories.delete(serial); store.remove(histKey(serial)); // its history goes with it
  updateCharts();
  if (b.deviceId) { link?.drop(b.deviceId); await BleLink.forget(b.deviceId); } // revoke the browser's permission too
  renderBatteryManager(); renderBatteries();
}

// ---------- controls: AC output, charge / discharge limits (collapsed by default) ----------
let ctlBusy = false, pendingConfirm = null, confirmTimer = null;
const ctlSay = (msg, cls = '') => {
  const e = $('ctlMsg');
  e.textContent = msg; e.className = cls;
  if ($('controls').hidden) say(msg, cls === 'ok' ? 'dim' : cls); // collapsed: the result still has to be seen (e.g. Resume pressed from the notice)
  else log(`controls: ${msg}`, cls);
};
function setControls(open) {
  $('controls').hidden = !open;
  $('ctlBtn').setAttribute('aria-expanded', String(open));
  $('ctlBtn').textContent = open ? 'Hide ▴' : 'Show ▾';
  if (open) renderControls();
}
function closeConfirm() { clearTimeout(confirmTimer); pendingConfirm = null; $('ctlConfirm').hidden = true; }
/** Two-step safety: describe the consequence and wait for an explicit Confirm (it lapses by itself after 10 s). */
function askConfirm(text, run, fromBtn) {
  clearTimeout(confirmTimer);
  pendingConfirm = run;
  $('ctlConfirmText').textContent = text;
  fromBtn.closest('.ctl').after($('ctlConfirm')); // right under the row that was tapped, so it is never off-screen
  $('ctlConfirm').hidden = false;
  $('ctlYes').focus();
  confirmTimer = setTimeout(closeConfirm, 10000);
}
function renderControls() {
  if ($('controls').hidden) return;
  const usable = isConnected() && !ctlBusy;
  if (!isConnected()) closeConfirm();
  const paused = state.inv?.cfgPauseFlag;
  $('accNow').textContent = paused == null ? '—' : paused === 1 ? 'Paused' : 'Charging allowed';
  $('accBtn').textContent = paused === 1 ? 'Resume AC charging' : 'Pause AC charging';
  $('accBtn').disabled = !usable || paused == null;
  const ac = state.inv?.cfgAcEnabled;
  $('acNow').textContent = ac == null ? '—' : ac === 1 ? 'On' : 'Off';
  $('acBtn').textContent = ac === 1 ? 'Turn off…' : 'Turn on…';
  $('acBtn').disabled = !usable || ac == null;
  const acMax = acChargeMax(state.inv?.acChgRatedPower), dcNow = state.mppt?.cfgDcChgCurrent;
  for (const [kind, nowId, cur, unit] of [
    ['charge', 'chgNow', state.ems?.maxChargeSoc, '%'], ['discharge', 'dsgNow', state.ems?.minDsgSoc, '%'],
    ['acw', 'acwNow', state.inv?.cfgSlowChgWatts, ' W'], ['dca', 'dcaNow', dcNow == null ? null : dcNow / 1000, ' A']]) {
    $(nowId).textContent = cur == null ? '—' : `Currently ${cur}${unit}`;
    for (const { n, btn } of optBtns[kind]) { // the value the battery itself reports is outlined in green
      btn.setAttribute('aria-pressed', String(cur === n));
      btn.disabled = !usable || cur == null || (kind === 'acw' && n > acMax);
    }
  }
  const acw = state.inv?.cfgSlowChgWatts, volts = summarize(state).acInV >= 90 ? summarize(state).acInV : 120;
  $('acwRange').textContent = acMax < OPTIONS.acw.at(-1) ? `Power drawn from the AC input while charging (this unit allows up to ${acMax} W).` : 'Power drawn from the AC input while charging.';
  $('acwHint').textContent = acw > 0 ? `Now ≈ ${(acw / volts).toFixed(1)} A at ${Math.round(volts)} V.` : '';
}
/** Send one command, then wait for the battery's own report to show the change (or say that it did not). */
async function sendControl({ label, kind, want, cmd }) {
  if (!isConnected()) return ctlSay('Not connected.', 'err');
  ctlBusy = true; renderControls();
  try {
    await session.send(cmd);
    dlog(`control ${label}: sent dst=0x${h2(cmd.dst)} id=0x${h2(cmd.cmdId)} payload=${hex(cmd.payload)}`);
  } catch (e) {
    ctlBusy = false; renderControls();
    return ctlSay(`${label}: could not be sent (${e.message}).`, 'err');
  }
  ctlSay(`${label}: sent. Waiting for the battery to confirm…`);
  const deadline = Date.now() + T.ctlConfirmMs;
  const ok = await new Promise((resolve) => {
    const t = setInterval(() => {
      if (confirmed(kind, want, state)) { clearInterval(t); resolve(true); }
      else if (Date.now() > deadline || !isConnected()) { clearInterval(t); resolve(false); }
    }, 200);
  });
  ctlBusy = false;
  if (ok) { ctlSay(`${label}: confirmed by the battery.`, 'ok'); }
  else ctlSay(isConnected() ? `${label}: the battery did not confirm. It may have ignored the command; the values above show its actual state.` : `${label}: the connection was lost before the battery confirmed.`, 'err');
  renderControls();
}
/** One entry per numeric setting: how to read, validate and send it, and how it is worded. */
const SETTINGS = {
  charge: { cur: () => state.ems?.maxChargeSoc, check: (v) => validateLimit('charge', v), label: (n) => `Charge limit ${n}%`, cmd: cmdChargeLimit, unit: '%' },
  discharge: { cur: () => state.ems?.minDsgSoc, check: (v) => validateLimit('discharge', v), label: (n) => `Discharge limit ${n}%`, cmd: cmdDischargeLimit, unit: '%' },
  acw: { cur: () => state.inv?.cfgSlowChgWatts, check: (v) => validateAcChargePower(v, acChargeMax(state.inv?.acChgRatedPower)), label: (n) => `AC charging power ${n} W`, cmd: cmdAcChargePower, unit: ' W' },
  dca: { cur: () => (state.mppt?.cfgDcChgCurrent == null ? undefined : state.mppt.cfgDcChgCurrent / 1000), check: validateDcChargeCurrent, label: (n) => `DC charging current ${n} A`, cmd: (n) => cmdDcChargeCurrent(n, mpptDst), unit: ' A' },
};
/** An option button was tapped: tapping sends it (after a confirmation where the change could cut power or is unverified). */
function applySetting(kind, n, btn) {
  const s = SETTINGS[kind], err = s.check(String(n));
  if (err) return ctlSay(err, 'err');
  if (n === s.cur()) return ctlSay(`Already set to ${n}${s.unit}.`);
  const run = () => sendControl({ label: s.label(n), kind, want: n, cmd: s.cmd(n) });
  const soc = summarize(state).soc;
  if (kind === 'discharge' && dischargeLimitStopsOutput(n, soc)) askConfirm(`Current charge is ${soc.toFixed(1)}%, at or below the new ${n}% discharge limit. The battery output may stop immediately.`, run, btn);
  else if (kind === 'dca') askConfirm(`Set the DC charging current to ${n} A? Make sure the car socket and cable can carry it.`, run, btn);
  else run();
}
// build the option buttons once; renderControls() keeps their state (green outline = what the battery reports)
const OPT_IDS = { charge: 'chgOpts', discharge: 'dsgOpts', acw: 'acwOpts', dca: 'dcaOpts' };
const optBtns = {};
for (const [kind, id] of Object.entries(OPT_IDS)) {
  optBtns[kind] = OPTIONS[kind].map((n) => {
    const btn = el('button', 'opt');
    btn.type = 'button'; btn.textContent = SETTINGS[kind].unit === '%' ? `${n}%` : String(n); btn.dataset.val = String(n);
    btn.disabled = true; btn.setAttribute('aria-pressed', 'false');
    btn.onclick = () => applySetting(kind, n, btn);
    $(id).append(btn);
    return { n, btn };
  });
}
/** Single tap, no confirmation: it is reversible and meant for frequent use. The result is verified like every other change. */
const toggleAcCharging = () => {
  const enable = state.inv?.cfgPauseFlag === 1; // currently paused -> resume
  sendControl({ label: enable ? 'AC charging resumed' : 'AC charging paused', kind: 'accharge', want: enable, cmd: cmdAcCharging(enable) });
};
$('accBtn').onclick = toggleAcCharging;
$('resumeBtn').onclick = toggleAcCharging;
$('ctlBtn').onclick = () => setControls($('controls').hidden);
$('acBtn').onclick = () => {
  const want = state.inv?.cfgAcEnabled !== 1;
  askConfirm(want ? 'Turn AC output ON? The AC outlets will become live.' : 'Turn AC output OFF? Anything plugged into the AC outlets will lose power.',
    () => sendControl({ label: `AC output ${want ? 'on' : 'off'}`, kind: 'ac', want, cmd: cmdAcOutput(want) }), $('acBtn'));
};
$('ctlYes').onclick = () => { const run = pendingConfirm; closeConfirm(); run?.(); };
$('ctlNo').onclick = () => { closeConfirm(); ctlSay('Cancelled.'); };

// ---------- keep screen on ----------
let wakeLock = null;
const wakeWanted = () => want && $('keepawake').checked;
async function syncWakeLock() {
  try {
    if (wakeWanted() && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      dlog('screen wake lock acquired');
    } else if (!wakeWanted() && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch (e) { dlog(`wake lock: ${e.message}`, 'err'); }
}

// ---------- polling ----------
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!session?.authenticated || pollBusy) return; // skip a tick rather than queue up behind a slow write
    pollBusy = true;
    const [src, dst, cmdSet, cmdId] = POLL_MAP[pollIdx++ % POLL_MAP.length];
    try { await session.send({ src, dst, cmdSet, cmdId, payload: Uint8Array.of(0) }); } catch (e) { dlog(`poll error: ${e.message}`, 'err'); }
    finally { pollBusy = false; }
  }, 350);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

// ---------- connection supervisor: connect, auto-reconnect, stall watchdog ----------
function uiIdle() {
  $('wake').disabled = true;
  syncButton();
}

function startWatchdog() {
  stopWatchdog();
  watchdog = setInterval(() => {
    if (!want || establishing || !session?.authenticated || Date.now() - lastRx < T.stallMs) return;
    say(`No data for ${Math.round(T.stallMs / 1000)} s`, 'err');
    link.disconnect(); // intentional: we schedule the reconnect ourselves
    scheduleReconnect('data stalled');
  }, Math.max(500, Math.min(3000, T.stallMs / 2)));
}
function stopWatchdog() { clearInterval(watchdog); watchdog = null; }

/** One connection attempt: GATT connect, handshake, authenticate, start polling. Throws on failure. */
async function establish() {
  if (establishing) return;
  establishing = true;
  try {
    stopPolling(); stopWatchdog();
    setStatus(hadSession ? 'Reconnecting…' : 'Connecting…', 'warn');
    await link.connect();
    if (!want) { link.disconnect(); return; } // cancelled while connecting
    const s = new EfSession({
      write: (b) => link.write(b), ...ctx,
      packetVersion: parseInt($('pver').value, 10),
      authDst: parseInt($('authdst').value, 16),
    });
    session = s;
    link.onData = (b) => s.notify(b);
    s.addEventListener('log', (e) => dlog(e.detail));
    s.addEventListener('state', (e) => { dlog(`stage: ${e.detail}`); setStatus(e.detail === 'authenticated' ? 'Connected' : hadSession ? 'Reconnecting…' : 'Connecting…', e.detail === 'authenticated' ? 'ok' : 'warn'); });
    s.addEventListener('packet', (e) => onPacket(e.detail));
    s.addEventListener('badpacket', (e) => dlog(`bad packet: ${e.detail.error} ${hex(e.detail.raw)}`, 'err'));
    await s.start();
    if (!want) { link.disconnect(); return; }
    lastRx = Date.now();
    clearMsg(); log(hadSession ? 'Reconnected' : 'Connected');
    rememberBattery(); // may leave a short notice (e.g. "already saved as ...")
    signalShownAt = !hadSession && signal ? Date.now() : null; // the reading is only meaningful for a fresh connection, not an automatic reconnect
    if (advancedAutoOpened) { setAdvanced(false); advancedAutoOpened = false; } // setup done: keep the card compact
    hadSession = true; attempt = 0;
    $('wake').disabled = false;
    if ($('autopoll').checked) startPolling();
    startWatchdog();
  } finally { establishing = false; syncButton(); }
}

function handleEstablishError(e) {
  say(`ERROR: ${e.message}`, 'err');
  link.disconnect();
  if (!want) return;
  if (restored && !hadSession && /No accessible GATT|No Services matching|NotAllowed|not allowed|SecurityError/i.test(e.message)) {
    // the browser no longer lets us use the remembered device: drop that permission so the next tap shows the chooser
    const b = batteries.get(ctx?.serial), old = b?.deviceId;
    if (b) { batteries.clearDeviceId(b.serial); if (old) { link.drop(old); BleLink.forget(old); } }
    const name = b ? displayName(b) : 'that battery';
    stopAll(); setStatus('Not connected');
    say(`Chrome no longer allows access to ${name}. Tap its name again to choose it.`, 'err');
    return;
  }
  if (/authentication failed/.test(e.message)) { // retrying cannot fix a wrong user ID / unbound device
    want = false; stopAll(); setStatus('Error', 'bad'); return;
  }
  scheduleReconnect(e.message);
}

function scheduleReconnect(reason, delay = Math.min(30000, T.retryMs * 2 ** Math.min(attempt, 4))) {
  if (!want || reconnectTimer) return;
  stopPolling(); stopWatchdog(); session = null; signalShownAt = null;
  attempt++;
  setStatus(delay ? `Reconnecting in ${Math.ceil(delay / 1000)} s` : 'Reconnecting…', 'warn');
  if (delay) say(`${reason}. Reconnecting in ${Math.ceil(delay / 1000)} s (attempt ${attempt})`, 'dim');
  const run = async () => {
    reconnectTimer = null;
    if (!want) return;
    if (establishing) { reconnectTimer = setTimeout(run, 1000); return; }
    try { await establish(); } catch (e) { handleEstablishError(e); }
  };
  reconnectTimer = setTimeout(run, delay);
}

function stopAll() {
  signal = null; signalShownAt = null;
  want = false; hadSession = false; attempt = 0;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  stopPolling(); stopWatchdog();
  link?.disconnect();
  session = null;
  syncWakeLock();
  uiIdle();
}

function attachLink() {
  link = new BleLink();
  link.addEventListener('log', (e) => dlog(e.detail));
  link.addEventListener('rx', (e) => $('rawlog').checked && dlog(`rx raw ${e.detail.length}B ${hex(e.detail)}`, 'dim'));
  link.addEventListener('tx', (e) => $('rawlog').checked && dlog(`tx raw ${e.detail.length}B`, 'dim'));
  link.addEventListener('disconnected', (e) => {
    if (e.detail?.intentional || !want) return;
    scheduleReconnect('Connection lost');
  });
}

/**
 * Connect to a saved battery, or (battery = null) add a new one through the chooser.
 * Identity is the serial read from the battery's advertisement; a battery is saved only after it authenticates.
 */
async function startConnect(battery = null) {
  const userId = $('userId').value.trim();
  if (!/^\d+$/.test(userId)) { // the user ID lives under Advanced: open it and point at the field
    setAdvanced(true); advancedAutoOpened = true; $('userId').focus();
    return say('Enter your numeric EcoFlow user ID under Advanced first.', 'err');
  }
  store.set('userId', userId);
  store.set('extra', $('extra').value);
  if (want) { stopAll(); } // only one connection at a time: close the current battery first
  requestedSerial = battery?.serial ?? null;
  picking = true; syncButton();
  seen.clear(); renderSeen(); state = { bms: {} }; render();
  signal = null; signalShownAt = null;
  try {
    if (link) { link.disconnect(); } else attachLink();
    let dev = null;
    if (battery) { setStatus('Connecting…', 'warn'); dev = await link.restore(battery.deviceId); } // no chooser if the browser still allows it
    restored = !!dev;
    if (!dev) { setStatus('Choose device…'); dev = await link.pick($('extra').value.split(/[\s,]+/).filter(Boolean)); }
    picking = false;
    dlog(`${restored ? 'using saved device' : 'picked'} ${dev.name} (${dev.id.slice(0, 8)}…)`);

    let serial = $('serial').value.trim().toUpperCase(); // optional manual override (Advanced); never filled in automatically
    try {
      setStatus('Connecting…', 'warn');
      const adv = await link.readAdvertisement();
      dlog(`advertisement: serial=${adv.serial} proto=${adv.protoVersion} product=0x${h2(adv.productType)} status=0x${h2(adv.status)} caps=0b${adv.capabilityFlags.toString(2)} encryptType=${adv.encryptType} rssi=${adv.rssi}`);
      signal = { rssi: adv.rssi };
      if (!serial) serial = adv.serial;
      if (adv.encryptType !== 7) say(`Device reports encrypt type ${adv.encryptType}; only type 7 is implemented`, 'err');
    } catch (e) {
      dlog(`could not read advertisement: ${e.message}`, 'err');
    }
    if (!serial && battery && dev.id === battery.deviceId) serial = battery.serial; // advertisement not heard: reuse the saved serial
    if (!/^[A-Z0-9]{10,20}$/.test(serial)) throw new Error(`Serial number looks invalid ("${serial}"): enter it under Advanced`);

    ctx = { userId, serial };
    want = true; attempt = 0; hadSession = false;
    syncButton();
    syncWakeLock();
    await establish();
  } catch (e) {
    picking = false;
    if (e.name === 'NotFoundError') { say('Device selection cancelled'); stopAll(); setStatus('Not connected'); return; }
    if (want) return handleEstablishError(e);
    say(`ERROR: ${e.message}`, 'err');
    setStatus('Error', 'bad');
    uiIdle();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { saveHistory(); return; }
  syncWakeLock(); // the browser drops the lock when the page is hidden
  if (want && !establishing && !session?.authenticated) { // came back to a dead link: retry right away
    clearTimeout(reconnectTimer); reconnectTimer = null; attempt = 0;
    scheduleReconnect('Page visible again', 0);
  }
});

// ---------- install as an app ----------
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('install').hidden = false; });
addEventListener('appinstalled', () => { $('install').hidden = true; installEvent = null; });
$('install').onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null; $('install').hidden = true;
};
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch((e) => dlog(`service worker: ${e.message}`, 'err'));
}

// ---------- wiring ----------
$('addBtn').onclick = () => startConnect(null);
$('advBtn').onclick = () => { advancedAutoOpened = false; setAdvanced($('advanced').hidden); };
$('stop').onclick = () => { stopAll(); setStatus('Disconnected'); clearMsg(); log('Disconnected'); };
$('helpBtn').onclick = () => { const open = $('help').hidden; $('help').hidden = !open; $('helpBtn').setAttribute('aria-expanded', String(open)); };
$('wake').onclick = () => session?.send({ dst: 0x03, cmdSet: 0x32, cmdId: 0x05, payload: Uint8Array.of(1) })
  .then(() => dlog('sent wake-up (0x32/0x05)')).catch((e) => say(`wake error: ${e.message}`, 'err'));
$('clear').onclick = () => { $('log').textContent = ''; };
$('copy').onclick = async () => { await navigator.clipboard.writeText(capture.join('\n')); log('log copied to clipboard'); };
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([capture.join('\n')], { type: 'text/plain' }));
  a.download = `ef-capture-${Date.now()}.txt`;
  a.click();
};
$('lookupBtn').onclick = async () => {
  const msg = $('lmsg'), btn = $('lookupBtn');
  btn.disabled = true; msg.textContent = 'contacting EcoFlow…';
  try {
    const id = await fetchUserId($('lemail').value.trim(), $('lpw').value);
    $('userId').value = id; store.set('userId', id);
    msg.textContent = 'Done: user ID filled in above.';
  } catch (e) { msg.textContent = e.message; }
  finally { $('lpw').value = ''; btn.disabled = false; }
};
$('autopoll').onchange = () => { if ($('autopoll').checked) { if (session?.authenticated) startPolling(); } else stopPolling(); };
$('debug').onchange = () => { debug = $('debug').checked; store.set('debug', debug ? '1' : '0'); applyDebug(); if (debug) { render(); renderSeen(); } };
$('keepawake').checked = store.get('keepawake', '1') === '1';
$('keepawake').onchange = () => { store.set('keepawake', $('keepawake').checked ? '1' : '0'); syncWakeLock(); };

$('userId').value = store.get('userId');
$('extra').value = store.get('extra');
if (!$('userId').value) { setAdvanced(true); advancedAutoOpened = true; } // first run: the user ID is the one thing that is needed
if (!BleLink.supported) {
  $('unsupported').hidden = false;
}
renderBatteryManager();
syncButton();
applyDebug();
renderSeen();
render();
updateCharts();
