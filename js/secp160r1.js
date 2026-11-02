// ECDH on SECP160r1 using BigInt. WebCrypto does not support this curve.
// Not constant-time: acceptable for an ephemeral key on a local BLE link, but do not
// reuse this for anything security-critical.
const P = 0xffffffffffffffffffffffffffffffff7fffffffn;
const A = P - 3n;
const B = 0x1c97befc54bd7a8b65acf89f81d4d4adc565fa45n;
const GX = 0x4a96b5688ef573284664698968c38bb913cbfc82n;
const GY = 0x23a628553168947d59dcc912042351377ac5fb32n;
const N = 0x100000000000000000001f4c8f927aed3ca752257n;
export const COORD_LEN = 20; // bytes per coordinate
const ORDER_LEN = 21; // bytes of the group order (private key size)

const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [r0, r1] = [mod(a, m), m], [s0, s1] = [1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}

// Affine points as [x, y]; null = infinity.
function add(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  let l;
  if (x1 === x2) {
    if (mod(y1 + y2) === 0n) return null;
    l = mod((3n * x1 * x1 + A) * inv(2n * y1));
  } else {
    l = mod((y2 - y1) * inv(x2 - x1));
  }
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}

function mul(k, pt) {
  let r = null, q = pt;
  while (k > 0n) {
    if (k & 1n) r = add(r, q);
    q = add(q, q);
    k >>= 1n;
  }
  return r;
}

const toBytes = (n, len) => {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const fromBytes = (b) => b.reduce((acc, v) => (acc << 8n) | BigInt(v), 0n);

export function generateKeypair(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  let d;
  do { d = fromBytes(randomBytes(ORDER_LEN)) % N; } while (d === 0n);
  return keypairFromPrivate(d);
}

export function keypairFromPrivate(d) {
  const [x, y] = mul(d, [GX, GY]);
  const pub = new Uint8Array(COORD_LEN * 2);
  pub.set(toBytes(x, COORD_LEN));
  pub.set(toBytes(y, COORD_LEN), COORD_LEN);
  return { d, pub };
}

// Returns the shared secret: x-coordinate, 20 bytes big-endian (matches python-ecdsa).
export function sharedSecret(d, peerPub) {
  if (peerPub.length !== COORD_LEN * 2) throw new Error(`peer public key must be 40 bytes, got ${peerPub.length}`);
  const x = fromBytes(peerPub.subarray(0, COORD_LEN));
  const y = fromBytes(peerPub.subarray(COORD_LEN));
  if (mod(y * y - (x * x * x + A * x + B)) !== 0n) throw new Error('peer public key is not on the curve');
  const s = mul(d, [x, y]);
  if (!s) throw new Error('invalid shared point');
  return toBytes(s[0], COORD_LEN);
}
