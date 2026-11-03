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

test('signal text: plain reading, weak flagged, nothing without a reading', () => {
  assert.equal(signalText({ rssi: -66 }), '-66 dBm');
  assert.equal(signalText({ rssi: -84 }), '-84 dBm');
  assert.equal(signalText({ rssi: -85 }), '-85 dBm (weak)');
  assert.equal(signalText({ rssi: -92 }), '-92 dBm (weak)');
  assert.equal(signalText(null), '');
});
