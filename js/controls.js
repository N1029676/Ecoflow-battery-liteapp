// Write commands for the Delta Pro (reverse-engineered by the community; see NOTICE). Pure helpers: build the
// packet fields, validate user input, and decide whether the battery's telemetry confirms a change.
// All commands go to cmd_set 0x20 from src 0x21 (the app), exactly like the community driver's config commands.

/** Ranges offered by the UI. Charge limit 50-100 %, discharge limit 0-30 % (as in the EcoFlow app; not verified on hardware). */
export const LIMITS = { chargeMin: 50, chargeMax: 100, dischargeMin: 0, dischargeMax: 30 };

const FF = 0xff; // "leave this field unchanged"

/** AC outlets on/off: inverter (dst 0x04), id 0x42, [on, FF x6]. */
export const cmdAcOutput = (on) => ({ dst: 0x04, cmdSet: 0x20, cmdId: 0x42, payload: Uint8Array.of(on ? 1 : 0, FF, FF, FF, FF, FF, FF) });
/** Stop charging at this percentage: EMS (dst 0x03), id 0x31, one byte. */
export const cmdChargeLimit = (pct) => ({ dst: 0x03, cmdSet: 0x20, cmdId: 0x31, payload: Uint8Array.of(pct) });
/** Stop discharging at this percentage: EMS (dst 0x03), id 0x33, one byte. */
export const cmdDischargeLimit = (pct) => ({ dst: 0x03, cmdSet: 0x20, cmdId: 0x33, payload: Uint8Array.of(pct) });

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

/** Does the battery's reported state show the change? `state` = the page's latest decoded messages { ems, inv }. */
export function confirmed(kind, want, state) {
  if (kind === 'ac') return state.inv?.cfgAcEnabled === (want ? 1 : 0);
  if (kind === 'charge') return state.ems?.maxChargeSoc === want;
  if (kind === 'discharge') return state.ems?.minDsgSoc === want;
  return false;
}
