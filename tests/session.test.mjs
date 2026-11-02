// End-to-end state-machine test against a fake device speaking the same protocol.
// (Crypto/framing primitives are verified separately against python reference vectors.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { EfSession } from '../js/session.js';
import { generateKeypair } from '../js/secp160r1.js';
import {
  Cipher, concat, hex, handshakeCipher, genSessionKey, encodeFrame, FrameReader, encodePacket,
  decodePacket, authPayload, FRAME_COMMAND, FRAME_PROTOCOL,
} from '../js/protocol.js';

class FakeDevice {
  constructor({ serial, userId, chunk = 20, seed = [3, 5] }) {
    Object.assign(this, { serial, userId, chunk, seed });
    this.reader = new FrameReader();
    this.cipher = null;
    this.session = null;
    this.sent = [];
  }
  async emit(frame) { // deliver in BLE-sized chunks
    for (let i = 0; i < frame.length; i += this.chunk) this.session.notify(frame.slice(i, i + this.chunk));
  }
  async write(bytes) {
    for (const f of this.reader.push(bytes)) {
      if (!this.cipher && f.payload[0] === 0x01) {
        const kp = generateKeypair();
        this.hs = handshakeCipher(kp.d, f.payload.slice(2, 42));
        await this.emit(await encodeFrame(FRAME_COMMAND, concat(Uint8Array.of(1, 0, 0), kp.pub)));
      } else if (!this.cipher && f.payload[0] === 0x02) {
        const srand = Uint8Array.from({ length: 16 }, (_, i) => i * 11 + 1);
        const body = await this.hs.encrypt(concat(srand, Uint8Array.from(this.seed)));
        this.cipher = new Cipher(genSessionKey(Uint8Array.from(this.seed), srand), this.hs.iv);
        await this.emit(await encodeFrame(FRAME_COMMAND, concat(Uint8Array.of(2), body)));
      } else if (this.cipher) {
        const p = decodePacket(await this.cipher.decrypt(f.payload));
        this.sent.push(p);
        if (p.cmdSet === 0x35 && p.cmdId === 0x89) await this.reply(0x35, 0x89, Uint8Array.of(0));
        else if (p.cmdSet === 0x35 && p.cmdId === 0x86) {
          const ok = hex(p.payload) === hex(authPayload(this.userId, this.serial));
          await this.reply(0x35, 0x86, Uint8Array.of(ok ? 0 : 6));
        } else if (p.cmdSet === 0x20) {
          await this.reply(0x20, p.cmdId, new TextEncoder().encode('telemetry'), 0x5a);
        }
      }
    }
  }
  async reply(cmdSet, cmdId, payload, xor = 0) {
    const seq = Uint8Array.of(xor, 0, 0, 0);
    const body = xor ? payload.map((b) => b ^ xor) : payload;
    const pkt = encodePacket({ src: 0x32, dst: 0x21, cmdSet, cmdId, payload: body, version: 2, seq });
    await this.emit(await encodeFrame(FRAME_PROTOCOL, pkt, this.cipher));
  }
}

function make(devOpts, sessOpts = {}) {
  const dev = new FakeDevice(devOpts);
  const s = new EfSession({ write: (b) => dev.write(b), userId: '4242', serial: 'DCABZ1234567890X', timeout: 2000, ...sessOpts });
  dev.session = s;
  return { dev, s };
}

test('handshake + auth succeeds, then telemetry is received (fragmented notifications)', async () => {
  const { dev, s } = make({ serial: 'DCABZ1234567890X', userId: '4242' });
  const packets = [];
  s.addEventListener('packet', (e) => packets.push(e.detail));
  await s.start();
  assert.equal(s.authenticated, true);
  await s.send({ dst: 0x02, cmdSet: 0x20, cmdId: 0x02, payload: Uint8Array.of(0) });
  await new Promise((r) => setTimeout(r, 50));
  const tele = packets.find((p) => p.cmdSet === 0x20);
  assert.equal(new TextDecoder().decode(tele.payload), 'telemetry'); // xor undone
});

test('wrong user id -> WrongKey', async () => {
  const { s } = make({ serial: 'DCABZ1234567890X', userId: 'someone-else' });
  await assert.rejects(s.start(), /WrongKey/);
});

test('works with a different seed and big chunks', async () => {
  const { s } = make({ serial: 'DCABZ1234567890X', userId: '4242', chunk: 512, seed: [200, 100] });
  await s.start();
  assert.equal(s.authenticated, true);
});

test('times out cleanly when the device is silent', async () => {
  const s = new EfSession({ write: async () => {}, userId: '1', serial: 'X', timeout: 100 });
  await assert.rejects(s.start(), /timeout waiting for device public key/);
});
