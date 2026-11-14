import test from 'node:test';
import assert from 'node:assert/strict';
import { staleParts } from '../js/fresh.js';

const state = { pd: {}, ems: {}, bms: { 0: {}, 1: {} } };
const all = (t) => ({ pd: t, ems: t, bms0: t, bms1: t });

test('everything received recently is current', () => {
  assert.deepEqual(staleParts(state, all(10000), 12000), []);
});

test('after a freeze, a fresh power packet does not make old pack readings current', () => {
  const rx = { ...all(1000), pd: 600000 }; // only the power packet has arrived since the page woke up
  assert.deepEqual(staleParts(state, rx, 600100), ['ems', 'bms0', 'bms1']);
});

test('each pack is checked on its own', () => {
  assert.deepEqual(staleParts(state, { ...all(10000), bms1: 1000 }, 10500), ['bms1']);
});

test('a part never received counts as stale; an absent charge manager is not required', () => {
  assert.deepEqual(staleParts({ pd: {}, bms: { 0: {} } }, { pd: 5000 }, 5100), ['bms0']);
  assert.deepEqual(staleParts({ pd: {}, bms: {} }, { pd: 5000 }, 5100), []);
  assert.deepEqual(staleParts({ bms: {} }, {}, 5100), ['pd']);
});

test('the limit is five seconds by default and can be changed', () => {
  assert.deepEqual(staleParts(state, all(1000), 6000), []);
  assert.deepEqual(staleParts(state, all(1000), 6001), ['pd', 'ems', 'bms0', 'bms1']);
  assert.deepEqual(staleParts(state, all(1000), 3000, 1500), ['pd', 'ems', 'bms0', 'bms1']);
});
