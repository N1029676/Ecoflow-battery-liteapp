import test from 'node:test';
import assert from 'node:assert/strict';
import { Batteries, displayName, connectNotice } from '../js/batteries.js';

const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { get: (k, d = '') => m.get(k) ?? d, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), m };
};
const A = 'DCABZ5SH2220790', B = 'DCABZ5SH2221234';

test('starts empty', () => {
  const b = new Batteries(mem());
  assert.deepEqual(b.list, []);
  assert.equal(b.last, null);
});

test('upsert adds, refreshes the device id, and tracks the last used battery', () => {
  const s = mem();
  const b = new Batteries(s);
  b.upsert({ serial: A, deviceId: 'dev-1' });
  b.upsert({ serial: B, deviceId: 'dev-2' });
  assert.equal(b.list.length, 2);
  assert.equal(b.last, B);
  b.upsert({ serial: A, deviceId: 'dev-1b' }); // same battery, new browser id: no duplicate
  assert.equal(b.list.length, 2);
  assert.equal(b.get(A).deviceId, 'dev-1b');
  assert.equal(b.last, A);
  assert.deepEqual(new Batteries(s).list, b.list); // persisted
});

test('names: default from the serial, nickname wins, trimmed and capped', () => {
  const b = new Batteries(mem());
  b.upsert({ serial: A, deviceId: 'x' });
  assert.equal(displayName(b.get(A)), 'Battery 0790');
  b.rename(A, '  Garage  ');
  assert.equal(displayName(b.get(A)), 'Garage');
  b.rename(A, 'x'.repeat(100));
  assert.equal(b.get(A).nickname.length, 40);
  b.rename(A, '');
  assert.equal(displayName(b.get(A)), 'Battery 0790');
  b.rename('NOPE0000000000', 'ignored'); // unknown serial: no-op
});

test('remove, including the last-used pointer', () => {
  const b = new Batteries(mem());
  b.upsert({ serial: A, deviceId: 'x' });
  b.upsert({ serial: B, deviceId: 'y' });
  assert.equal(b.remove(B).serial, B);
  assert.equal(b.last, A);
  b.remove(A);
  assert.equal(b.last, null);
  assert.deepEqual(b.list, []);
});

test('clearDeviceId keeps the battery', () => {
  const b = new Batteries(mem());
  b.upsert({ serial: A, deviceId: 'x' });
  b.clearDeviceId(A);
  assert.equal(b.get(A).deviceId, null);
  assert.equal(b.list.length, 1);
});

test('migrates the single device saved by the previous version', () => {
  const s = mem({ device: JSON.stringify({ id: 'old-id', name: 'ECOFLOW_BLE', serial: A }) });
  const b = new Batteries(s);
  assert.equal(b.list.length, 1);
  assert.deepEqual(b.get(A), { serial: A, deviceId: 'old-id', nickname: '' });
  assert.equal(b.last, A);
  assert.equal(s.m.has('device'), false); // legacy key removed
  assert.equal(new Batteries(s).list.length, 1); // and the migration persisted
});

test('corrupt or invalid stored data is ignored', () => {
  assert.equal(new Batteries(mem({ batteries: '{nope' })).list.length, 0);
  assert.equal(new Batteries(mem({ batteries: JSON.stringify({ v: 1, list: [{ serial: 'bad' }, { serial: A }], last: 'zzz' }) })).list.length, 1);
  assert.equal(new Batteries(mem({ batteries: JSON.stringify({ v: 1, list: [{ serial: A }], last: 'zzz' }) })).last, A);
  assert.throws(() => new Batteries(mem()).upsert({ serial: 'bad', deviceId: 'x' }));
});

test('connect notices: already saved, newly added, and wrong-battery cases', () => {
  const b = new Batteries(mem());
  b.upsert({ serial: A, deviceId: 'x' });
  b.rename(A, 'Garage');
  // Add pressed, picked a battery that is already saved
  assert.equal(connectNotice(b, null, A, true), 'That battery is already saved as Garage.');
  // Add pressed, picked a new battery (caller has already upserted it)
  b.upsert({ serial: B, deviceId: 'y' });
  assert.equal(connectNotice(b, null, B, false), 'Added Battery 1234. You can rename it under Advanced.');
  // tapped Garage but reached the other saved battery
  assert.equal(connectNotice(b, A, B, true), 'That device is Battery 1234, not Garage. Connected to Battery 1234.');
  // tapped Garage but reached a battery that was not saved yet
  assert.equal(connectNotice(b, A, B, false), 'That was a different battery, not Garage. Added it as Battery 1234.');
  // the expected battery: nothing to say
  assert.equal(connectNotice(b, A, A, true), '');
  // tapped a battery that has since been removed
  assert.match(connectNotice(b, 'GONE0000000000', B, true), /not the one you tapped/);
});
