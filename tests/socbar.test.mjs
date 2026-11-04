import test from 'node:test';
import assert from 'node:assert/strict';
import { socLevel, litSegments, leadIndex, SEGMENTS } from '../js/socbar.js';
import { summarize, flowOf } from '../js/decode.js';

test('level thresholds: green, yellow at <=25, red at <=10', () => {
  assert.equal(socLevel(100), 'ok');
  assert.equal(socLevel(25.1), 'ok');
  assert.equal(socLevel(25), 'low');
  assert.equal(socLevel(10.1), 'low');
  assert.equal(socLevel(10), 'critical');
  assert.equal(socLevel(0), 'critical');
  assert.equal(socLevel(null), 'unknown');
});

test('a segment lights as soon as the charge enters its 5% band', () => {
  assert.equal(SEGMENTS, 20);
  assert.equal(litSegments(100), 20);
  assert.equal(litSegments(94.1), 19);
  assert.equal(litSegments(95), 19);
  assert.equal(litSegments(95.1), 20);
  assert.equal(litSegments(50), 10);
  assert.equal(litSegments(50.1), 11);
  assert.equal(litSegments(25), 5);
  assert.equal(litSegments(22.3), 5);
  assert.equal(litSegments(14.1), 3);
  assert.equal(litSegments(10.1), 3);
  assert.equal(litSegments(10), 2);
  assert.equal(litSegments(10.04), 2); // shows as 10.0%
  assert.equal(litSegments(5.1), 2);
  assert.equal(litSegments(2.4), 1);
  assert.equal(litSegments(0.1), 1);
  assert.equal(litSegments(0), 0);
  assert.equal(litSegments(null), 0);
});

test('lead (pulsing) segment is the last lit one', () => {
  assert.equal(leadIndex(94.1), 18);
  assert.equal(leadIndex(100), 19);
  assert.equal(leadIndex(0.1), 0);
  assert.equal(leadIndex(0), -1);
  assert.equal(leadIndex(null), -1);
});

test('charge direction from pack current (positive = charging) with a small deadband', () => {
  assert.equal(flowOf(15), 'charging');
  assert.equal(flowOf(0.05), 'idle');
  assert.equal(flowOf(0), 'idle');
  assert.equal(flowOf(-0.05), 'idle');
  assert.equal(flowOf(-4), 'discharging');
});

const pack = (num, soc, ampMa) => ({ num, f32ShowSoc: soc, soc, vol: 51000, amp: ampMa >>> 0, temp: 25, designCap: 80000, remainCap: 80000, cycles: 1, soh: 100, maxCellVol: 3400, minCellVol: 3390 });

test('summarize: per-pack and system flow', () => {
  let m = summarize({ bms: { 0: pack(0, 50, 0), 1: pack(1, 40, 15000) } });
  assert.deepEqual(m.batteries.map((b) => b.flow), ['idle', 'charging']);
  assert.equal(m.flow, 'charging'); // any pack charging
  m = summarize({ bms: { 0: pack(0, 50, -4000), 1: pack(1, 40, 0) } });
  assert.deepEqual(m.batteries.map((b) => b.flow), ['discharging', 'idle']);
  assert.equal(m.flow, 'discharging');
  m = summarize({ bms: { 0: pack(0, 50, 0) } });
  assert.equal(m.flow, 'idle');
});

test('summarize: without pack data, flow is inferred from power totals', () => {
  assert.equal(summarize({ pd: { wattsInSum: 900, wattsOutSum: 100 } }).flow, 'charging');
  assert.equal(summarize({ pd: { wattsInSum: 0, wattsOutSum: 300 } }).flow, 'discharging');
  assert.equal(summarize({ pd: { wattsInSum: 5, wattsOutSum: 0 } }).flow, 'idle');
  assert.equal(summarize({}).flow, undefined);
});
