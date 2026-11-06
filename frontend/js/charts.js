// Gráficos SVG simples, sin librerías.
import { h } from './ui.js';
import { fmtQty } from './util.js';

/** Máximo "redondo" para el eje: 1, 2, 5 × 10^n por encima del valor. */
export function niceMax(value) {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (value <= m * exp) return m * exp;
  return 10 * exp;
}

const shorten = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Barras horizontales: [{ label, value }]. */
export function HBarChart({ items, ariaLabel }) {
  const rowH = 30;
  const labelW = 112;
  const width = 360;
  const barX = labelW + 8;
  const barMax = width - barX - 46;
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  const height = items.length * rowH + 8;

  return h(
    'svg',
    { className: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel },
    items.map((item, i) => {
      const y = i * rowH + 4;
      const w = Math.max(2, (item.value / max) * barMax);
      return h(
        'g',
        { key: item.label + i },
        h('text', { x: labelW, y: y + 18, textAnchor: 'end' }, shorten(item.label, 16)),
        h('rect', { className: 'bar-top', x: barX, y: y + 4, width: w, height: rowH - 10, rx: 4 }),
        h('text', { className: 'val', x: barX + w + 6, y: y + 18 }, fmtQty(item.value)),
      );
    }),
  );
}

/** Barras verticales agrupadas por período: [{ label, entradas, salidas }]. */
export function TrendChart({ points, ariaLabel }) {
  const width = 360;
  const height = 250;
  const left = 40;
  const right = 6;
  const top = 14;
  const bottom = 30;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max(...points.flatMap((p) => [p.entradas, p.salidas]), 0));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const slot = plotW / Math.max(points.length, 1);
  const barW = Math.min(22, (slot - 6) / 2);
  const y = (v) => top + plotH - (v / max) * plotH;
  const showValues = points.length <= 4; // con más barras los números se pisan: están en la tabla

  return h(
    'svg',
    { className: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel },
    ticks.map((t) =>
      h(
        'g',
        { key: t },
        h('line', { className: 'grid', x1: left, x2: width - right, y1: y(t), y2: y(t) }),
        h('text', { x: left - 6, y: y(t) + 4, textAnchor: 'end' }, fmtQty(Math.round(t * 10) / 10)),
      ),
    ),
    points.map((p, i) => {
      const cx = left + slot * i + slot / 2;
      const eh = (p.entradas / max) * plotH;
      const sh = (p.salidas / max) * plotH;
      return h(
        'g',
        { key: p.label + i },
        h('rect', { className: 'bar-e', x: cx - barW - 1, y: y(p.entradas), width: barW, height: Math.max(eh, p.entradas > 0 ? 1 : 0), rx: 3 }),
        h('rect', { className: 'bar-s', x: cx + 1, y: y(p.salidas), width: barW, height: Math.max(sh, p.salidas > 0 ? 1 : 0), rx: 3 }),
        showValues && p.entradas > 0 && h('text', { className: 'val', x: cx - barW / 2 - 1, y: y(p.entradas) - 4, textAnchor: 'middle' }, fmtQty(p.entradas)),
        showValues && p.salidas > 0 && h('text', { className: 'val', x: cx + barW / 2 + 1, y: y(p.salidas) - 4, textAnchor: 'middle' }, fmtQty(p.salidas)),
        h('text', { x: cx, y: height - 12, textAnchor: 'middle' }, p.label),
      );
    }),
  );
}

export function Legend() {
  return h('div', { className: 'legend' }, h('span', { className: 'e' }, h('i'), 'Entradas'), h('span', { className: 's' }, h('i'), 'Salidas'));
}
