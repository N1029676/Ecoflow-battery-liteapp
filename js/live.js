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
