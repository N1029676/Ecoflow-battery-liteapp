"""Generate tests/vectors.json: reference values for js/ tests.

Independent reference: uses python-ecdsa, pycryptodome and hashlib for the crypto, and a
bitwise reimplementation of the wire format written from the protocol notes (it does NOT
import or execute any upstream code). The session-key table is read as data from
js/keydata.js.

Usage: python3 -I tools/gen-vectors.py > tests/vectors.json
Needs: pip install ecdsa pycryptodome
"""
import base64, hashlib, json, os, re, struct

import ecdsa
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
KEYDATA = base64.b64decode(re.search(r'const B64 = "([^"]+)"', open(os.path.join(ROOT, 'js/keydata.js')).read()).group(1))

H = lambda b: bytes(b).hex()


def crc8(data):
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def crc16(data):  # CRC-16/ARC
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c


def enc_frame(ftype, payload, key=None, iv=None):
    if key:
        payload = AES.new(key, AES.MODE_CBC, iv).encrypt(pad(payload, 16))
    d = b'\x5a\x5a' + bytes([ftype << 4, 1]) + struct.pack('<H', len(payload) + 2) + payload
    return d + struct.pack('<H', crc16(d))


def packet_bytes(src, dst, cmd_set, cmd_id, payload, version, dsrc=1, ddst=1, seq=bytes(4)):
    d = b'\xaa' + bytes([version]) + struct.pack('<H', len(payload))
    d += bytes([crc8(d), 0x0D]) + seq + b'\x00\x00' + bytes([src, dst])
    if version >= 3:
        d += bytes([dsrc, ddst])
    d += bytes([cmd_set, cmd_id]) + payload
    return d + struct.pack('<H', crc16(d))


V = {}
V['md5'] = [{'in': H(m), 'out': H(hashlib.md5(m).digest())}
            for m in (b'', b'abc', bytes(range(55)), bytes(range(56)), bytes(range(64)), bytes(range(200)))]
V['crc'] = [{'in': H(m), 'crc8': crc8(m), 'crc16': crc16(m)} for m in (b'', b'123456789', bytes(range(100)))]
assert crc16(b'123456789') == 0xBB3D and crc8(b'123456789') == 0xF4  # published check values

ecdh = []
for a, b in ((0x1234567890ABCDEF1234567890ABCDEF12345678, 0x0FEDCBA0987654321FEDCBA09876543210FEDCBA),
             (0x1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFF)):
    ka = ecdsa.SigningKey.from_secret_exponent(a, curve=ecdsa.SECP160r1)
    kb = ecdsa.SigningKey.from_secret_exponent(b, curve=ecdsa.SECP160r1)
    e = ecdsa.ECDH(ecdsa.SECP160r1, ka, kb.get_verifying_key())
    ecdh.append({'privA': hex(a), 'privB': hex(b), 'pubA': H(ka.get_verifying_key().to_string()),
                 'pubB': H(kb.get_verifying_key().to_string()), 'shared': H(e.generate_sharedsecret_bytes())})
V['ecdh'] = ecdh

key, iv = bytes(range(16)), bytes(range(100, 116))
V['aes'] = {'key': H(key), 'iv': H(iv),
            'cases': [{'pt': H(p), 'ct': H(AES.new(key, AES.MODE_CBC, iv).encrypt(pad(p, 16)))}
                      for p in (b'', b'a', bytes(range(15)), bytes(range(16)), bytes(range(40)))]}


def tolerant_decrypt(ct):  # semantics: whole blocks only, unpad if valid else raw
    aligned = len(ct) - len(ct) % 16
    if aligned == 0:
        return ct
    dec = AES.new(key, AES.MODE_CBC, iv).decrypt(ct[:aligned])
    try:
        return unpad(dec, 16)
    except ValueError:
        return dec


V['aes_decrypt_tolerant'] = [{'ct': H(c), 'out': H(tolerant_decrypt(c))}
                             for c in (bytes(range(32)), bytes(range(37)), bytes(range(10)), bytes(16),
                                       AES.new(key, AES.MODE_CBC, iv).encrypt(pad(b'hello', 16)))]


def session_key(seed, srand):
    pos = seed[0] * 0x10 + ((seed[1] - 1) & 0xFF) * 0x100
    return hashlib.md5(KEYDATA[pos:pos + 8] + KEYDATA[pos + 8:pos + 16] + srand[:8] + srand[8:16]).digest()


V['session_key'] = [{'seed': H(s), 'srand': H(r), 'key': H(session_key(s, r))}
                    for s, r in ((bytes([1, 2]), bytes(range(16))), (bytes([200, 100]), bytes(range(50, 66))),
                                 (bytes([0, 1]), bytes(16)))]

V['enc_frames'] = [{'type': t, 'payload': H(p), 'plain_frame': H(enc_frame(t, p)), 'enc_frame': H(enc_frame(t, p, key, iv))}
                   for t, p in ((0, b'\x01\x00' + bytes(range(40))), (0, b'\x02'), (1, bytes(range(30))))]

V['packets'] = [{'src': a[0], 'dst': a[1], 'cmdSet': a[2], 'cmdId': a[3], 'payload': H(a[4]), 'version': a[5],
                 'bytes': H(packet_bytes(*a))}
                for a in ((0x21, 0x32, 0x35, 0x89, b'', 2), (0x21, 0x32, 0x35, 0x86, b'A' * 32, 2),
                          (0x21, 0x04, 0x20, 0x02, b'\x00', 3), (0x21, 0x35, 0x35, 0x86, b'Z' * 32, 3))]

xor_key = 0x5A
V['packet_xor'] = {'bytes': H(packet_bytes(0x02, 0x21, 0x20, 0x02, bytes(b ^ xor_key for b in b'hello world'), 2,
                                           seq=bytes([xor_key, 1, 2, 3]))),
                   'payload': H(b'hello world')}

V['auth'] = {'user': '1234567890', 'sn': 'DCABZ1234567890X',
             'upper': hashlib.md5(b'1234567890DCABZ1234567890X').hexdigest().upper()}
print(json.dumps(V, indent=1))
