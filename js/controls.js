// Write commands for the Delta Pro (reverse-engineered by the community; see NOTICE). Pure helpers: build the
// packet fields, validate user input, and decide whether the battery's telemetry confirms a change.
// All commands go to cmd_set 0x20 from src 0x21 (the app), exactly like the community driver's config commands.

/** Ranges offered by the UI. Charge limit 50-100 %, discharge limit 0-30 % (as in the EcoFlow app; not verified on hardware). */
export const LIMITS = {
  chargeMin: 50, chargeMax: 100, dischargeMin: 0, dischargeMax: 30,
  acChargeMin: 200, acChargeDefaultMax: 1800, // watts; the unit's rated maximum is used when it reports one
  dcChargeMinA: 4, dcChargeMaxA: 8,           // amps (DC / car input)
};

/** The values offered as buttons. Every entry is valid for its setting (see the tests); the unit's rated maximum can disable some. */
export const OPTIONS = {
  charge: [50, 80, 90, 95, 100],                          // %
  discharge: [0, 5, 10, 20, 30],                          // %
  acw: [200, 400, 600, 800, 1000, 1200, 1400, 1800],      // W
  dca: [4, 5, 6, 7, 8],                                   // A
};

const FF = 0xff; // "leave this field unchanged"

/**
 * Pause / resume charging from the AC input while it stays plugged in. Same command as the AC charging power (0x45, src 0x20,
 * 5 bytes) with the last byte set: 1 = paused, 0 = charging; FF = leave unchanged. Taken from the Delta 2 Max driver; the Delta Pro
 * uses the same command address and byte layout and reports the state in the same inverter field (cfgPauseFlag).
 */
export const cmdAcCharging = (enabled) => ({ src: 0x20, dst: 0x04, cmdSet: 0x20, cmdId: 0x45, payload: Uint8Array.of(FF, FF, FF, FF, enabled ? 0 : 1) });

/** AC outlets on/off: inverter (dst 0x04), id 0x42, [on, FF x6]. */
export const cmdAcOutput = (on) => ({ dst: 0x04, cmdSet: 0x20, cmdId: 0x42, payload: Uint8Array.of(on ? 1 : 0, FF, FF, FF, FF, FF, FF) });
/** Stop charging at this percentage: EMS (dst 0x03), id 0x31, one byte. */
export const cmdChargeLimit = (pct) => ({ dst: 0x03, cmdSet: 0x20, cmdId: 0x31, payload: Uint8Array.of(pct) });
/** Stop discharging at this percentage: EMS (dst 0x03), id 0x33, one byte. */
export const cmdDischargeLimit = (pct) => ({ dst: 0x03, cmdSet: 0x20, cmdId: 0x33, payload: Uint8Array.of(pct) });

/**
 * AC charging power in watts: inverter (dst 0x04), id 0x45, [FF, FF, watts (u16 LE), FF]. The community driver sends this one
 * with src 0x20 rather than the usual 0x21, so we do the same.
 */
export const cmdAcChargePower = (watts) => ({ src: 0x20, dst: 0x04, cmdSet: 0x20, cmdId: 0x45, payload: Uint8Array.of(FF, FF, watts & 0xff, (watts >> 8) & 0xff, FF) });
/**
 * DC (car) charging current: MPPT (dst 0x05), id 0x47, milliamps as u32 LE. The Delta Pro driver passes the raw amp value, but the
 * battery reports this setting in milliamps (6000 = 6 A) and the River 2 driver, which uses the same command, sends amps x 1000.
 */
export const cmdDcChargeCurrent = (amps, dst = 0x05) => {
  const ma = Math.round(amps * 1000);
  return { dst, cmdSet: 0x20, cmdId: 0x47, payload: Uint8Array.of(ma & 0xff, (ma >> 8) & 0xff, (ma >> 16) & 0xff, (ma >>> 24) & 0xff) };
};

/** Highest AC charging power: the unit's rated figure when it reports a sensible one, else the 1800 W default (as the community driver does). */
export const acChargeMax = (rated) => (rated > 200 ? rated : LIMITS.acChargeDefaultMax);

/** Returns an error message for an invalid value, or null if it may be sent. `raw` is the text from the input. */
export function validateLimit(kind, raw) {
  const label = kind === 'charge' ? 'Charge limit' : 'Discharge limit';
  const [lo, hi] = kind === 'charge' ? [LIMITS.chargeMin, LIMITS.chargeMax] : [LIMITS.dischargeMin, LIMITS.dischargeMax];
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return `${label} must be a whole number from ${lo} to ${hi}.`;
  const n = Number(s);
  if (n < lo || n > hi) return `${label} must be from ${lo} to ${hi}%.`;
  return null;
}

/** A discharge limit at or above the current charge makes the battery stop its output right away. */
export const dischargeLimitStopsOutput = (limit, soc) => soc != null && limit >= soc;

/** Does the battery's reported state show the change? `state` = the page's latest decoded messages { ems, inv, mppt }. */
export function confirmed(kind, want, state) {
  if (kind === 'ac') return state.inv?.cfgAcEnabled === (want ? 1 : 0);
  if (kind === 'accharge') return state.inv?.cfgPauseFlag === (want ? 0 : 1); // want = charging enabled
  if (kind === 'charge') return state.ems?.maxChargeSoc === want;
  if (kind === 'discharge') return state.ems?.minDsgSoc === want;
  if (kind === 'acw') return state.inv?.cfgSlowChgWatts === want;
  if (kind === 'dca') return state.mppt?.cfgDcChgCurrent === Math.round(want * 1000);
  return false;
}

export function validateAcChargePower(raw, max = LIMITS.acChargeDefaultMax) {
  const t = String(raw ?? '').trim();
  if (!/^\d+$/.test(t)) return `AC charging power must be a whole number of watts from ${LIMITS.acChargeMin} to ${max}.`;
  const n = Number(t);
  return n < LIMITS.acChargeMin || n > max ? `AC charging power must be from ${LIMITS.acChargeMin} to ${max} W.` : null;
}

export function validateDcChargeCurrent(raw) {
  const t = String(raw ?? '').trim();
  if (!/^\d+$/.test(t)) return `DC charging current must be a whole number of amps from ${LIMITS.dcChargeMinA} to ${LIMITS.dcChargeMaxA}.`;
  const n = Number(t);
  return n < LIMITS.dcChargeMinA || n > LIMITS.dcChargeMaxA ? `DC charging current must be from ${LIMITS.dcChargeMinA} to ${LIMITS.dcChargeMaxA} A.` : null;
}
