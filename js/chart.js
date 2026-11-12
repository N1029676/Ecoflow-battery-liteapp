// Small dependency-free line chart on <canvas>: gap-aware 2px lines, recessive grid, crosshair +
// one tooltip listing every series, legend for 2+ series (no labels on the lines themselves), keyboard stepping, empty state.
// Colors come from CSS custom properties so light/dark follow the page.

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (t) => { const d = new Date(t); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
export const fullTime = (t) => `${dayLabel(t)} ${hhmm(t)}`;

export function niceStep(range, target = 4) {
  const raw = range / target, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

const STEPS = [5, 10, 15, 30].map((m) => m * 60e3).concat([1, 2, 3, 6, 12, 24, 48, 96].map((h) => h * 3600e3));
export function timeTicks(t0, t1, maxTicks = 6) {
  const span = t1 - t0;
  const step = STEPS.find((s) => span / s <= maxTicks) ?? STEPS[STEPS.length - 1];
  const off = -new Date(t0).getTimezoneOffset() * 60e3; // align to local clock
  const ticks = [];
  for (let t = Math.ceil((t0 + off) / step) * step - off; t <= t1; t += step) ticks.push(t);
  return ticks;
}

export class LineChart {
  /**
   * @param {HTMLElement} root
   * @param {{title:string, series:{key:string,label:string,color:string}[], unit:string, decimals?:number,
   *          yMin?:number, yMax?:number, minSpan?:number, id:string}} cfg
   */
  constructor(root, cfg) {
    this.cfg = { decimals: 0, ...cfg };
    this.allSeries = cfg.series; // with hideEmptySeries, cfg.series holds only the ones that currently have data
    this.data = { points: [], from: 0, to: 1, stepMs: 15000 };
    this.hover = null;
    root.classList.add('chart');
    const head = document.createElement('div');
    head.className = 'chart-head';
    const h = document.createElement('h3');
    h.textContent = cfg.title;
    head.append(h);
    this.head = head;
    this._legendFor = null;
    this._legend();
    this.plot = document.createElement('div');
    this.plot.className = 'plot';
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.plot.append(this.canvas, this.tip);
    root.append(head, this.plot);

    new ResizeObserver(() => this.draw()).observe(this.plot);
    const at = (ev) => this._nearest(ev.clientX - this.canvas.getBoundingClientRect().left);
    this.canvas.addEventListener('pointermove', (ev) => { this.hover = at(ev); this.draw(); });
    this.canvas.addEventListener('pointerdown', (ev) => { this.hover = at(ev); this.draw(); });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.canvas.addEventListener('blur', () => { this.hover = null; this.draw(); });
    this.canvas.addEventListener('keydown', (ev) => {
      const n = this.data.points.length;
      if (!n || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      ev.preventDefault();
      const cur = this.hover ?? n - 1;
      this.hover = ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : Math.min(n - 1, Math.max(0, cur + (ev.key === 'ArrowRight' ? 1 : -1)));
      this.draw();
    });
  }

  /** The legend lists the visible series; a single series needs none (the title names it). */
  _legend() {
    const key = this.cfg.series.map((s) => s.key).join();
    if (key === this._legendFor) return;
    this._legendFor = key;
    this.head.querySelector('.legend')?.remove();
    if (this.cfg.series.length < 2) return;
    const lg = document.createElement('div');
    lg.className = 'legend';
    for (const s of this.cfg.series) {
      const i = document.createElement('span');
      const k = document.createElement('i');
      k.style.background = `var(${s.color})`;
      i.append(k, document.createTextNode(s.label));
      lg.append(i);
    }
    this.head.append(lg);
  }

  /** Replace the data. A hovered/focused position is kept (matched by time), so a new reading does not close a tooltip being read. */
  setData(data) {
    const t = this.hover != null ? this.data.points[this.hover]?.t : null;
    this.data = data;
    if (this.cfg.hideEmptySeries) {
      const live = this.allSeries.filter((s) => data.points.some((p) => p[s.key] != null));
      this.cfg.series = live.length ? live : this.allSeries.slice(0, 1);
      this._legend();
    }
    this.hover = null;
    if (t != null && data.points.length) {
      let best = 0, bd = Infinity;
      data.points.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = i; } });
      this.hover = best;
    }
    this.draw();
  }

  _geom() {
    const w = Math.max(120, this.plot.clientWidth), h = 170;
    return { w, h, l: 40, r: 10, t: 10, b: 22 };
  }

  _yRange() {
    const { yMin, yMax, minSpan = 1 } = this.cfg;
    const vals = this.data.points.flatMap((p) => this.cfg.series.map((s) => p[s.key])).filter((v) => v != null);
    let lo = yMin ?? (vals.length ? Math.min(...vals) : 0), hi = yMax ?? (vals.length ? Math.max(...vals) : 1);
    if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    const step = niceStep(hi - lo);
    if (yMin == null) lo = Math.floor(lo / step) * step;
    if (yMax == null) hi = Math.ceil(hi / step) * step;
    return { lo, hi, step };
  }

  _nearest(px) {
    const { l, r, w } = this._geom();
    const { points, from, to } = this.data;
    if (!points.length) return null;
    const t = from + ((px - l) / (w - l - r)) * (to - from);
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  draw() {
    const { w, h, l, r, t, b } = this._geom();
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = `${w}px`; c.style.height = `${h}px`;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const surface = cssVar('--chart-bg'), grid = cssVar('--chart-grid'), muted = cssVar('--text-muted');
    const { points, from, to, stepMs } = this.data;
    const pw = w - l - r, ph = h - t - b;
    const X = (tt) => l + ((tt - from) / (to - from)) * pw;
    const { lo, hi, step } = this._yRange();
    const Y = (v) => t + ph - ((v - lo) / (hi - lo)) * ph;
    const dec = this.cfg.decimals;

    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    g.lineWidth = 1;
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) { // recessive horizontal grid
      const y = Math.round(Y(v)) + 0.5;
      g.strokeStyle = grid; g.beginPath(); g.moveTo(l, y); g.lineTo(w - r, y); g.stroke();
      g.fillStyle = muted; g.fillText(String(Number(v.toFixed(dec))), l - 6, y);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const multiDay = to - from > 30 * 3600e3;
    for (const tk of timeTicks(from, to, Math.max(2, Math.floor(pw / 80)))) {
      g.fillStyle = muted;
      g.fillText(multiDay ? dayLabel(tk) : hhmm(tk), X(tk), h - b + 6);
    }

    if (!points.length) {
      g.fillStyle = muted; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('No data yet. Connect to start recording.', l + pw / 2, t + ph / 2);
      this.canvas.setAttribute('aria-label', `${this.cfg.title}: no data yet`);
      this.tip.hidden = true;
      return;
    }

    for (const s of this.cfg.series) {
      const color = cssVar(s.color);
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
      let seg = [];
      const flush = () => {
        if (seg.length === 1) { g.beginPath(); g.arc(seg[0][0], seg[0][1], 2.5, 0, 6.3); g.fill(); }
        else if (seg.length > 1) { g.beginPath(); seg.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); }
        seg = [];
      };
      let prev = null;
      for (const p of points) {
        const v = p[s.key];
        if (v == null || (prev && p.t - prev.t > stepMs * 4)) flush(); // gaps break the line
        if (v != null) { seg.push([X(p.t), Y(v)]); prev = p; } else prev = null;
      }
      flush();
    }

    if (this.hover != null && points[this.hover]) {
      const p = points[this.hover], x = Math.round(X(p.t)) + 0.5;
      g.strokeStyle = muted; g.lineWidth = 1; g.beginPath(); g.moveTo(x, t); g.lineTo(x, t + ph); g.stroke();
      for (const s of this.cfg.series) {
        if (p[s.key] == null) continue;
        g.beginPath(); g.arc(X(p.t), Y(p[s.key]), 5, 0, 6.3); g.fillStyle = surface; g.fill(); // 2px surface ring
        g.beginPath(); g.arc(X(p.t), Y(p[s.key]), 4, 0, 6.3); g.fillStyle = cssVar(s.color); g.fill();
      }
      this._showTip(p, X(p.t), t);
    } else this.tip.hidden = true;

    const latest = points[points.length - 1];
    this.canvas.setAttribute('aria-label', `${this.cfg.title}. Latest ${this.cfg.series.map((s) => `${s.label} ${latest[s.key] ?? 'unknown'}${this.cfg.unit}`).join(', ')}. Use left and right arrow keys to step through readings.`);
  }

  _showTip(p, x, y) {
    const tip = this.tip;
    tip.replaceChildren();
    const when = document.createElement('div');
    when.className = 'tip-time';
    when.textContent = fullTime(p.t);
    tip.append(when);
    for (const s of this.cfg.series) { // values lead, labels follow
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('i'); key.style.background = `var(${s.color})`;
      const v = document.createElement('b');
      v.textContent = p[s.key] == null ? '—' : `${Number(p[s.key]).toFixed(this.cfg.decimals)}${this.cfg.unit}`;
      const l = document.createElement('span'); l.textContent = s.label;
      row.append(key, v, l);
      tip.append(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth, pw = this.plot.clientWidth;
    tip.style.left = `${x + 12 + tw > pw ? Math.max(0, x - 12 - tw) : x + 12}px`;
    tip.style.top = `${y}px`;
  }
}
