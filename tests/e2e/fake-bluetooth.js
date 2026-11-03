// Test harness: installs a fake navigator.bluetooth whose device speaks the real protocol and replays
// captured Delta Pro payloads. Bundle with esbuild and inject before the app (see run-e2e.mjs).
import { generateKeypair } from '../../js/secp160r1.js';
import * as D from '../../js/decode.js';
import {
  Cipher, concat, handshakeCipher, genSessionKey, encodeFrame, FrameReader, encodePacket, decodePacket, authPayload,
  hex, unhex, FRAME_COMMAND, FRAME_PROTOCOL, EF_COMPANY_ID,
} from '../../js/protocol.js';

const USER = '1234';
const FIX = { // [src, cmdId] -> payload (real capture; no serials)
  '2:2': '02000000009c00020102000300006410038303a85d000000010000000000001617000000f0002c010a000000000d00000089e9000004030000bf4800004efe0000e0570000a8c30000312f0000688b150000000000200000000000000001010000000800008000000000000000000000ffff000f0500000000',
  '3:2': '0101014ed30000e8fd00000064025e0000703e0000a85d000001c93abc42030300020259c80000b1ca0000000064000122000000020301',
  '4:2': '000000009e0101020183030000000000000000000000001ecb0100e01d00003c2300d0070000000000002400010000c0d401000200000200008403a0050000000000000000000000',
  '5:2': '00000000320001030000000000000000000000020000020000000e001600030000000000000000000000000000000000000000000000000000160001007017000000',
  '3:50': '0001020600000023050101646ac70000000000001c028038010030380100303801000900000064ab0d350d1c1a19190080401f00000000c84200000000000000000000000000000076000f440d3a0d3e0d3e0d380d440dab0d400d430d350d3b0d570d3c0d530d380d041c001b001b001a0056302e302e300301ffff303030303030303030303030303030300e020000c84200000000cdccc7420d00010102004000800000000000ffffffffffffffff000000000000000000000000',
};
// An extra battery pack answers the same request as the main one (from src 6, pack number 1).
const withField = (hexs, layout, name, value) => {
  const bytes = unhex(hexs); let o = 0, f;
  for (const x of D[layout]) { if (x.name === name) { f = x; break; } o += x.n; }
  const dv = new DataView(bytes.buffer);
  ({ B: () => dv.setUint8(o, value), I: () => dv.setUint32(o, value >>> 0, true), f: () => dv.setFloat32(o, value, true) })[f.fmt]();
  return hex(bytes);
};
FIX['3:50'] = withField(FIX['3:50'], 'BMS', 'f32ShowSoc', 94.1); // main pack reading (the dashboard now shows packs, not an average)
FIX['6:50'] = withField(FIX['3:50'], 'BMS', 'num', 1);
const REQ = { '2:2': 2, '5:2': 5, '4:2': 4, '3:2': 3, '3:50': 3 }; // "dst:cmdId" -> response src

class Dev {
  constructor() { this.reset(); this.notify = () => {}; this.writes = 0; this.overlaps = 0; this.connects = 0; this.mute = false; this.serial = 'TESTX0000000001'; this.nextPick = 'A'; this.connectedIds = []; this.advertising = true; this.rssiStep = 0; }
  reset() { this.reader = new FrameReader(); this.cipher = null; this.busy = false; this.tx = Promise.resolve(); }
  // Notifications are sent one frame at a time (like a real radio); concurrent emits would interleave chunks.
  emit(frame) { return (this.tx = this.tx.then(() => this._emit(frame))); }
  async _emit(frame) { for (let i = 0; i < frame.length; i += 20) { this.notify(frame.slice(i, i + 20)); await new Promise((r) => setTimeout(r, 2)); } }
  async reply(src, cmdSet, cmdId, payload) {
    if (this.mute && cmdSet === 0x20) return; // simulate a device that stops sending telemetry
    const pkt = encodePacket({ src, dst: 0x21, cmdSet, cmdId, payload, version: 2 });
    await this.emit(await encodeFrame(FRAME_PROTOCOL, pkt, this.cipher));
  }
  async onWrite(bytes) {
    if (this.busy) { this.overlaps++; throw new DOMException('GATT operation already in progress.', 'NetworkError'); }
    this.busy = true;
    try {
      await new Promise((r) => setTimeout(r, 40)); // a write takes real time
      this.writes++;
      for (const f of this.reader.push(bytes)) {
        if (!this.cipher && f.payload[0] === 1) {
          const kp = generateKeypair(); this.hs = handshakeCipher(kp.d, f.payload.slice(2, 42));
          this.emit(await encodeFrame(FRAME_COMMAND, concat(Uint8Array.of(1, 0, 0), kp.pub)));
        } else if (!this.cipher && f.payload[0] === 2) {
          const srand = Uint8Array.from({ length: 16 }, (_, i) => i * 13 + 5), seed = Uint8Array.of(7, 9);
          const body = await this.hs.encrypt(concat(srand, seed));
          this.cipher = new Cipher(genSessionKey(seed, srand), this.hs.iv);
          this.emit(await encodeFrame(FRAME_COMMAND, concat(Uint8Array.of(2), body)));
        } else if (this.cipher) {
          const p = decodePacket(await this.cipher.decrypt(f.payload));
          if (p.cmdSet === 0x35 && p.cmdId === 0x89) this.reply(0x32, 0x35, 0x89, Uint8Array.of(1, 0));
          else if (p.cmdSet === 0x35 && p.cmdId === 0x86) {
            const ok = hex(p.payload) === hex(authPayload(USER, this.serial));
            this.reply(0x32, 0x35, 0x86, Uint8Array.of(ok ? 0 : 6));
          } else if (p.cmdSet === 0x20) {
            const key = `${p.dst}:${p.cmdId}`;
            if (REQ[key] !== undefined) this.reply(REQ[key], 0x20, p.cmdId, unhex(FIX[`${REQ[key]}:${p.cmdId}`]));
            if (key === '3:50') this.reply(6, 0x20, 0x32, unhex(FIX['6:50']));
          }
        }
      }
    } finally { this.busy = false; }
  }
}

