// EcoFlow Delta Pro monitor UI: connect, authenticate, live dashboard, history charts.
import { BleLink } from './ble.js';
import { EfSession } from './session.js';
import { hex } from './protocol.js';
import { fetchUserId } from './login.js';
import { decodeTelemetry, summarize } from './decode.js';
import { History, toCsv } from './history.js';
import { LineChart, fullTime } from './chart.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('ef.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('ef.' + k, v); } catch {} },
};

// Tunables (URL params exist so the end-to-end tests can run fast: ?fine=1000&stall=3000&retry=200&save=500)
const q = new URLSearchParams(location.search);
const T = {
  fineMs: +q.get('fine') || 15000,     // history sample interval
  saveMs: +q.get('save') || 60000,     // how often history is written to localStorage
  stallMs: +q.get('stall') || 20000,   // no packets for this long => reconnect
  retryMs: +q.get('retry') || 2000,    // reconnect backoff base (doubles up to x16, max 30 s)
};

// Delta Pro heartbeat requests, from the ha-ef-ble Delta Pro driver: [src, dst, cmdSet, cmdId]
const POLL_MAP = [[0x21, 0x02, 0x20, 0x02], [0x21, 0x05, 0x20, 0x02], [0x21, 0x04, 0x20, 0x02],
  [0x21, 0x03, 0x20, 0x02], [0x21, 0x03, 0x20, 0x32]];

let link = null, session = null, ctx = null; // ctx = { userId, serial } once a device has been picked
let pollTimer = null, pollIdx = 0, pollBusy = false;
let want = false, establishing = false, attempt = 0, reconnectTimer = null, watchdog = null, lastRx = 0, hadSession = false;
let state = { bms: {} }; // latest decoded message of each kind
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
/** A message the user should see even with debug off. */
function say(msg, cls = '') { const e = $('msg'); e.textContent = msg; e.className = cls; log(msg, cls); }

