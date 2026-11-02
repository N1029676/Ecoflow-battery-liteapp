// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc8, crc16 } from '../js/crc.js';
import { md5 } from '../js/md5.js';
import { keypairFromPrivate, sharedSecret, generateKeypair } from '../js/secp160r1.js';
import {
  Cipher, hex, unhex, concat, genSessionKey, encodeFrame, FrameReader, encodePacket, decodePacket,
  authPayload, handshakeCipher, FRAME_COMMAND, FRAME_PROTOCOL, parseAdvertisement,
} from '../js/protocol.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));

test('md5', () => { for (const c of V.md5) assert.equal(hex(md5(unhex(c.in))), c.out); });

test('crc8/crc16', () => {
  for (const c of V.crc) {
    assert.equal(crc8(unhex(c.in)), c.crc8);
    assert.equal(crc16(unhex(c.in)), c.crc16);
  }
});

test('secp160r1 ECDH matches python-ecdsa', () => {
  for (const c of V.ecdh) {
    const a = keypairFromPrivate(BigInt(c.privA)), b = keypairFromPrivate(BigInt(c.privB));
    assert.equal(hex(a.pub), c.pubA);
    assert.equal(hex(b.pub), c.pubB);
    assert.equal(hex(sharedSecret(a.d, b.pub)), c.shared);
    assert.equal(hex(sharedSecret(b.d, a.pub)), c.shared);
  }
});

test('ECDH rejects off-curve peer key', () => {
  const k = generateKeypair();
  const bad = k.pub.slice(); bad[39] ^= 1;
  assert.throws(() => sharedSecret(k.d, bad), /not on the curve/);
});

test('handshakeCipher: both sides agree', async () => {
  const a = generateKeypair(), b = generateKeypair();
  const ca = handshakeCipher(a.d, b.pub), cb = handshakeCipher(b.d, a.pub);
  assert.equal(hex(ca.key), hex(cb.key));
  assert.equal(hex(ca.iv), hex(cb.iv));
});

test('AES-CBC encrypt matches pycryptodome', async () => {
  const c = new Cipher(unhex(V.aes.key), unhex(V.aes.iv));
  for (const t of V.aes.cases) assert.equal(hex(await c.encrypt(unhex(t.pt))), t.ct);
});

test('AES-CBC tolerant decrypt (partial tail, bad padding, short input)', async () => {
  const c = new Cipher(unhex(V.aes.key), unhex(V.aes.iv));
  for (const t of V.aes_decrypt_tolerant) assert.equal(hex(await c.decrypt(unhex(t.ct))), t.out, t.ct);
});

test('AES-CBC roundtrip', async () => {
  const c = new Cipher(unhex(V.aes.key), unhex(V.aes.iv));
  for (const n of [0, 1, 15, 16, 17, 100]) {
    const pt = Uint8Array.from({ length: n }, (_, i) => i * 7);
    assert.equal(hex(await c.decrypt(await c.encrypt(pt))), hex(pt));
  }
});

test('session key matches reference', () => {
  for (const c of V.session_key) assert.equal(hex(genSessionKey(unhex(c.seed), unhex(c.srand))), c.key);
});

test('outer frames match reference', async () => {
  const c = new Cipher(unhex(V.aes.key), unhex(V.aes.iv));
  for (const f of V.enc_frames) {
    assert.equal(hex(await encodeFrame(f.type, unhex(f.payload))), f.plain_frame);
    assert.equal(hex(await encodeFrame(f.type, unhex(f.payload), c)), f.enc_frame);
  }
});

test('FrameReader: split across notifications, garbage prefix, back-to-back, bad crc', async () => {
  const f1 = await encodeFrame(FRAME_COMMAND, unhex('0100aabbccdd'));
  const f2 = await encodeFrame(FRAME_PROTOCOL, unhex('11'.repeat(40)));
  const stream = concat(unhex('deadbeef'), f1, f2);
  const r = new FrameReader();
  let got = [];
  for (let i = 0; i < stream.length; i += 7) got.push(...r.push(stream.subarray(i, i + 7)));
  assert.deepEqual(got.map((g) => [g.frameType, hex(g.payload)]), [[0, '0100aabbccdd'], [1, '11'.repeat(40)]]);

  const corrupt = f1.slice(); corrupt[7] ^= 0xff;
  got = new FrameReader().push(concat(corrupt, f2));
  assert.equal(got.length, 1);
  assert.equal(got[0].frameType, 1);
});

test('inner packets match reference and decode back', () => {
  for (const p of V.packets) {
    const b = encodePacket({ src: p.src, dst: p.dst, cmdSet: p.cmdSet, cmdId: p.cmdId, payload: unhex(p.payload), version: p.version });
    assert.equal(hex(b), p.bytes);
    const d = decodePacket(b);
    assert.equal(d.error, undefined);
    assert.deepEqual([d.src, d.dst, d.cmdSet, d.cmdId, hex(d.payload)], [p.src, p.dst, p.cmdSet, p.cmdId, p.payload]);
  }
});

test('inner packet: seq[0] XOR payload and crc errors', () => {
  const d = decodePacket(unhex(V.packet_xor.bytes));
  assert.equal(hex(d.payload), V.packet_xor.payload);
  const bad = unhex(V.packet_xor.bytes); bad[bad.length - 1] ^= 1;
  assert.equal(decodePacket(bad).error, 'bad crc16');
});

test('auth payload', () => {
  assert.equal(new TextDecoder().decode(authPayload(V.auth.user, V.auth.sn)), V.auth.upper);
});

test('advertisement parsing', () => {
  const sn = 'DCABZ1234567890X';
  const bytes = concat(Uint8Array.of(2), new TextEncoder().encode(sn), Uint8Array.of(0x80, 0x0a, 0, 0, 0, 0b0111001));
  const a = parseAdvertisement(bytes);
  assert.equal(a.serial, sn);
  assert.equal(a.encryptType, 7);
  assert.equal(a.productType, 0x0a);
});

import { fetchUserId, LoginError } from '../js/login.js';

test('login: builds expected request and extracts user id', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ code: '0', data: { user: { userId: 987654321 } } }) };
  };
  assert.equal(await fetchUserId('a@b.c', 'pässword', { fetchImpl }), '987654321');
  assert.equal(seen.url, 'https://api.ecoflow.com/auth/login');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(Buffer.from(seen.body.password, 'base64').toString('utf8'), 'pässword');
  assert.equal(seen.body.scene, 'IOT_APP');
});

test('login: API error and network error are reported', async () => {
  const bad = async () => ({ ok: true, status: 200, json: async () => ({ code: '2026', message: 'wrong password' }) });
  await assert.rejects(fetchUserId('a@b.c', 'x', { fetchImpl: bad }), /wrong password/);
  const net = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(fetchUserId('a@b.c', 'x', { fetchImpl: net }), LoginError);
});

test('advertisement: NUL-padded 15-char serial is trimmed (real Delta Pro)', () => {
  const sn = 'DCABZ5SH2220790';
  const bytes = concat(Uint8Array.of(19), new TextEncoder().encode(sn), Uint8Array.of(0, 0xda, 0, 0, 0, 0, 0b111110));
  const a = parseAdvertisement(bytes);
  assert.equal(a.serial, sn);
  assert.equal(a.encryptType, 7);
  assert.equal(a.protoVersion, 19);
});