const dev = new Dev();
/** Test hook: patch one field of a replayed telemetry payload, e.g. patch('3:2', 'EMS', 'f32LcdShowSoc', 8). */
dev.patch = (key, layout, name, value) => { FIX[key] = withField(FIX[key], layout, name, value); };
window.__fake = dev;
const mkChar = (uuid, extra) => ({ uuid, properties: { write: true, notify: true }, ...extra });
const notifyListeners = new Set(); // like real EventTargets: the same function is only registered once
const notifyChar = mkChar('6e400003-b5a3-f393-e0a9-e50e24dcca9e', {
  addEventListener: (t, fn) => notifyListeners.add(fn), removeEventListener: (t, fn) => notifyListeners.delete(fn), startNotifications: async () => {},
});
dev.notify = (bytes) => [...notifyListeners].forEach((fn) => fn({ target: { value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) } }));
const writeChar = mkChar('6e400002-b5a3-f393-e0a9-e50e24dcca9e', { writeValueWithResponse: (b) => dev.onWrite(b) });
const service = { uuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', getCharacteristics: async () => [writeChar, notifyChar] };
// Two batteries with different serials and browser device ids. The "browser" remembers granted devices across
// page loads (localStorage stands in for Chrome's persistent permissions).
const enc = (t) => new TextEncoder().encode(t);
const getGranted = () => { try { return JSON.parse(localStorage.getItem('fake.granted') ?? '[]'); } catch { return []; } };
const setGranted = (a) => localStorage.setItem('fake.granted', JSON.stringify(a));
const makeDevice = (id, serial) => {
  const adv = [], disc = [];
  const d = {
    name: 'ECOFLOW_BLE', id, serial, _disc: disc,
    addEventListener: (t, fn, opts) => {
      const list = t === 'advertisementreceived' ? adv : t === 'gattserverdisconnected' ? disc : null;
      if (!list) return;
      list.push(fn);
      opts?.signal?.addEventListener('abort', () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }); // like real EventTargets
    },
    // First advertisement after 20 ms, then one every 400 ms with a changing RSSI, until the watch is aborted.
    watchAdvertisements: async (opts = {}) => {
      const b = concat(Uint8Array.of(19), enc(serial), Uint8Array.of(0, 0xe4, 0, 0, 0, 0, 0b111110));
      const fire = () => { if (!dev.advertising) return; dev.rssiStep = (dev.rssiStep + 1) % 7; adv.slice().forEach((fn) => fn({ rssi: -60 - dev.rssiStep, manufacturerData: new Map([[EF_COMPANY_ID, new DataView(b.buffer)]]) })); };
      setTimeout(fire, 20);
      const t = dev.advertiseOnce ? 0 : setInterval(fire, 400); // advertiseOnce: like the real Delta Pro, silent once connected
      opts.signal?.addEventListener('abort', () => clearInterval(t));
    },
    gatt: {
      connect: async () => { dev.connects++; dev.reset(); dev.serial = serial; dev.current = d; dev.connectedIds.push(id); return { getPrimaryServices: async () => [service] }; },
      disconnect() { dev.disconnects = (dev.disconnects ?? 0) + 1; },
    },
    forget: async () => setGranted(getGranted().filter((x) => x !== id)),
  };
  return d;
};
const devices = { A: makeDevice('fake-device-id-0000', 'TESTX0000000001'), B: makeDevice('fake-device-id-0001', 'TESTX0000000002') };
dev.drop = () => { const c = dev.current; dev.reset(); c?._disc.forEach((fn) => fn()); }; // simulate the link dropping
dev.picks = 0; // how many times the chooser was shown on this page load
const bt = { requestDevice: async () => { dev.picks++; const d = devices[dev.nextPick]; setGranted([...new Set([...getGranted(), d.id])]); return d; } };
if (!window.__noGetDevices) bt.getDevices = async () => Object.values(devices).filter((d) => getGranted().includes(d.id)); // older browsers lack it
Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true });
