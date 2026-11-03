// State-of-charge bar: a battery outline holding 20 whole segments (5 % steps). Green, yellow at or below 25 %,
// red at or below 10 %. While charging, the last lit segment pulses slowly. Colour is never the only
// signal: low/critical also show an icon + label, and the whole bar has a text alternative.

export const SEGMENTS = 20;
export const LOW_PCT = 25, CRITICAL_PCT = 10;

export const socLevel = (soc) => (soc == null ? 'unknown' : soc <= CRITICAL_PCT ? 'critical' : soc <= LOW_PCT ? 'low' : 'ok');

/**
 * Number of lit segments: the nearest 5 % step, but never "empty" while there is charge and never "full"
 * until the battery really is at 100 %.
 */
export function litSegments(soc, n = SEGMENTS) {
  if (soc == null || soc <= 0) return 0;
  if (soc >= 100) return n;
  return Math.min(n - 1, Math.max(1, Math.round(soc / (100 / n))));
}

/** Index of the last lit segment (the one that pulses while charging), or -1 when none are lit. */
export const leadIndex = (soc, n = SEGMENTS) => litSegments(soc, n) - 1;

const LEVEL_TEXT = { critical: '⚠ Critical', low: '⚠ Low', ok: '', unknown: '' };
const FLOW_TEXT = { charging: '⚡ Charging', discharging: 'Discharging', idle: 'Idle' };

/**
 * Creates a bar inside `root` and returns { update }. Elements are created once and updated in place,
 * so the CSS pulse animation is not restarted by every data refresh.
 * @param {HTMLElement} root
 * @param {{compact?: boolean}} [opts]
 */
export function createSocBar(root, { compact = false } = {}) {
  root.classList.add('soc');
  if (compact) root.classList.add('compact');
  root.innerHTML = '<div class="soc-info"><span class="soc-pct"></span><span class="soc-flow"></span><span class="soc-warn"></span></div>' +
    '<div class="soc-bar" role="img"><div class="soc-segs"></div></div>';
  const pct = root.querySelector('.soc-pct'), flow = root.querySelector('.soc-flow'), warn = root.querySelector('.soc-warn');
  const bar = root.querySelector('.soc-bar'), wrap = root.querySelector('.soc-segs');
  const fills = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    const fill = document.createElement('i');
    seg.append(fill);
    wrap.append(seg);
    fills.push({ seg, fill });
  }
  let last = '';
  return {
    /** @param {{soc:number|null, flow?: 'charging'|'discharging'|'idle'|null, label?: string}} s */
    update({ soc, flow: f = null, label = 'Battery' }) {
      const key = `${soc}|${f}|${label}`;
      if (key === last) return;
      last = key;
      const level = socLevel(soc), lit = litSegments(soc);
      root.dataset.level = level;
      pct.textContent = soc == null ? '—' : `${soc.toFixed(1)}%`;
      flow.textContent = f ? FLOW_TEXT[f] : '';
      warn.textContent = LEVEL_TEXT[level];
      fills.forEach(({ seg, fill }, i) => {
        fill.style.width = i < lit ? '100%' : '0%';
        seg.classList.toggle('pulse', f === 'charging' && i === lit - 1);
      });
      bar.setAttribute('aria-label', soc == null ? `${label}: unknown` :
        `${label}: ${soc.toFixed(1)} percent${f ? `, ${f}` : ''}${level === 'low' ? ', low' : level === 'critical' ? ', critically low' : ''}`);
    },
  };
}
