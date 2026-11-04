import test from 'node:test';
import assert from 'node:assert/strict';
import { EtaEstimator, netPowerW, energyWh, fmtEta, MAX_MINUTES } from '../js/eta.js';

const pack = (soc, amps, volts = 50, fullAh = 80) => ({ soc, volts, amps, fullAh });
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} not within ${tol * 100}% of ${b}`);

test('net power: volts x signed current, summed over the packs', () => {
  assert.equal(netPowerW([pack(50, 10), pack(50, -4)]), 50 * 10 + 50 * -4);
  assert.equal(netPowerW([pack(50, 0)]), 0);
});

test('energy still to move: to the charge limit when charging, down to the discharge limit when discharging', () => {
  // 80 Ah x 50 V = 4000 Wh per pack
  near(energyWh([pack(75, 1)], 'charging'), 1000);                       // 25 % to 100 %
  near(energyWh([pack(75, 1)], 'charging', { chargeMax: 90 }), 600);     // 15 % to 90 %
  assert.equal(energyWh([pack(95, 1)], 'charging', { chargeMax: 90 }), 0); // already above the limit
  near(energyWh([pack(40, -1)], 'discharging', { dischargeMin: 10 }), 1200);
  near(energyWh([pack(60, 1), pack(80, 1)], 'charging'), 1600 + 800);   // packs add up
});

test('charging: energy still needed / present power (single pack)', () => {
  const e = new EtaEstimator();
  const r = e.update(0, [pack(88, 15, 52, 80)]); // 12 % of 80 Ah = 9.6 Ah at 15 A
  assert.equal(r.mode, 'charging');
  assert.equal(r.targetPct, 100);
  near(r.minutes, 9.6 / 15 * 60, 0.001); // 38.4 min
  near(r.powerW, 780, 0.001);
});

test('packs charge one after another: the second pack\'s energy is added to the first\'s', () => {
  const r = new EtaEstimator().update(0, [pack(90, 10), pack(50, 0)]); // only the first pack draws current right now
  // energy: 10 % + 50 % of 4000 Wh = 2400 Wh, power 500 W -> 4.8 h
  near(r.minutes, 4.8 * 60, 0.001);
});

test('charging stops at the charge limit', () => {
  const r = new EtaEstimator().update(0, [pack(80, 10)], { chargeMax: 90 });
  assert.equal(r.targetPct, 90);
  near(r.minutes, 400 / 500 * 60, 0.001); // 10 % of 4000 Wh at 500 W
  const done = new EtaEstimator().update(0, [pack(91, 10)], { chargeMax: 90 });
  assert.equal(done.done, true);
  assert.equal(done.minutes, undefined);
});

test('discharging: time until the discharge limit', () => {
  const r = new EtaEstimator().update(0, [pack(40, -8)], { dischargeMin: 10 }); // 30 % = 1200 Wh at 400 W
  assert.equal(r.mode, 'discharging');
  assert.equal(r.targetPct, 10);
  near(r.minutes, 3 * 60, 0.001);
});

test('idle (negligible power) and unusable data give no estimate', () => {
  assert.equal(new EtaEstimator().update(0, [pack(50, 0.1)]).mode, 'idle'); // 5 W
  assert.equal(new EtaEstimator().update(0, []).mode, 'unknown');
  assert.equal(new EtaEstimator().update(0, [{ soc: 50, volts: 50, amps: NaN, fullAh: 80 }]).mode, 'unknown');
  assert.equal(new EtaEstimator().update(0, [{ soc: 50, volts: 50, amps: 5, fullAh: 0 }]).mode, 'unknown');
});

test('the power is smoothed over about a minute, so a flicker does not move the estimate much', () => {
  const e = new EtaEstimator({ tauMs: 60000 });
  e.update(0, [pack(50, 10)]);
  const spike = e.update(1000, [pack(50, 30)]); // 3x current for one second
  assert.ok(spike.powerW < 500 * 1.1, `smoothed power ${spike.powerW}`);
  let last;
  for (let t = 2000; t <= 300000; t += 1000) last = e.update(t, [pack(50, 30)]); // sustained: converges
  near(last.powerW, 1500, 0.02);
});

test('a change of direction restarts the average instead of blending charge and discharge', () => {
  const e = new EtaEstimator();
  for (let t = 0; t <= 60000; t += 1000) e.update(t, [pack(50, 10)]);
  const flip = e.update(61000, [pack(50, -10)]);
  assert.equal(flip.mode, 'discharging');
  near(flip.powerW, 500, 0.001);
});

test('very long estimates are capped at 99 h', () => {
  const r = new EtaEstimator().update(0, [pack(0, 0.4)]); // 20 W into a 4 kWh pack
  assert.equal(r.minutes, MAX_MINUTES);
  assert.equal(r.over, true);
});

test('duration formatting', () => {
  assert.equal(fmtEta(0.2), '1 m');
  assert.equal(fmtEta(38.4), '38 m');
  assert.equal(fmtEta(60), '1 h');
  assert.equal(fmtEta(85), '1 h 25 m');
  assert.equal(fmtEta(125), '2 h 05 m');
  assert.equal(fmtEta(9 * 60 + 59), '9 h 59 m');
  assert.equal(fmtEta(12 * 60 + 20), '12 h');
  assert.equal(fmtEta(12 * 60 + 40), '13 h');
  assert.equal(fmtEta(MAX_MINUTES, true), 'more than 99 h');
});

test('default smoothing follows a real change within about half a minute', () => {
  const e = new EtaEstimator(); // default time constant
  for (let t = 0; t <= 10000; t += 1000) e.update(t, [pack(50, 10)]); // 500 W
  let r;
  for (let t = 11000; t <= 41000; t += 1000) r = e.update(t, [pack(50, 20)]); // steps to 1000 W and stays
  // two time constants (30 s) cover 86.5 % of a step: 500 + 0.865 x 500 = about 933 W. The old one-minute window would only reach ~696 W.
  assert.ok(r.powerW > 920 && r.powerW < 1000, `after 30 s the smoothed power is ${r.powerW} W`);
});
