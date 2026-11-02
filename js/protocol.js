// EcoFlow BLE protocol, "encrypt_type 7" (ECDH + AES-CBC session). Pure functions only:
// no Web Bluetooth here, so everything is testable in Node.
// Port of the wire format documented by rabits/ha-ef-ble (Apache-2.0). See NOTICE.
import { crc8, crc16 } from './crc.js';
import { md5 } from './md5.js';
import { get8bytes } from './keydata.js';
import { sharedSecret } from './secp160r1.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const hex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u16le = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
const readU16le = (b, o) => b[o] | (b[o + 1] << 8);

// ---------- AES-CBC (new cipher state per message, fixed IV: matches the device) ----------
export class Cipher {
  constructor(key, iv) { this.key = key; this.iv = iv; this._ck = null; }
  async _cryptoKey() {
    return (this._ck ??= await subtle.importKey('raw', this.key, 'AES-CBC', false, ['encrypt', 'decrypt']));
  }
  async encrypt(plain) { // PKCS#7
    return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: this.iv }, await this._cryptoKey(), plain));
  }
  // Device only decrypts whole blocks and drops the tail; bad padding => return raw bytes.
  async decrypt(ct) {
    const aligned = ct.length - (ct.length % 16);
    if (aligned === 0) return ct;
    ct = ct.subarray(0, aligned);
    const k = await this._cryptoKey();
    // WebCrypto insists on valid PKCS#7. Append one block that decrypts to valid padding
    // (chained on the last ciphertext block), so we get the raw plaintext and unpad ourselves.
    const padBlock = new Uint8Array(
      await subtle.encrypt({ name: 'AES-CBC', iv: ct.subarray(aligned - 16) }, k, new Uint8Array(0)));
    const raw = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: this.iv }, k, concat(ct, padBlock)));
    const n = raw[raw.length - 1];
    if (n >= 1 && n <= 16 && n <= raw.length && raw.subarray(raw.length - n).every((v) => v === n)) {
      return raw.subarray(0, raw.length - n);
    }
    return raw;
  }
}

// ---------- Handshake math ----------
// ECDH shared secret -> handshake cipher: key = secret[:16], iv = md5(secret) (secret is 20 bytes)
export function handshakeCipher(priv, devicePub) {
  const secret = sharedSecret(priv, devicePub);
  return new Cipher(secret.slice(0, 16), md5(secret));
}

// Device pub key size by the type byte in its reply. (Upstream's `case 3, 4` never matches;
// only the default 40 is exercised for SECP160r1.)
export const ecdhTypeSize = (t) => ({ 1: 52, 2: 56 }[t] ?? 40);

// session key = md5( keydata[pos..+8] | keydata[pos+8..+8] | srand[0..8] | srand[8..16] )
export function genSessionKey(seed, srand) {
  const pos = seed[0] * 0x10 + ((seed[1] - 1) & 0xff) * 0x100;
  const a = get8bytes(pos), b = get8bytes(pos + 8);
  if (a.length < 8 || b.length < 8) throw new Error(`keydata offset ${pos} out of range`);
  return md5(concat(a, b, srand.subarray(0, 8), srand.subarray(8, 16)));
}

// ---------- Outer frame: 5A 5A | type<<4 | 01 | len(2 LE) | payload | crc16 ----------
export const FRAME_COMMAND = 0x00;   // plaintext handshake frames
export const FRAME_PROTOCOL = 0x01;  // encrypted data frames
const PREFIX = Uint8Array.of(0x5a, 0x5a);

export async function encodeFrame(frameType, payload, cipher = null) {
  const body = cipher ? await cipher.encrypt(payload) : payload;
  const head = concat(PREFIX, Uint8Array.of(frameType << 4, 0x01), u16le(body.length + 2), body);
  return concat(head, u16le(crc16(head)));
}

