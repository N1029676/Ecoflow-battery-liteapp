// Transport-agnostic EcoFlow session: handshake -> session key -> auth -> packet stream.
// The transport (Web Bluetooth, or a fake device in tests) supplies `write(bytes)` and calls
// `notify(bytes)` for every incoming BLE notification.
import { generateKeypair } from './secp160r1.js';
import {
  Cipher, concat, hex, handshakeCipher, ecdhTypeSize, genSessionKey, encodeFrame, FrameReader,
  encodePacket, decodePacket, authPayload, FRAME_COMMAND, FRAME_PROTOCOL,
} from './protocol.js';

export const AUTH_ERRORS = {
  1: 'NeedRefreshToken', 2: 'DeviceInternalError', 3: 'DeviceAlreadyBound',
  4: 'NeedBindInstallFirst (bind the device to your account in the EcoFlow app)',
  5: 'AppSendDataError', 6: 'WrongKey (user ID / serial mismatch)', 7: 'MaximumDevicesError',
};

export class EfSession extends EventTarget {
  /**
   * @param {object} o
   * @param {(b: Uint8Array) => Promise<void>} o.write  write one frame to the device
   * @param {string} o.userId  EcoFlow account user ID
   * @param {string} o.serial  device serial number (16 chars, from the advertisement)
   * @param {number} [o.packetVersion=2]  inner packet version (Delta Pro driver: 2)
   * @param {number} [o.authDst=0x32]  destination for auth packets (Delta Pro driver: 0x32)
   * @param {number} [o.timeout=10000]
   */
  constructor({ write, userId, serial, packetVersion = 2, authDst = 0x32, timeout = 10000, randomBytes }) {
    super();
    Object.assign(this, { _write: write, userId, serial, packetVersion, authDst, timeout, _random: randomBytes });
    this._reader = new FrameReader();
    this._cipher = null;        // current cipher (handshake key, then session key)
    this._hasSession = false;   // true once the session key is installed
    this._waiter = null;
    this._chain = Promise.resolve();
    this.state = 'idle';
    this.authenticated = false;
  }

  _log(msg) { this.dispatchEvent(new CustomEvent('log', { detail: msg })); }
  _setState(s) { this.state = s; this._log(`state: ${s}`); this.dispatchEvent(new CustomEvent('state', { detail: s })); }

  /** Feed one BLE notification. Order is preserved across async decryption. */
  notify(bytes) {
    this._chain = this._chain.then(() => this._onBytes(bytes)).catch((e) => this._log(`rx error: ${e.message}`));
  }

  async _onBytes(bytes) {
    for (const frame of this._reader.push(bytes)) {
      if (!this._hasSession) {
        // Handshake phase: plaintext frames, first payload byte is the message type.
        this._log(`rx handshake frame type=${frame.frameType} ${hex(frame.payload)}`);
        if (this._waiter?.match(frame.payload)) this._waiter.resolve(frame.payload);
        continue;
      }
      if (frame.frameType === FRAME_COMMAND) continue; // stray repeated handshake reply
      const plain = await this._cipher.decrypt(frame.payload);
      const pkt = decodePacket(plain);
      if (pkt.error) {
        this._log(`rx undecodable (${pkt.error}): ${hex(plain)}`);
        this.dispatchEvent(new CustomEvent('badpacket', { detail: { error: pkt.error, raw: plain } }));
        continue;
      }
      if (this._waiter?.match(pkt)) this._waiter.resolve(pkt);
      if (!this.authenticated && this.state === 'authenticating' && pkt.cmdSet !== 0x35) {
        this._markAuthenticated('first data packet'); // upstream does the same
      }
      this.dispatchEvent(new CustomEvent('packet', { detail: pkt }));
    }
  }

  _wait(match, what) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._waiter = null; reject(new Error(`timeout waiting for ${what}`)); }, this.timeout);
      this._waiter = { match, resolve: (v) => { clearTimeout(t); this._waiter = null; resolve(v); } };
    });
  }

  async _sendSimple(payload) { await this._write(await encodeFrame(FRAME_COMMAND, payload)); }

  /** Send an inner packet through the encrypted session. */
  async send({ src = 0x21, dst, cmdSet, cmdId, payload = new Uint8Array(0), version = this.packetVersion }) {
    if (!this._hasSession) throw new Error('no session key yet');
    const body = encodePacket({ src, dst, cmdSet, cmdId, payload, version });
    await this._write(await encodeFrame(FRAME_PROTOCOL, body, this._cipher));
  }

  async start() {
    // 1. ECDH key exchange (SECP160r1)
    this._setState('key-exchange');
    const kp = generateKeypair(this._random);
    const pubReply = this._wait((p) => p[0] === 0x01 && p.length >= 43, 'device public key');
    await this._sendSimple(concat(Uint8Array.of(0x01, 0x00), kp.pub));
    const reply = await pubReply;
    const size = ecdhTypeSize(reply[2]);
    if (reply.length < size + 3) throw new Error(`device pubkey reply too short (${reply.length}, need ${size + 3})`);
    if (size !== 40) throw new Error(`device uses a ${size}-byte public key (curve type ${reply[2]}), only SECP160r1 (40) is implemented`);
    const hsCipher = handshakeCipher(kp.d, reply.slice(3, 3 + size));

    // 2. Session key request
    this._setState('session-key');
    const keyReply = this._wait((p) => p[0] === 0x02 && p.length >= 33, 'session key info');
    await this._sendSimple(Uint8Array.of(0x02));
    const info = await hsCipher.decrypt((await keyReply).slice(1));
    const sessionKey = genSessionKey(info.slice(16, 18), info.slice(0, 16));
    this._cipher = new Cipher(sessionKey, hsCipher.iv);
    this._hasSession = true;

    // 3. Auth status
    this._setState('auth-status');
    const statusReply = this._wait((p) => !p.error && p.cmdSet === 0x35, 'auth status reply');
    await this.send({ dst: this.authDst, cmdSet: 0x35, cmdId: 0x89 });
    const st = await statusReply;
    this._log(`auth status reply: ${hex(st.payload)}`);

    // 4. Authenticate with md5(userId + serial)
    this._setState('authenticating');
    const authReply = this._wait((p) => !p.error && p.cmdSet === 0x35 && p.cmdId === 0x86 || this.authenticated, 'auth reply');
    await this.send({ dst: this.authDst, cmdSet: 0x35, cmdId: 0x86, payload: authPayload(this.userId, this.serial) });
    const ar = await authReply;
    if (ar && ar.payload) {
      const code = ar.payload[0];
      if (ar.payload.length && code !== 0) {
        const name = AUTH_ERRORS[code] ?? `unknown error ${code}`;
        this._setState('auth-failed');
        throw new Error(`authentication failed: ${name}`);
      }
      this._markAuthenticated(`auth reply ${hex(ar.payload)}`);
    }
  }

  _markAuthenticated(why) {
    if (this.authenticated) return;
    this.authenticated = true;
    this._waiter?.resolve(null); // unblock a pending auth-reply wait
    this._setState('authenticated');
    this._log(`authenticated (${why})`);
  }
}
