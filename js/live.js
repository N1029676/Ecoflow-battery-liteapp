// Small formatting helpers for the live readout (pure, unit-tested).

export const fmtAge = (ms) => {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.floor(s)} s` : `${Math.floor(s / 60)} m ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
};

/**
 * Signal text for the readout. `signal` = { rssi, t, live } where `live` says the reading arrived while connected.
 * Chrome only reports signal strength from advertisements, and a battery that stops advertising once connected
 * leaves us with a reading from just before connecting: show it, but say so instead of presenting it as live.
 */
export function signalText(signal, now, staleMs) {
  if (!signal) return '';
  const weak = signal.rssi <= -85 ? ' (weak)' : '';
  if (now - signal.t <= staleMs) return `${signal.rssi} dBm${weak}`;
  return `${signal.rssi} dBm${weak} ${signal.live ? '(last seen)' : 'at connect'}`;
}