function setStatus(s, cls = '') { const e = $('status'); e.textContent = s; e.className = 'pill ' + cls; }
const h2 = (n) => n.toString(16).padStart(2, '0');

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
  const t = decodeTelemetry(p);
  if (t) {
    if (t.kind === 'bms') state.bms[t.data.num] = t.data; else state[t.kind] = t.data;
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
const hm = (min) => (min == null || min <= 0 || min > 5999 ? '—' : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`);
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; setTimeout(() => { renderQueued = false; render(); }, 250); } }
function set(id, text) { $(id).textContent = text; }
function render() {
  const m = summarize(state);
  set('d-soc', fmt(m.soc, 1, '%'));
  set('d-soc-sub', m.soc == null ? '' : `charge limit ${fmt(m.chargeLimitMax, 0, '%')} · discharge limit ${fmt(m.dischargeLimitMin, 0, '%')}`);
  set('d-in', fmt(m.inW, 0, ' W'));
  set('d-in-sub', `AC ${fmt(m.acInW, 0, ' W')} · solar/DC ${fmt(m.solarW, 0, ' W')}`);
  set('d-out', fmt(m.outW, 0, ' W'));
  set('d-out-sub', `AC ${fmt(m.acOutW, 0, ' W')} · 12V ${fmt(m.carW, 0, ' W')} · USB ${fmt(m.usbA, 0, ' W')} · USB-C ${fmt(m.usbC, 0, ' W')}`);
  set('d-ac', m.acInV == null ? '—' : `${fmt(m.acInV, 1, ' V')} · ${fmt(m.acInA, 2, ' A')}`);
  set('d-ac-sub', m.acOutEnabled == null ? '' : `AC output: ${m.acOutEnabled ? 'on' : 'off'}`);
  set('d-time', `${hm(m.chargeMinutes)} to full · ${hm(m.dischargeMinutes)} to empty`);
  const box = $('d-batts');
  box.replaceChildren(...m.batteries.map((b) => {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = '<b></b><div class="big"></div><small></small>';
    d.firstChild.textContent = b.num === 0 ? 'Main battery' : `Extra battery ${b.num}`;
    d.children[1].textContent = fmt(b.soc, 1, '%');
    d.lastChild.textContent = `${fmt(b.volts, 2, ' V')} · ${fmt(b.amps, 2, ' A')} · ${fmt(b.tempC, 0, ' °C')} · ${fmt(b.remainAh, 1)}/${fmt(b.designAh, 0, ' Ah')} · ${b.cycles} cycles · health ${b.sohPct}% · cells ${b.cellMinMv}–${b.cellMaxMv} mV`;
    return d;
  }));
  if (debug) $('d-json').textContent = JSON.stringify(state, (k, v) => (v instanceof Uint8Array ? hex(v) : v), 1);
}

// ---------- history + charts ----------
function loadHistory() {
  try { return History.fromJSON(JSON.parse(store.get('history', 'null')), { fineMs: T.fineMs }); } catch { return new History({ fineMs: T.fineMs }); }
}
const hist = loadHistory();
function saveHistory() {
  try { localStorage.setItem('ef.history', JSON.stringify(hist)); } catch (e) { dlog(`could not save history: ${e.message}`, 'err'); }
}

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '14d': 14 * 86400e3 };
let range = RANGES[store.get('range')] ? store.get('range') : '6h';
const charts = [
  new LineChart($('c-soc'), { title: 'Battery charge', series: [{ key: 'soc', label: 'Charge', color: '--series-1' }], unit: '%', decimals: 1, yMin: 0, yMax: 100 }),
  new LineChart($('c-power'), { title: 'Power', series: [{ key: 'inW', label: 'In', color: '--series-1' }, { key: 'outW', label: 'Out', color: '--series-2' }], unit: ' W', yMin: 0, minSpan: 100 }),
  new LineChart($('c-temp'), { title: 'Battery temperature (hottest pack)', series: [{ key: 'tempC', label: 'Temp', color: '--series-1' }], unit: ' °C', minSpan: 10 }),
];
let chartsQueued = false;
function scheduleCharts() { if (!chartsQueued) { chartsQueued = true; setTimeout(() => { chartsQueued = false; updateCharts(); }, 300); } }
let lastQuery = null;
function updateCharts() {
  lastQuery = hist.query(RANGES[range]);
  const { points, from, to, stepMs } = lastQuery;
  for (const c of charts) c.setData({ points, from, to, stepMs });
  for (const b of $('ranges').children) b.setAttribute('aria-pressed', String(b.dataset.range === range));
  set('h-count', points.length ? `${points.length} readings` : 'no readings in this range');
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
  const temps = m.batteries.map((b) => b.tempC).filter((v) => v != null);
  if (hist.add(Date.now(), { soc: m.soc, inW: m.inW, outW: m.outW, tempC: temps.length ? Math.max(...temps) : null })) scheduleCharts();
}
setInterval(sampleHistory, 1000);
setInterval(saveHistory, T.saveMs);
setInterval(updateCharts, 30000); // slide the time window
addEventListener('pagehide', saveHistory);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => charts.forEach((c) => c.draw()));

$('ranges').onclick = (e) => { const r = e.target.dataset?.range; if (r) { range = r; store.set('range', r); updateCharts(); } };
$('tableView').addEventListener('toggle', () => { if ($('tableView').open && lastQuery) renderTable(lastQuery.points); });
$('exportCsv').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(hist.query(RANGES[range]).points)], { type: 'text/csv' }));
  a.download = `ecoflow-history-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};
$('clearHist').onclick = () => { if (confirm('Delete all recorded history on this device?')) { hist.clear(); saveHistory(); updateCharts(); } };

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
  $('connect').disabled = false;
  $('disconnect').disabled = true;
  $('wake').disabled = true;
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
    setStatus(attempt ? `reconnecting (try ${attempt})…` : 'connecting…', 'warn');
    await link.connect();
    const s = new EfSession({
      write: (b) => link.write(b), ...ctx,
      packetVersion: parseInt($('pver').value, 10),
      authDst: parseInt($('authdst').value, 16),
    });
    session = s;
    link.onData = (b) => s.notify(b);
    s.addEventListener('log', (e) => dlog(e.detail));
    s.addEventListener('state', (e) => setStatus(e.detail, e.detail === 'authenticated' ? 'ok' : 'warn'));
    s.addEventListener('packet', (e) => onPacket(e.detail));
    s.addEventListener('badpacket', (e) => dlog(`bad packet: ${e.detail.error} ${hex(e.detail.raw)}`, 'err'));
    await s.start();
    lastRx = Date.now();
    say(hadSession ? 'Reconnected' : 'Connected');
    hadSession = true; attempt = 0;
    $('wake').disabled = false;
    if ($('autopoll').checked) startPolling();
    startWatchdog();
  } finally { establishing = false; }
}

