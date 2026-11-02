// CRC8 (poly 0x07, init 0, no reflection) and CRC16/ARC (poly 0x8005 reflected, init 0).
const T8 = new Uint8Array(256);
const T16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  T8[i] = c;
  c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1;
  T16[i] = c;
}

export function crc8(data) {
  let c = 0;
  for (const b of data) c = T8[c ^ b];
  return c;
}

export function crc16(data) {
  let c = 0;
  for (const b of data) c = T16[(c ^ b) & 0xff] ^ (c >> 8);
  return c;
}
