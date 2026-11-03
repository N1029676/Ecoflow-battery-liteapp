import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '../js/protocol.js';
import { cmdAcOutput, cmdChargeLimit, cmdDischargeLimit, validateLimit, dischargeLimitStopsOutput, confirmed, LIMITS } from '../js/controls.js';

test('AC output command bytes match the community driver (inverter, id 0x42, [on, FF x6])', () => {
  const on = cmdAcOutput(true), off = cmdAcOutput(false);
  assert.deepEqual([on.dst, on.cmdSet, on.cmdId], [0x04, 0x20, 0x42]);
  assert.equal(hex(on.payload), '01ffffffffffff');
  assert.equal(hex(off.payload), '00ffffffffffff');
});

test('limit commands: EMS, ids 0x31 (charge max) and 0x33 (discharge min), one byte', () => {
  const c = cmdChargeLimit(90), d = cmdDischargeLimit(10);
  assert.deepEqual([c.dst, c.cmdSet, c.cmdId, hex(c.payload)], [0x03, 0x20, 0x31, '5a']);
  assert.deepEqual([d.dst, d.cmdSet, d.cmdId, hex(d.payload)], [0x03, 0x20, 0x33, '0a']);
});

test('validation: whole numbers inside the allowed ranges only', () => {
  assert.equal(LIMITS.chargeMin, 50);
  for (const v of ['50', '75', '100', ' 90 ']) assert.equal(validateLimit('charge', v), null, v);
  for (const v of ['49', '101', '', 'abc', '9.5', '-5', '1e2', null, undefined]) assert.match(validateLimit('charge', v), /Charge limit must/, String(v));
  for (const v of ['0', '15', '30']) assert.equal(validateLimit('discharge', v), null, v);
  for (const v of ['31', '-1', '', 'x', '5.5']) assert.match(validateLimit('discharge', v), /Discharge limit must/, String(v));
});

test('a discharge limit at or above the current charge would stop the output', () => {
  assert.equal(dischargeLimitStopsOutput(25, 20), true);
  assert.equal(dischargeLimitStopsOutput(20, 20), true);
  assert.equal(dischargeLimitStopsOutput(10, 20), false);
  assert.equal(dischargeLimitStopsOutput(30, null), false); // unknown charge: no claim
});

test('confirmation reads the battery state, not what we sent', () => {
  const st = { inv: { cfgAcEnabled: 1 }, ems: { maxChargeSoc: 90, minDsgSoc: 5 } };
  assert.equal(confirmed('ac', true, st), true);
  assert.equal(confirmed('ac', false, st), false);
  assert.equal(confirmed('charge', 90, st), true);
  assert.equal(confirmed('charge', 80, st), false);
  assert.equal(confirmed('discharge', 5, st), true);
  assert.equal(confirmed('ac', true, {}), false); // no data yet
  assert.equal(confirmed('nope', 1, st), false);
});
