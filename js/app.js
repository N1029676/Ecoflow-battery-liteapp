// Spike UI: connect, authenticate, dump decrypted packets. No decoding yet.
import { BleLink } from './ble.js';
import { EfSession } from './session.js';
import { hex } from './protocol.js';
import { fetchUserId } from './login.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('ef.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('ef.' + k, v); } catch {} },
};

// Delta Pro heartbeat requests, from the ha-ef-ble Delta Pro driver: [src, dst, cmdSet, cmdId]
const POLL_MAP = [[0x21, 0x02, 0x20, 0x02], [0x21, 0x05, 0x20, 0x02], [0x21, 0x04, 0x20, 0x02],
  [0x21, 0x03, 0x20, 0x02], [0x21, 0x03, 0x20, 0x32]];

let link = null, session = null, pollTimer = null, pollIdx = 0;
const capture = []; // everything, for the downloadable log
const seen = new Map(); // "src dst set id" -> {count, last, len, t}

function log(msg, cls = '') {
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

function setStatus(s, cls = '') { const e = $('status'); e.textContent = s; e.className = 'pill ' + cls; }
const h2 = (n) => n.toString(16).padStart(2, '0');

function renderSeen() {
  const rows = [...seen.entries()].sort().map(([k, v]) =>
    `<tr><td>${k}</td><td>${v.count}</td><td>${v.len}</td><td class="mono">${v.last.slice(0, 120)}${v.last.length > 120 ? '…' : ''}</td></tr>`);
  $('seen').innerHTML = rows.join('') || '<tr><td colspan="4">nothing yet</td></tr>';
}

function onPacket(p) {
  const key = `src ${h2(p.src)} → dst ${h2(p.dst)}  set ${h2(p.cmdSet)} id ${h2(p.cmdId)}`;
  const e = seen.get(key) ?? { count: 0 };
  seen.set(key, { count: e.count + 1, last: hex(p.payload), len: p.payload.length });
  if (p.cmdSet !== 0x20 || e.count < 3) log(`rx ${key} v${p.version.toString(16)} payload[${p.payload.length}]=${hex(p.payload)}`);
  if (!renderSeen.pending) { renderSeen.pending = true; setTimeout(() => { renderSeen.pending = false; renderSeen(); }, 250); }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!session?.authenticated) return;
    const [src, dst, cmdSet, cmdId] = POLL_MAP[pollIdx++ % POLL_MAP.length];
    try { await session.send({ src, dst, cmdSet, cmdId, payload: Uint8Array.of(0) }); } catch (e) { log(`poll error: ${e.message}`, 'err'); }
  }, 350);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

function cleanup() {
  stopPolling();
  link?.disconnect();
  $('connect').disabled = false;
  $('disconnect').disabled = true;
  $('wake').disabled = true;
}

async function connect() {
  const userId = $('userId').value.trim();
  if (!/^\d+$/.test(userId)) return log('User ID should be the numeric EcoFlow user ID', 'err');
  store.set('userId', userId);
  store.set('extra', $('extra').value);
  $('connect').disabled = true;
  seen.clear(); renderSeen();
  try {
    link = new BleLink();
    link.addEventListener('log', (e) => log(e.detail));
    link.addEventListener('rx', (e) => log(`rx raw ${e.detail.length}B ${hex(e.detail)}`, 'dim'));
    link.addEventListener('tx', (e) => log(`tx raw ${e.detail.length}B`, 'dim'));
    link.addEventListener('disconnected', () => { setStatus('disconnected'); cleanup(); });

    const extra = $('extra').value.split(/[\s,]+/).filter(Boolean);
    setStatus('choose device…');
    const dev = await link.pick(extra);
    log(`picked ${dev.name} (${dev.id.slice(0, 8)}…)`);

    let serial = $('serial').value.trim().toUpperCase();
    try {
      setStatus('reading advertisement…');
      const adv = await link.readAdvertisement();
      log(`advertisement: serial=${adv.serial} proto=${adv.protoVersion} product=0x${h2(adv.productType)} status=0x${h2(adv.status)} caps=0b${adv.capabilityFlags.toString(2)} encryptType=${adv.encryptType} rssi=${adv.rssi}`);
      $('adv').textContent = `serial ${adv.serial} · encrypt type ${adv.encryptType} · product 0x${h2(adv.productType)}`;
      if (!serial) serial = adv.serial;
      if (adv.encryptType !== 7) log(`WARNING: device reports encrypt type ${adv.encryptType}; only type 7 is implemented`, 'err');
    } catch (e) {
      log(`could not read advertisement: ${e.message}`, 'err');
    }
    if (!/^[A-Z0-9]{10,20}$/.test(serial)) throw new Error(`Serial number looks invalid ("${serial}"): enter it manually`);
    $('serial').value = serial;

    setStatus('connecting…');
    await link.connect();

    session = new EfSession({
      write: (b) => link.write(b),
      userId, serial,
      packetVersion: parseInt($('pver').value, 10),
      authDst: parseInt($('authdst').value, 16),
    });
    link.onData = (b) => session.notify(b);
    session.addEventListener('log', (e) => log(e.detail));
    session.addEventListener('state', (e) => setStatus(e.detail, e.detail === 'authenticated' ? 'ok' : ''));
    session.addEventListener('packet', (e) => onPacket(e.detail));
    session.addEventListener('badpacket', (e) => log(`bad packet: ${e.detail.error} ${hex(e.detail.raw)}`, 'err'));

    $('disconnect').disabled = false;
    await session.start();
    $('wake').disabled = false;
    if ($('autopoll').checked) startPolling();
  } catch (e) {
    if (e.name === 'NotFoundError') log('device selection cancelled');
    else log(`ERROR: ${e.message}`, 'err');
    setStatus('error', 'bad');
    cleanup();
  }
}

$('connect').onclick = connect;
$('disconnect').onclick = () => { cleanup(); setStatus('disconnected'); };
$('wake').onclick = () => session?.send({ dst: 0x03, cmdSet: 0x32, cmdId: 0x05, payload: Uint8Array.of(1) })
  .then(() => log('sent wake-up (0x32/0x05)')).catch((e) => log(`wake error: ${e.message}`, 'err'));
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

$('userId').value = store.get('userId');
$('extra').value = store.get('extra');
if (!BleLink.supported) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}
renderSeen();
