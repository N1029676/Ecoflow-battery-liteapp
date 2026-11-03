import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtAge, signalText } from '../js/live.js';

test('age formatting', () => {
  assert.equal(fmtAge(0), '0.0 s');
  assert.equal(fmtAge(450), '0.5 s');
  assert.equal(fmtAge(9940), '9.9 s');
  assert.equal(fmtAge(12300), '12 s');
  assert.equal(fmtAge(59999), '59 s');
  assert.equal(fmtAge(65000), '1 m 05 s');
  assert.equal(fmtAge(3725000), '62 m 05 s');
});

test('signal text: fresh reading is shown plainly, weak is flagged', () => {
  assert.equal(signalText({ rssi: -66, t: 1000, live: true }, 3000, 10000), '-66 dBm');
  assert.equal(signalText({ rssi: -88, t: 1000, live: true }, 3000, 10000), '-88 dBm (weak)');
  assert.equal(signalText(null, 3000, 10000), '');
});

test('signal text: an old reading is labelled for what it is', () => {
  // taken before the connection was established, and nothing newer ever arrived (battery stops advertising)
  assert.equal(signalText({ rssi: -82, t: 0, live: false }, 60000, 10000), '-82 dBm at connect');
  // arrived while connected, then stopped
  assert.equal(signalText({ rssi: -70, t: 0, live: true }, 60000, 10000), '-70 dBm (last seen)');
  assert.equal(signalText({ rssi: -90, t: 0, live: false }, 60000, 10000), '-90 dBm (weak) at connect');
  // exactly at the limit is still fresh
  assert.equal(signalText({ rssi: -70, t: 0, live: false }, 10000, 10000), '-70 dBm');
});