function handleEstablishError(e) {
  say(`ERROR: ${e.message}`, 'err');
  link.disconnect();
  if (!want) return;
  if (/authentication failed/.test(e.message)) { // retrying cannot fix a wrong user ID / unbound device
    want = false; stopAll(); setStatus('error', 'bad'); return;
  }
  scheduleReconnect(e.message);
}

function scheduleReconnect(reason, delay = Math.min(30000, T.retryMs * 2 ** Math.min(attempt, 4))) {
  if (!want || reconnectTimer) return;
  stopPolling(); stopWatchdog(); session = null;
  attempt++;
  setStatus(delay ? `reconnecting in ${Math.ceil(delay / 1000)} s` : 'reconnecting…', 'warn');
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

async function onConnect() {
  const userId = $('userId').value.trim();
  if (!/^\d+$/.test(userId)) return say('User ID should be the numeric EcoFlow user ID', 'err');
  store.set('userId', userId);
  store.set('extra', $('extra').value);
  $('connect').disabled = true;
  seen.clear(); renderSeen(); state = { bms: {} }; render();
  try {
    if (link) { link.disconnect(); } else attachLink();
    setStatus('choose device…');
    const dev = await link.pick($('extra').value.split(/[\s,]+/).filter(Boolean));
    dlog(`picked ${dev.name} (${dev.id.slice(0, 8)}…)`);

    let serial = $('serial').value.trim().toUpperCase();
    try {
      setStatus('reading advertisement…');
      const adv = await link.readAdvertisement();
      dlog(`advertisement: serial=${adv.serial} proto=${adv.protoVersion} product=0x${h2(adv.productType)} status=0x${h2(adv.status)} caps=0b${adv.capabilityFlags.toString(2)} encryptType=${adv.encryptType} rssi=${adv.rssi}`);
      $('adv').textContent = `serial ${adv.serial} · encrypt type ${adv.encryptType} · signal ${adv.rssi} dBm`;
      if (!serial) serial = adv.serial;
      if (adv.encryptType !== 7) say(`Device reports encrypt type ${adv.encryptType}; only type 7 is implemented`, 'err');
    } catch (e) {
      dlog(`could not read advertisement: ${e.message}`, 'err');
    }
    if (!/^[A-Z0-9]{10,20}$/.test(serial)) throw new Error(`Serial number looks invalid ("${serial}"): enter it under Advanced`);
    $('serial').value = serial;

    ctx = { userId, serial };
    want = true; attempt = 0; hadSession = false;
    $('disconnect').disabled = false;
    syncWakeLock();
    await establish();
  } catch (e) {
    if (e.name === 'NotFoundError') { say('Device selection cancelled'); stopAll(); setStatus('idle'); return; }
    if (want) return handleEstablishError(e);
    say(`ERROR: ${e.message}`, 'err');
    setStatus('error', 'bad');
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
$('connect').onclick = onConnect;
$('disconnect').onclick = () => { stopAll(); setStatus('disconnected'); say('Disconnected'); };
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
if (!BleLink.supported) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}
applyDebug();
renderSeen();
render();
updateCharts();
