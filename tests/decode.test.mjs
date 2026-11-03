// Fixtures are real payloads captured from a Delta Pro (serial-bearing packets deliberately excluded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { unhex } from '../js/protocol.js';
import { decodeTelemetry, summarize, LAYOUT_SIZES } from '../js/decode.js';

const PKT = {
  pd: { src: 2, cmdSet: 0x20, cmdId: 2, payload: unhex('02000000009c00020102000300006410038303a85d000000010000000000001617000000f0002c010a000000000d00000089e9000004030000bf4800004efe0000e0570000a8c30000312f0000688b150000000000200000000000000001010000000800008000000000000000000000ffff000f0500000000') },
  ems: { src: 3, cmdSet: 0x20, cmdId: 2, payload: unhex('0101014ed30000e8fd00000064025e0000703e0000a85d000001c93abc42030300020259c80000b1ca0000000064000122000000020301') },
  inv: { src: 4, cmdSet: 0x20, cmdId: 2, payload: unhex('000000009e0101020183030000000000000000000000001ecb0100e01d00003c2300d0070000000000002400010000c0d401000200000200008403a0050000000000000000000000') },
  mppt: { src: 5, cmdSet: 0x20, cmdId: 2, payload: unhex('00000000320001030000000000000000000000020000020000000e001600030000000000000000000000000000000000000000000000000000160001007017000000') },
  bms: { src: 3, cmdSet: 0x20, cmdId: 0x32, payload: unhex('0001020600000023050101646ac70000000000001c028038010030380100303801000900000064ab0d350d1c1a19190080401f00000000c84200000000000000000000000000000076000f440d3a0d3e0d3e0d380d440dab0d400d430d350d3b0d570d3c0d530d380d041c001b001b001a0056302e302e300301ffff303030303030303030303030303030300e020000c84200000000cdccc7420d00010102004000800000000000ffffffffffffffff000000000000000000000000') },
};

test('payload sizes match layouts', () => {
  assert.equal(PKT.pd.payload.length, LAYOUT_SIZES.PD);
  assert.equal(PKT.inv.payload.length, LAYOUT_SIZES.INV); // 67 documented bytes + 5 unknown trailing
});

test('decode + summarize real Delta Pro capture', () => {
  const st = { bms: {} };
  for (const [k, p] of Object.entries(PKT)) {
    const t = decodeTelemetry(p);
    assert.equal(t.kind, k);
    if (k === 'bms') st.bms[t.data.num] = t.data; else st[k] = t.data;
  }
  const m = summarize(st);
  assert.equal(m.soc, 94.1);
  assert.equal(m.inW, 899); assert.equal(m.outW, 784);
  assert.equal(m.acInW, 899);
  assert.equal(m.acInV, 117.5); assert.equal(m.acInA, 7.65);
  assert.ok(Math.abs(m.acInV * m.acInA - m.acInW) < 5, 'V*A ~= W cross-check between two packets');
  assert.equal(st.inv.acInFreq, 60);
  assert.equal(m.acInHz, 60); assert.equal(m.acOutV, 120);
  const b = m.batteries[0];
  assert.deepEqual([b.num, b.soc, b.volts, b.amps, b.tempC, b.cycles, b.sohPct, b.designAh, b.cellMinMv, b.cellMaxMv],
    [0, 100, 51.05, 0, 28, 9, 100, 80, 3381, 3499]);
});

test('short payloads decode partially instead of throwing', () => {
  const t = decodeTelemetry({ ...PKT.ems, payload: PKT.ems.payload.slice(0, 20) });
  assert.equal(t.data.chgState, 1);
  assert.equal(t.data.f32LcdShowSoc, undefined);
});

test('unknown messages are ignored', () => {
  assert.equal(decodeTelemetry({ src: 3, cmdSet: 3, cmdId: 0x0e, payload: new Uint8Array(5) }), null);
});

test('idle / fully charged capture (AC plugged, nothing flowing)', () => {
  const mk = (src, hexs, cmdId = 2) => decodeTelemetry({ src, cmdSet: 0x20, cmdId, payload: unhex(hexs) }).data;
  const st = {
    pd: mk(2, '02000000009c00020102000300006400000000a85d000000010000000000001717000000f0002c010a000000000d0000009ee9000004030000bf4800004efe0000e0570000a8c30000312f0000f48b150000000000200000000000000001010000000800008000000000000000000000ffff000f0500000000'),
    ems: mk(3, '010101c8af0000d83b0000006402640000703e0000a85d000001aeffc742030300020343c4000083ca0000000064030022000000000301'),
    inv: mk(4, '000000009e01010200000000000000000000000000000065db0100000000003c1e00d0070000000000002000000000c0d401000200000200008403a0050000000000000000000000'),
    bms: {},
  };
  const m = summarize(st);
  assert.equal(m.soc, 100);
  assert.deepEqual([m.inW, m.outW, m.acInW, m.acOutW], [0, 0, 0, 0]);
  assert.equal(m.acInV, 121.7); assert.equal(m.acInA, 0);
});