const indexOf = (buf, pat, from = 0) => {
  outer: for (let i = from; i <= buf.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
};

// Splits a byte stream (BLE notifications) into verified frames.
// Returns [{frameType, payload}] and keeps any incomplete tail buffered.
export class FrameReader {
  constructor() { this.buf = new Uint8Array(0); }
  push(data) {
    let d = concat(this.buf, data);
    this.buf = new Uint8Array(0);
    const frames = [];
    while (d.length) {
      const s = indexOf(d, PREFIX);
      if (s < 0) { d = new Uint8Array(0); break; }
      if (s > 0) d = d.subarray(s);
      if (d.length < 8) break;
      const len = readU16le(d, 4);
      if (len > 10000) { d = d.subarray(2); continue; }
      const end = 6 + len;
      if (end > d.length) {
        const next = indexOf(d, PREFIX, 2);
        if (next >= 0) { d = d.subarray(next); continue; } // false prefix inside payload
        break; // genuinely incomplete: wait for more
      }
      if (crc16(d.subarray(0, end - 2)) !== readU16le(d, end - 2)) { d = d.subarray(2); continue; }
      frames.push({ frameType: d[2] >> 4, payload: d.slice(6, end - 2) });
      d = d.subarray(end);
    }
    this.buf = d.slice();
    return frames;
  }
}

// ---------- Inner packet (V2 / V3): AA | ver | len(2) | crc8 | 0d | seq(4) | 0000 | src dst [dsrc ddst] cmdset cmdid | payload | crc16 ----------
export function encodePacket({ src, dst, cmdSet, cmdId, payload = new Uint8Array(0), dsrc = 1, ddst = 1, version = 3, seq = new Uint8Array(4) }) {
  const head = concat(Uint8Array.of(0xaa, version), u16le(payload.length));
  const parts = [head, Uint8Array.of(crc8(head), 0x0d), seq, Uint8Array.of(0, 0, src, dst)];
  if (version >= 3) parts.push(Uint8Array.of(dsrc, ddst));
  parts.push(Uint8Array.of(cmdSet, cmdId), payload);
  const body = concat(...parts);
  return concat(body, u16le(crc16(body)));
}

export function decodePacket(data, { xorPayload = true } = {}) {
  if (data[0] !== 0xaa) return { error: 'bad prefix', raw: data };
  const vb = data[1];
  if (vb === 4) return { error: 'V4 packet (not supported yet)', raw: data };
  const version = vb & 0x0f, sentinel = (vb & 0x10) !== 0;
  if (![2, 3].includes(version)) return { error: `unknown version ${vb}`, raw: data };
  if ((version === 2 && data.length < 18) || (version === 3 && data.length < 20)) return { error: 'too small', raw: data };
  const len = readU16le(data, 2);
  const endsBB = data[data.length - 1] === 0xbb && data[data.length - 2] === 0xbb;
  if (!sentinel && !endsBB && crc16(data.subarray(0, data.length - 2)) !== readU16le(data, data.length - 2)) {
    return { error: 'bad crc16', raw: data };
  }
  if (crc8(data.subarray(0, 4)) !== data[4]) return { error: 'bad crc8', raw: data };
  const seq = data.slice(6, 10);
  const src = data[12], dst = data[13];
  let dsrc = 0, ddst = 0, cmdSet, cmdId, start;
  if (version === 2) { [cmdSet, cmdId] = [data[14], data[15]]; start = 16; }
  else { [dsrc, ddst, cmdSet, cmdId] = [data[14], data[15], data[16], data[17]]; start = 18; }
  let payload = data.slice(start, start + len);
  if (len > 0 && xorPayload && seq[0] !== 0) payload = payload.map((c) => c ^ seq[0]);
  if (sentinel && payload.length >= 2 && payload[payload.length - 1] === 0xbb && payload[payload.length - 2] === 0xbb) {
    payload = payload.slice(0, -2);
  }
  return { version: vb, src, dst, dsrc, ddst, cmdSet, cmdId, seq, payload };
}

// ---------- Auth payload: uppercase hex of md5(userId + serial) ----------
export const authPayload = (userId, serial, lower = false) => {
  const h = hex(md5(enc.encode(userId + serial)));
  return enc.encode(lower ? h : h.toUpperCase());
};

// ---------- Advertisement (manufacturer id 0xB5B5) ----------
export const EF_COMPANY_ID = 0xb5b5;
export function parseAdvertisement(bytes) {
  const caps = bytes.length > 19 ? bytes[22] : 0b0111000;
  return {
    protoVersion: bytes[0],
    serial: new TextDecoder().decode(bytes.subarray(1, 17)),
    status: bytes[17] ?? 0,
    productType: bytes[18] ?? 0,
    capabilityFlags: caps,
    encryptType: (caps & 0b0111000) >> 3,
  };
}
