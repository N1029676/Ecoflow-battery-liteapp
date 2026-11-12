// Rolling history of the key readings, kept in two tiers so a long window stays small:
//   fine   - one sample every `fineMs` (default 15 s) for the last `fineKeepMs` (6 h)
//   coarse - 5-minute averages of those samples for the last `coarseKeepMs` (14 days)
// Rows are [t, soc, inW, outW, tempC, soc0, soc1, soc2]; null = unknown. soc is the whole system; soc0 / soc1 / soc2 are the
// main battery and the first two extras, so each can be charted on its own. Version 1 rows (without the pack columns) are
// still read. Pure (no DOM/storage) so it is unit-testable.

import { cToF } from './units.js';

export const METRICS = ['soc', 'inW', 'outW', 'tempC', 'soc0', 'soc1', 'soc2'];
const LEGACY_LEN = 5; // t + the first four metrics
const round = { soc: 1, inW: 0, outW: 0, tempC: 0, soc0: 1, soc1: 1, soc2: 1 };
const r = (v, d) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export class History {
  constructor({ fineMs = 15000, fineKeepMs = 6 * 3600e3, coarseMs = 300e3, coarseKeepMs = 14 * 86400e3 } = {}) {
    Object.assign(this, { fineMs, fineKeepMs, coarseMs, coarseKeepMs });
    this.fine = [];
    this.coarse = [];
    this._acc = null; // running average for the current coarse bucket
  }

  /** Record a sample. Returns true if it was kept (i.e. the charts should redraw). */
  add(t, v) {
    if (v.soc == null) return false; // nothing meaningful to record yet
    const last = this.fine[this.fine.length - 1];
    if (last && t - last[0] < this.fineMs) return false;
    const row = [t, ...METRICS.map((k) => r(v[k], round[k]))];
    this.fine.push(row);
    this._accumulate(row);
    this._trim(t);
    return true;
  }

  _accumulate(row) {
    const bucket = Math.floor(row[0] / this.coarseMs) * this.coarseMs;
    if (this._acc && this._acc.bucket !== bucket) this._flush();
    this._acc ??= { bucket, sum: METRICS.map(() => 0), n: METRICS.map(() => 0) };
    METRICS.forEach((_, i) => { const x = row[i + 1]; if (x != null) { this._acc.sum[i] += x; this._acc.n[i]++; } });
  }

  _flush() {
    const a = this._acc;
    this._acc = null;
    if (!a) return;
    this.coarse.push([a.bucket + this.coarseMs / 2, ...METRICS.map((k, i) => (a.n[i] ? r(a.sum[i] / a.n[i], round[k]) : null))]);
  }

  _trim(now) {
    while (this.fine.length && this.fine[0][0] < now - this.fineKeepMs) this.fine.shift();
    while (this.coarse.length && this.coarse[0][0] < now - this.coarseKeepMs) this.coarse.shift();
  }

  /** Points for the last `rangeMs`, with the step between them (to detect gaps). */
  query(rangeMs, now = Date.now()) {
    const from = now - rangeMs;
    let rows, stepMs;
    if (rangeMs <= this.fineKeepMs) {
      rows = this.fine.filter((x) => x[0] >= from);
      stepMs = this.fineMs;
    } else {
      const lastCoarse = this.coarse.length ? this.coarse[this.coarse.length - 1][0] : -Infinity;
      rows = [...this.coarse.filter((x) => x[0] >= from), ...this.fine.filter((x) => x[0] > lastCoarse + this.coarseMs / 2 && x[0] >= from)];
      stepMs = this.coarseMs;
    }
    return { from, to: now, stepMs, points: rows.map((row) => Object.fromEntries([['t', row[0]], ...METRICS.map((k, i) => [k, row[i + 1]])])) };
  }

  clear() { this.fine = []; this.coarse = []; this._acc = null; }

  toJSON() { return { v: 2, fine: this.fine, coarse: this.coarse }; }

  static fromJSON(obj, opts) {
    const h = new History(opts);
    if ((obj?.v === 1 || obj?.v === 2) && Array.isArray(obj.fine) && Array.isArray(obj.coarse)) {
      const ok = (x) => Array.isArray(x) && (x.length === METRICS.length + 1 || x.length === LEGACY_LEN) && Number.isFinite(x[0]);
      const pad = (x) => (x.length === LEGACY_LEN ? [...x, ...Array(METRICS.length + 1 - LEGACY_LEN).fill(null)] : x);
      h.fine = obj.fine.filter(ok).map(pad);
      h.coarse = obj.coarse.filter(ok).map(pad);
      const last = h.fine[h.fine.length - 1];
      if (last) h._trim(last[0]);
    }
    return h;
  }
}

export function toCsv(points) {
  const lines = ['time,battery_percent,main_percent,extra1_percent,extra2_percent,input_w,output_w,temp_f'];
  for (const p of points) lines.push([new Date(p.t).toISOString(), p.soc, p.soc0, p.soc1, p.soc2, p.inW, p.outW, p.tempC == null ? null : Math.round(cToF(p.tempC) * 10) / 10].map((x) => x ?? '').join(','));
  return lines.join('\n') + '\n';
}
