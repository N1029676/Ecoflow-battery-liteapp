import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectError, connectHint, fmtAge, signalText } from '../js/live.js';

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

test('connection hints: weak signal and the one-connection limit', () => {
  assert.equal(connectHint(1, null), '');
  assert.equal(connectHint(1, { rssi: -70 }), '');
  assert.match(connectHint(1, { rssi: -94 }), /weak \(-94 dBm\).*closer/);
  assert.doesNotMatch(connectHint(1, { rssi: -94 }), /EcoFlow app/);
  assert.match(connectHint(2, { rssi: -70 }), /EcoFlow app/);
  assert.match(connectHint(3, { rssi: -90 }), /weak.*EcoFlow app/);
});

test('a weak link that lists no services is not mistaken for a lost permission', () => {
  const msg = "No accessible GATT service. The device's service UUID is not among the declared candidates";
  assert.equal(classifyConnectError(msg, { knownBattery: true, attempt: 1 }).kind, 'noservices');
  assert.match(classifyConnectError(msg, { knownBattery: true, attempt: 1 }).text, /weak signal/);
  assert.equal(classifyConnectError(msg, { knownBattery: true, attempt: 3 }).kind, 'noservices');
  assert.equal(classifyConnectError(msg, { knownBattery: true, attempt: 4 }).kind, 'permission'); // keeps happening
  assert.equal(classifyConnectError(msg, { knownBattery: false, attempt: 0 }).kind, 'other'); // first setup keeps the original advice
  assert.equal(classifyConnectError('NotAllowedError: Origin is not allowed', { attempt: 0 }).kind, 'permission');
  assert.equal(classifyConnectError('Turning on notifications timed out after 8 s').kind, 'other');
});
