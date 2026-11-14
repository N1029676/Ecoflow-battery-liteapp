// Small formatting helpers for the live readout (pure, unit-tested).

export const fmtAge = (ms) => {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.floor(s)} s` : `${Math.floor(s / 60)} m ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
};

/** Signal text, e.g. "-82 dBm" or "-88 dBm (weak)". `signal` = { rssi }. */
export function signalText(signal) {
  if (!signal) return '';
  return `${signal.rssi} dBm${signal.rssi <= -85 ? ' (weak)' : ''}`;
}

/** What to suggest after failed connection attempts (empty for the first one). `signal` = { rssi } or null. */
export function connectHint(attempt, signal) {
  const parts = [];
  if (signal && signal.rssi <= -85) parts.push(`The signal is weak (${signal.rssi} dBm): move the phone closer to the battery.`);
  if (attempt >= 2) parts.push('Make sure no other phone or the EcoFlow app is connected to it (it accepts one connection at a time).');
  return parts.join(' ');
}

/**
 * Sorts a failed connection attempt. "No accessible GATT service" means the browser listed no services: that is what a lost
 * permission looks like, but also what a weak or dropped link looks like (Chrome says "No Services found in device").
 * So it only counts as lost permission when it keeps happening (`attempt` = failed attempts so far).
 * @returns {{kind: 'permission'|'noservices'|'other', text: string}}
 */
export function classifyConnectError(message, { knownBattery = false, attempt = 0 } = {}) {
  const noServices = /No accessible GATT/i.test(message);
  if (/No Services matching|NotAllowed|not allowed|SecurityError/i.test(message) || (noServices && attempt >= 4)) return { kind: 'permission', text: message };
  if (noServices && knownBattery) return { kind: 'noservices', text: 'The battery returned no services (weak signal or the link dropped)' };
  return { kind: 'other', text: message };
}
