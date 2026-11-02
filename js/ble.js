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
    this._handler = (ev) => {
      const v = ev.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      this.dispatchEvent(new CustomEvent('rx', { detail: bytes }));
      this.onData?.(bytes);
    };
  }

  _log(m) { this.dispatchEvent(new CustomEvent('log', { detail: m })); }

  static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  /** Shows Chrome's device chooser. */
  async pick(extraServices = []) {
    const optionalServices = [...new Set([...SERVICE_CANDIDATES, ...extraServices].map((s) => s.toLowerCase()))];
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'EF-' }, { manufacturerData: [{ companyIdentifier: EF_COMPANY_ID }] }],
      optionalServices,
      optionalManufacturerData: [EF_COMPANY_ID],
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this._log('GATT disconnected');
      this.dispatchEvent(new Event('disconnected'));
    });
    return this.device;
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
    await this.notifyChar.startNotifications();
    await sleep(100);
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

  disconnect() {
    try { this.notifyChar?.removeEventListener('characteristicvaluechanged', this._handler); } catch {}
    try { this.device?.gatt?.disconnect(); } catch {}
  }
}
