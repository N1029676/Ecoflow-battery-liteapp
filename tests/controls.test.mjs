import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '../js/protocol.js';
import { cmdAcCharging, cmdAcOutput, cmdChargeLimit, cmdDischargeLimit, cmdAcChargePower, cmdDcChargeCurrent, acChargeMax, validateLimit, validateAcChargePower, validateDcChargeCurrent, dischargeLimitStopsOutput, confirmed, LIMITS } from '../js/controls.js';

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

test('AC charging power command: inverter, id 0x45, src 0x20, [FF, FF, watts u16 LE, FF]', () => {
  const c = cmdAcChargePower(1200);
  assert.deepEqual([c.src, c.dst, c.cmdSet, c.cmdId, hex(c.payload)], [0x20, 0x04, 0x20, 0x45, 'ffffb004ff']);
  assert.equal(hex(cmdAcChargePower(200).payload), 'ffffc800ff');
  assert.equal(hex(cmdAcChargePower(2900).payload), 'ffff540bff');
});

test('DC charging current command sends MILLIamps: 8 A -> 8000 (u32 LE), to the MPPT', () => {
  const c = cmdDcChargeCurrent(8);
  assert.deepEqual([c.dst, c.cmdSet, c.cmdId, hex(c.payload)], [0x05, 0x20, 0x47, '401f0000']);
  assert.equal(hex(cmdDcChargeCurrent(6).payload), '70170000'); // 6000, the value this battery reports today
  assert.equal(cmdDcChargeCurrent(4, 0x07).dst, 0x07); // other MPPT address
  assert.equal(c.src, undefined); // normal app source (0x21) applies
});

test('AC charging power range: 200 up to the rated maximum (1800 W when none is reported)', () => {
  assert.equal(acChargeMax(0), 1800);
  assert.equal(acChargeMax(150), 1800); // implausible rating -> default
  assert.equal(acChargeMax(2900), 2900);
  assert.equal(validateAcChargePower('200', 1800), null);
  assert.equal(validateAcChargePower('1800', 1800), null);
  assert.match(validateAcChargePower('199', 1800), /from 200 to 1800/);
  assert.match(validateAcChargePower('1801', 1800), /from 200 to 1800/);
  assert.equal(validateAcChargePower('2500', 2900), null);
  for (const v of ['', 'x', '1e3', '900.5', '-5']) assert.match(validateAcChargePower(v, 1800), /whole number/, v);
});

test('DC charging current range: whole amps 4 to 8', () => {
  for (const v of ['4', '6', '8']) assert.equal(validateDcChargeCurrent(v), null, v);
  for (const v of ['3', '9', '0']) assert.match(validateDcChargeCurrent(v), /from 4 to 8 A/, v);
  for (const v of ['', '6.5', 'x']) assert.match(validateDcChargeCurrent(v), /whole number/, v);
});

test('confirmation for the charging settings reads the battery state (watts / milliamps)', () => {
  const st = { inv: { cfgSlowChgWatts: 1200 }, mppt: { cfgDcChgCurrent: 8000 } };
  assert.equal(confirmed('acw', 1200, st), true);
  assert.equal(confirmed('acw', 900, st), false);
  assert.equal(confirmed('dca', 8, st), true);
  assert.equal(confirmed('dca', 6, st), false);
  assert.equal(confirmed('dca', 8, {}), false);
});

test('AC charging pause/resume: same command as the power setting, only the last byte set (1 = paused, 0 = charging)', () => {
  const pause = cmdAcCharging(false), resume = cmdAcCharging(true);
  assert.deepEqual([pause.src, pause.dst, pause.cmdSet, pause.cmdId], [0x20, 0x04, 0x20, 0x45]);
  assert.equal(hex(pause.payload), 'ffffffff01');
  assert.equal(hex(resume.payload), 'ffffffff00');
  // the power command leaves the pause byte alone and the pause command leaves the power bytes alone
  assert.equal(cmdAcChargePower(900).payload.at(-1), 0xff);
  assert.deepEqual([...pause.payload.slice(0, 4)], [0xff, 0xff, 0xff, 0xff]);
});

test('AC charging confirmation reads the inverter pause flag (0 = charging allowed)', () => {
  assert.equal(confirmed('accharge', true, { inv: { cfgPauseFlag: 0 } }), true);
  assert.equal(confirmed('accharge', false, { inv: { cfgPauseFlag: 1 } }), true);
  assert.equal(confirmed('accharge', false, { inv: { cfgPauseFlag: 0 } }), false);
  assert.equal(confirmed('accharge', true, {}), false);
});
