// Which parts of the latest telemetry are too old to record. The unit answers each kind of packet (power, charge manager, every
// battery pack) separately. After the page has been frozen in the background (phone locked, tab hidden) the first packets to
// arrive are not necessarily all kinds: a power packet can show up while the battery packs still hold values from before the
// freeze. "A packet arrived recently" is therefore not enough to say "everything is current": each part is checked on its own.

/**
 * @param {{pd?:object, ems?:object, bms?:Record<string, object>}} state  latest decoded packet of each kind
 * @param {Record<string, number>} rxAt  when each part was last received: 'pd', 'ems', 'bms0', 'bms1', ...
 * @param {number} now
 * @param {number} maxAgeMs
 * @returns {string[]} the parts of the state that are missing or older than maxAgeMs (empty = all current)
 */
export function staleParts(state, rxAt, now, maxAgeMs = 5000) {
  const parts = ['pd'];
  if (state.ems) parts.push('ems');
  for (const n of Object.keys(state.bms ?? {})) parts.push(`bms${n}`);
  return parts.filter((k) => !(now - (rxAt[k] ?? -Infinity) <= maxAgeMs));
}
