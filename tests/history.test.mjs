import test from 'node:test';
import assert from 'node:assert/strict';
import { History, toCsv } from '../js/history.js';

const S = (soc, inW = 0, outW = 0, tempC = 25) => ({ soc, inW, outW, tempC });
const MIN = 60e3, HOUR = 3600e3;

test('throttles to one sample per fineMs and ignores empty samples', () => {
  const h = new History({ fineMs: 15000 });
  assert.equal(h.add(0, S(50)), true);
  assert.equal(h.add(5000, S(51)), false);
  assert.equal(h.add(15000, S(52)), true);
  assert.equal(h.add(30000, { soc: null }), false);
  assert.equal(h.fine.length, 2);
});

test('fine tier is trimmed to its retention window', () => {
  const h = new History({ fineMs: MIN, fineKeepMs: HOUR });
  for (let i = 0; i <= 180; i++) h.add(i * MIN, S(50));
  assert.ok(h.fine.length <= 61 && h.fine.length >= 60, String(h.fine.length));
  assert.ok(h.fine[0][0] >= 180 * MIN - HOUR);
});

test('coarse tier holds 5-minute averages and keeps long-range history', () => {
  const h = new History({ fineMs: MIN, fineKeepMs: HOUR, coarseMs: 5 * MIN });
  for (let i = 0; i < 600; i++) h.add(i * MIN, S(i % 10, 100 + (i % 5) * 10)); // 10 hours
  assert.ok(h.coarse.length >= 100, `coarse=${h.coarse.length}`);
  const q = h.query(8 * HOUR, 599 * MIN);
  assert.equal(q.stepMs, 5 * MIN);
  assert.ok(q.points.length > 90 && q.points.length < 140, String(q.points.length));
  const avg = h.coarse[3]; // bucket of 5 samples: inW 100..140 -> mean 120
  assert.equal(avg[2], 120);
});

test('query short range uses fine tier and filters by time', () => {
  const h = new History({ fineMs: MIN });
  for (let i = 0; i < 120; i++) h.add(i * MIN, S(i));
  const q = h.query(30 * MIN, 119 * MIN);
  assert.equal(q.stepMs, MIN);
  assert.equal(q.points[0].t, 89 * MIN);
  assert.equal(q.points.at(-1).soc, 119);
});

test('JSON roundtrip, and corrupt data is ignored', () => {
  const h = new History({ fineMs: MIN });
  for (let i = 0; i < 20; i++) h.add(i * MIN, S(i, 1.4, 2.6, 30.2));
  const h2 = History.fromJSON(JSON.parse(JSON.stringify(h)), { fineMs: MIN });
  assert.deepEqual(h2.fine, h.fine);
  assert.equal(h2.fine[3][2], 1); // watts rounded to integers
  assert.equal(History.fromJSON({ v: 9 }).fine.length, 0);
  assert.equal(History.fromJSON({ v: 1, fine: [[1, 2]], coarse: [['x']] }).fine.length, 0);
  assert.equal(History.fromJSON(null).fine.length, 0);
});

test('csv export', () => {
  const csv = toCsv([{ t: 0, soc: 50.5, inW: 10, outW: 0, tempC: null }]);
  assert.equal(csv, 'time,battery_percent,input_w,output_w,temp_c\n1970-01-01T00:00:00.000Z,50.5,10,0,\n');
});
