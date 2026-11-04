// Time until charging completes (reaches the charge limit) or discharging ends (reaches the discharge limit).
//
// Estimated from the packs' own readings, not the unit's built-in "remaining time" fields (those looked unreliable in real captures:
// 266 hours while charging at 94 %). For each pack: energy still to move = (target % - soc %) x full capacity (Ah) x pack voltage;
// power = the sum of pack voltage x signed current (positive = charging). Time = energy / power. Packs charge one after another,
// so summing energy and dividing by total power is the right shape. The power is smoothed (exponential average, about 15 s) so
// that a flickering current does not make the estimate jump while still following a real change quickly. Charging slows near full (constant-voltage phase), so the estimate is
// optimistic for targets close to 100 %.

const MIN_POWER_W = 15;      // below this the battery counts as idle
export const MAX_MINUTES = 99 * 60;

/** packs: [{ soc, volts, amps, fullAh }] with amps signed (positive = charging). */
export function netPowerW(packs) {
  return packs.reduce((sum, p) => sum + p.volts * p.amps, 0);
}

/** Energy (Wh) still to move in the given direction until every pack reaches its target. */
export function energyWh(packs, mode, { chargeMax = 100, dischargeMin = 0 } = {}) {
  return packs.reduce((sum, p) => {
    const dPct = mode === 'charging' ? Math.min(chargeMax, 100) - p.soc : p.soc - Math.max(dischargeMin, 0);
    return sum + Math.max(0, dPct) / 100 * p.fullAh * p.volts;
  }, 0);
}

const usable = (p) => [p.soc, p.volts, p.amps, p.fullAh].every((v) => Number.isFinite(v)) && p.fullAh > 0 && p.volts > 0;

export class EtaEstimator {
  constructor({ tauMs = 15000 } = {}) { this.tauMs = tauMs; this.reset(); } // ~15 s: enough to calm a flickering current, quick to follow a real change
  reset() { this.ema = null; this.t = null; this.dir = 0; }

  /**
   * @param {number} now  ms timestamp
   * @param {object[]} packs  see netPowerW
   * @param {{chargeMax?:number, dischargeMin?:number}} limits
   * @returns {{mode:'charging'|'discharging'|'idle'|'unknown', minutes?:number, powerW?:number, targetPct?:number, done?:boolean, over?:boolean}}
   */
  update(now, packs, limits = {}) {
    if (!packs?.length || !packs.every(usable)) { this.reset(); return { mode: 'unknown' }; }
    const raw = netPowerW(packs), dir = Math.abs(raw) < MIN_POWER_W ? 0 : Math.sign(raw);
    if (dir === 0) { this.reset(); return { mode: 'idle' }; }
    if (dir !== this.dir || this.ema == null) { this.ema = raw; this.dir = dir; } // direction changed: start over
    else { const a = 1 - Math.exp(-Math.max(0, now - this.t) / this.tauMs); this.ema += a * (raw - this.ema); }
    this.t = now;
    const mode = dir > 0 ? 'charging' : 'discharging';
    const targetPct = mode === 'charging' ? Math.min(limits.chargeMax ?? 100, 100) : Math.max(limits.dischargeMin ?? 0, 0);
    const wh = energyWh(packs, mode, limits), power = Math.abs(this.ema);
    if (wh < 1) return { mode, powerW: power, targetPct, done: true };
    const minutes = (wh / power) * 60;
    return { mode, powerW: power, targetPct, minutes: Math.min(minutes, MAX_MINUTES), over: minutes > MAX_MINUTES };
  }
}

/** "45 m", "1 h 25 m", "12 h", "more than 99 h". */
export function fmtEta(minutes, over = false) {
  if (over) return 'more than 99 h';
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 10) return `${h + (r >= 30 ? 1 : 0)} h`; // beyond ten hours the minutes are noise
  return r === 0 ? `${h} h` : `${h} h ${String(r).padStart(2, '0')} m`;
}
