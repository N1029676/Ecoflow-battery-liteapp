// Web Bluetooth transport for EfSession. Chrome/Edge (desktop + Android), HTTPS or localhost.
import { EF_COMPANY_ID, parseAdvertisement } from './protocol.js';

// The device's primary service UUID is not documented anywhere I could find, and Web Bluetooth
// can only touch services declared up front. So declare every plausible candidate; after
// connecting we list what was actually found. Add more via the UI's "extra service UUIDs".
export const SERVICE_CANDIDATES = [
  '00000001-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb', // advertised by Delta 3 per Flangvik/EcoFlowUPS
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
];

// Characteristic pairs {notify, write}, tried in order (same as upstream).
export const PROFILES = {
  rfcomm: { notify: '00000003-0000-1000-8000-00805f9b34fb', write: '00000002-0000-1000-8000-00805f9b34fb' },
  nordic_uart: { notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const props = (c) => ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => c.properties[k]).join(',');

export class BleLink extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.profile = null;
    this.onData = null; // (Uint8Array) => void
    this._q = Promise.resolve(); // GATT allows one operation at a time
    this._intentional = false; // true while WE are closing the link (so the app doesn't auto-reconnect)
    this._listened = new WeakSet(); // devices we already hooked 'gattserverdisconnected' on
    this.known = new Map(); // id -> device handed to us earlier in this page visit (reusable without the chooser)
    this._handler = (ev) => {
      const v = ev.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      this.dispatchEvent(new CustomEvent('rx', { detail: bytes }));
      this.onData?.(bytes);
    };
  }

  _log(m) { this.dispatchEvent(new CustomEvent('log', { detail: m })); }

  static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  /** True if this browser can hand back devices the user already granted (so no chooser is needed again). */
  static get canRemember() { return typeof navigator !== 'undefined' && typeof navigator.bluetooth?.getDevices === 'function'; }

  /** Use a device: remember it on this link and watch for unexpected disconnects (once per device object). */
  useDevice(device) {
    this.device = device;
    this.known.set(device.id, device);
    if (!this._listened.has(device)) {
      this._listened.add(device);
      device.addEventListener('gattserverdisconnected', () => {
        this._log('GATT disconnected');
        this.dispatchEvent(new CustomEvent('disconnected', { detail: { intentional: this._intentional } }));
      });
    }
    return device;
  }

  /** Previously granted device with this id, or null (not granted any more / unsupported). No chooser is shown. */
  async restore(id) {
    if (!id) return null;
    if (this.known.has(id)) return this.useDevice(this.known.get(id)); // already granted during this visit: works even without getDevices()
    if (!BleLink.canRemember) return null;
    try {
      const d = (await navigator.bluetooth.getDevices()).find((x) => x.id === id);
      return d ? this.useDevice(d) : null;
    } catch (e) { this._log(`getDevices: ${e.message}`); return null; }
  }

  /** Drop a device from this visit's cache (after forgetting it). */
  drop(id) { this.known.delete(id); }

  /** Revoke the browser's permission for a device, so the chooser is needed again. Best effort. */
  static async forget(id) {
    try { await (await navigator.bluetooth.getDevices()).find((x) => x.id === id)?.forget?.(); } catch { /* unsupported */ }
  }

  /** Shows Chrome's device chooser. */
  async pick(extraServices = []) {
    const optionalServices = [...new Set([...SERVICE_CANDIDATES, ...extraServices].map((s) => s.toLowerCase()))];
    return this.useDevice(await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'EF-' }, { manufacturerData: [{ companyIdentifier: EF_COMPANY_ID }] }],
      optionalServices,
      optionalManufacturerData: [EF_COMPANY_ID],
    }));
  }

  /** Reads the manufacturer data from the advertisement (serial number, encrypt type, ...). */
  async readAdvertisement(timeoutMs = 8000) {
    if (!this.device?.watchAdvertisements) throw new Error('watchAdvertisements() not available in this browser');
    const ac = new AbortController();
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => { ac.abort(); reject(new Error('no advertisement received')); }, timeoutMs);
      this.device.addEventListener('advertisementreceived', (ev) => {
        const dv = ev.manufacturerData?.get(EF_COMPANY_ID);
        if (!dv) return;
        clearTimeout(t); ac.abort();
        const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        resolve({ raw: bytes.slice(), rssi: ev.rssi, ...parseAdvertisement(bytes) });
      }, { signal: ac.signal });
    });
    await this.device.watchAdvertisements({ signal: ac.signal });
    return done;
  }

  async connect() {
    if (!this.device) throw new Error('pick a device first');
    this._detach();
    this._intentional = false;
    this._q = Promise.resolve(); // a write stuck on a dead link must not block the new one
    this._log('connecting GATT…');
    let server;
    for (let attempt = 1; ; attempt++) { // weak signal (-90 dBm or worse) often needs a retry
      try { server = await this.device.gatt.connect(); break; } catch (e) {
        if (attempt >= 3) throw e;
        this._log(`connect attempt ${attempt} failed (${e.message}); retrying…`);
        await sleep(1000);
      }
    }
    let services = [];
    try { services = await server.getPrimaryServices(); } catch (e) { this._log(`getPrimaryServices: ${e.message}`); }
    if (!services.length) {
      throw new Error('No accessible GATT service. The device\'s service UUID is not among the declared candidates; ' +
        'add it under "extra service UUIDs" (look it up with nRF Connect) and pick the device again.');
    }
    let found = null;
    for (const s of services) {
      const chars = await s.getCharacteristics();
      this._log(`service ${s.uuid}: ` + chars.map((c) => `${c.uuid}[${props(c)}]`).join(' '));
      for (const [name, p] of Object.entries(PROFILES)) {
        const n = chars.find((c) => c.uuid === p.notify), w = chars.find((c) => c.uuid === p.write);
        if (n && w && !found) found = { name, n, w };
      }
    }
    if (!found) throw new Error('Services found, but none has the expected notify/write characteristics (see log above).');
    this.profile = found.name;
    this.notifyChar = found.n;
    this.writeChar = found.w;
    this._log(`using profile ${found.name}`);
    this.notifyChar.addEventListener('characteristicvaluechanged', this._handler);
    await this._startNotifications();
    await sleep(100);
  }

  /**
   * Turning notifications on is the step that fails on a weak or half-open link: Android reports "GATT operation failed for
   * unknown reason" only after about 35 s. So an outright failure is retried here (the link itself is fine), and a hang is cut
   * off after 12 s so the supervisor can start over quickly instead of waiting for the system's timeout.
   */
  async _startNotifications(tries = 3, timeoutMs = 12000) {
    for (let attempt = 1; ; attempt++) {
      try { await withTimeout(this.notifyChar.startNotifications(), timeoutMs, 'Turning on notifications'); return; } catch (e) {
        if (/timed out/.test(e.message)) { try { this.device?.gatt?.disconnect(); } catch {} throw e; } // a hung operation cannot be retried on the same link
        if (attempt >= tries) throw e;
        this._log(`startNotifications attempt ${attempt} failed (${e.message}); retrying…`);
        await sleep(500);
      }
    }
  }

  /** Writes are queued: overlapping GATT operations fail with "already in progress". */
  write(bytes) {
    const run = async () => {
      this.dispatchEvent(new CustomEvent('tx', { detail: bytes }));
      if (this.writeChar.writeValueWithResponse) await this.writeChar.writeValueWithResponse(bytes);
      else await this.writeChar.writeValue(bytes);
    };
    const p = this._q.then(run);
    this._q = p.catch(() => {});
    return p;
  }

  _detach() {
    try { this.notifyChar?.removeEventListener('characteristicvaluechanged', this._handler); } catch {}
  }

  /** Close the link on purpose (no auto-reconnect). */
  disconnect() {
    this._intentional = true;
    this._detach();
    try { this.device?.gatt?.disconnect(); } catch {}
  }
}
