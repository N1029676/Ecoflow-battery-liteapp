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

test('csv export includes each pack', () => {
  const csv = toCsv([{ t: 0, soc: 50.5, soc0: 60, soc1: 41, soc2: null, inW: 10, outW: 0, tempC: null }, { t: 1000, soc: 50.5, soc0: 60, soc1: 41, soc2: null, inW: 10, outW: 0, tempC: 25 }]);
  assert.equal(csv, 'time,battery_percent,main_percent,extra1_percent,extra2_percent,input_w,output_w,temp_f\n1970-01-01T00:00:00.000Z,50.5,60,41,,10,0,\n1970-01-01T00:00:01.000Z,50.5,60,41,,10,0,77\n');
});

test('per-pack charge is recorded, averaged into the coarse tier and queried', () => {
  const h = new History({ fineMs: MIN, fineKeepMs: HOUR, coarseMs: 5 * MIN });
  for (let i = 0; i < 20; i++) h.add(i * MIN, { ...S(50), soc0: 60 + i, soc1: 40 });
  const q = h.query(30 * MIN, 19 * MIN);
  assert.equal(q.points.at(-1).soc0, 79);
  assert.equal(q.points.at(-1).soc1, 40);
  assert.equal(q.points.at(-1).soc2, null); // no second extra pack
  assert.equal(h.coarse[0][5], 62); // soc0 mean of 60..64
});

test('history saved before per-pack columns existed is still read (pack values unknown)', () => {
  const old = { v: 1, fine: [[1000, 50, 100, 0, 25]], coarse: [[2000, 51, 110, 0, 26]] };
  const h = History.fromJSON(old);
  assert.deepEqual(h.fine[0], [1000, 50, 100, 0, 25, null, null, null]);
  const q = h.query(HOUR, 1500);
  assert.equal(q.points[0].soc, 50);
  assert.equal(q.points[0].soc0, null);
  assert.equal(JSON.parse(JSON.stringify(h)).v, 2);
});

test('temperatures are converted from Celsius to Fahrenheit for display', async () => {
  const { cToF } = await import('../js/units.js');
  assert.equal(cToF(0), 32);
  assert.equal(cToF(25), 77);
  assert.equal(cToF(-40), -40);
  assert.equal(cToF(100), 212);
  assert.equal(cToF(null), null);
});
