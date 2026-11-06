import { h, useState, useEffect, Banner, Spinner, EmptyState, Fragment, errorText } from '../ui.js';
import { api } from '../api.js';
import { fmtQty, fmtShortDate } from '../util.js';
import { HBarChart, TrendChart, Legend } from '../charts.js';

const TABS = [
  ['summary', 'Resumen'],
  ['top', 'Más vendidos'],
  ['trend', 'Tendencia'],
  ['compare', 'Comparar'],
];

const weekLabel = (w) => `${fmtShortDate(w.startDate)} al ${fmtShortDate(addSat(w.startDate))}${w.status === 'open' ? ' (actual)' : ''}`;
function addSat(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 5);
  return d.toISOString().slice(0, 10);
}

/** Pide datos al cargar y cada vez que cambian las dependencias. */
function useReport(path, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, error: '' });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: '' }));
    api('GET', path)
      .then((data) => !cancelled && setState({ data, loading: false, error: '' }))
      .catch((err) => !cancelled && setState({ data: null, loading: false, error: err.isNetwork ? 'Sin conexión: los reportes necesitan internet.' : errorText(err) }));
    return () => {
      cancelled = true;
    };
  }, deps);
  return state;
}

function Kpis({ entradas, salidas }) {
  return h(
    'div',
    { className: 'kpis' },
    h('div', { className: 'kpi entrada' }, h('div', { className: 'label' }, 'Entradas'), h('div', { className: 'value' }, fmtQty(entradas))),
    h('div', { className: 'kpi salida' }, h('div', { className: 'label' }, 'Salidas'), h('div', { className: 'value' }, fmtQty(salidas))),
  );
}

function Result({ state, children }) {
  if (state.loading) return h(Spinner, null);
  if (state.error) return h(Banner, { kind: 'error' }, state.error);
  if (!state.data) return null;
  return children(state.data);
}

function SummaryTab({ weeks, weekId, setWeekId }) {
  const state = useReport(weekId ? `/reports/week-summary?weekId=${weekId}` : null, [weekId]);
  return h(
    Fragment,
    null,
    h(WeekSelect, { label: 'Semana', weeks, value: weekId, onChange: setWeekId }),
    h(Result, { state }, (d) =>
      h(
        Fragment,
        null,
        h(Kpis, d.totals),
        d.groups.length === 0
          ? h(EmptyState, null, 'No hay datos en esta semana.')
          : h(
              'div',
              { className: 'table-wrap' },
              h(
                'table',
                null,
                h('thead', null, h('tr', null, h('th', null, 'Producto'), h('th', { className: 'r' }, 'Inicial'), h('th', { className: 'r' }, 'Entradas'), h('th', { className: 'r' }, 'Salidas'), h('th', { className: 'r' }, 'Final'))),
                h(
                  'tbody',
                  null,
                  d.groups.flatMap((g) => [
                    h('tr', { key: `g${g.id}`, className: 'group-row' }, h('td', null, g.name), h('td', { className: 'r' }, ''), h('td', { className: 'r' }, fmtQty(g.entradas)), h('td', { className: 'r' }, fmtQty(g.salidas)), h('td', { className: 'r' }, '')),
                    ...g.products.map((p) =>
                      h('tr', { key: p.id }, h('td', null, `${p.name} (${p.code})`), h('td', { className: 'r' }, fmtQty(p.initial)), h('td', { className: 'r' }, fmtQty(p.entradas)), h('td', { className: 'r' }, fmtQty(p.salidas)), h('td', { className: 'r' }, fmtQty(p.final))),
                    ),
                  ]),
                ),
              ),
            ),
      ),
    ),
  );
}

function WeekSelect({ label, weeks, value, onChange }) {
  return h(
    'div',
    { className: 'toolbar' },
    h('label', { className: 'form-label', htmlFor: `ws-${label}` }, label),
    h('select', { id: `ws-${label}`, value: value || '', onChange: (e) => onChange(Number(e.target.value)) }, weeks.map((w) => h('option', { key: w.id, value: w.id }, weekLabel(w)))),
  );
}

function PeriodSelect({ value, onChange, options, label = 'Período' }) {
  return h(
    'div',
    { className: 'toolbar' },
    h('label', { className: 'form-label', htmlFor: `ps-${label}` }, label),
    h('select', { id: `ps-${label}`, value, onChange: (e) => onChange(Number(e.target.value)) }, options.map(([v, text]) => h('option', { key: v, value: v }, text))),
  );
}

function TopTab({ scope }) {
  const [weeks, setWeeks] = useState(4);
  const state = useReport(`/reports/top-products?weeks=${weeks}&limit=10${scope ? `&branchId=${scope}` : ''}`, [weeks, scope]);
  return h(
    Fragment,
    null,
    h(PeriodSelect, { value: weeks, onChange: setWeeks, options: [[1, 'Esta semana'], [4, 'Últimas 4 semanas'], [8, 'Últimas 8 semanas'], [12, 'Últimas 12 semanas']] }),
    h(Result, { state }, (d) =>
      d.products.length === 0
        ? h(EmptyState, null, 'Todavía no hay salidas registradas en este período.')
        : h(
            Fragment,
            null,
            h('div', { className: 'card' }, h(HBarChart, { items: d.products.map((p) => ({ label: p.name, value: p.salidas })), ariaLabel: 'Productos con más salidas' })),
            h(
              'div',
              { className: 'table-wrap' },
              h(
                'table',
                null,
                h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Producto'), h('th', { className: 'r' }, 'Salidas'), h('th', { className: 'r' }, 'Entradas'))),
                h('tbody', null, d.products.map((p, i) => h('tr', { key: p.productId }, h('td', null, i + 1), h('td', null, `${p.name} (${p.code})`), h('td', { className: 'r' }, fmtQty(p.salidas)), h('td', { className: 'r' }, fmtQty(p.entradas))))),
              ),
            ),
          ),
    ),
  );
}

function TrendTab({ scope }) {
  const [weeks, setWeeks] = useState(8);
  const state = useReport(`/reports/trend?weeks=${weeks}${scope ? `&branchId=${scope}` : ''}`, [weeks, scope]);
  return h(
    Fragment,
    null,
    h(PeriodSelect, { value: weeks, onChange: setWeeks, options: [[4, 'Últimas 4 semanas'], [8, 'Últimas 8 semanas'], [12, 'Últimas 12 semanas'], [26, 'Últimas 26 semanas']] }),
    h(Result, { state }, (d) => {
      const points = d.weeks.map((w) => ({ label: fmtShortDate(w.startDate), entradas: w.entradas, salidas: w.salidas }));
      const any = points.some((p) => p.entradas > 0 || p.salidas > 0);
      if (!any) return h(EmptyState, null, 'Todavía no hay movimientos en este período.');
      return h(
        Fragment,
        null,
        h('div', { className: 'card' }, h(Legend, null), h(TrendChart, { points, ariaLabel: 'Entradas y salidas por semana' })),
        h(
          'div',
          { className: 'table-wrap' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, h('th', null, 'Semana desde'), h('th', { className: 'r' }, 'Entradas'), h('th', { className: 'r' }, 'Salidas'))),
            h('tbody', null, d.weeks.map((w) => h('tr', { key: w.startDate }, h('td', null, fmtShortDate(w.startDate)), h('td', { className: 'r' }, fmtQty(w.entradas)), h('td', { className: 'r' }, fmtQty(w.salidas))))),
          ),
        ),
      );
    }),
  );
}

function CompareTab({ weeks }) {
  const [b, setB] = useState(weeks[0]?.id || null);
  const [a, setA] = useState(weeks[1]?.id || weeks[0]?.id || null);
  const state = useReport(a && b ? `/reports/compare-weeks?a=${a}&b=${b}` : null, [a, b]);
  if (weeks.length < 2) return h(EmptyState, null, 'Hacen falta al menos dos semanas para comparar.');
  return h(
    Fragment,
    null,
    h(WeekSelect, { label: 'Semana A', weeks, value: a, onChange: setA }),
    h(WeekSelect, { label: 'Semana B', weeks, value: b, onChange: setB }),
    h(Result, { state }, (d) =>
      d.products.length === 0
        ? h(EmptyState, null, 'Ninguna de las dos semanas tiene movimientos.')
        : h(
            Fragment,
            null,
            h(
              'div',
              { className: 'kpis' },
              h('div', { className: 'kpi salida' }, h('div', { className: 'label' }, 'Salidas A'), h('div', { className: 'value' }, fmtQty(d.a.salidas))),
              h('div', { className: 'kpi salida' }, h('div', { className: 'label' }, 'Salidas B'), h('div', { className: 'value' }, fmtQty(d.b.salidas))),
              h('div', { className: 'kpi' }, h('div', { className: 'label' }, 'Diferencia'), h('div', { className: 'value' }, `${d.b.salidas - d.a.salidas > 0 ? '+' : ''}${fmtQty(Math.round((d.b.salidas - d.a.salidas) * 1000) / 1000)}`)),
            ),
            h(
              'div',
              { className: 'table-wrap' },
              h(
                'table',
                null,
                h('thead', null, h('tr', null, h('th', null, 'Producto'), h('th', { className: 'r' }, 'Salidas A'), h('th', { className: 'r' }, 'Salidas B'), h('th', { className: 'r' }, 'Cambio'))),
                h(
                  'tbody',
                  null,
                  d.products.map((p) =>
                    h(
                      'tr',
                      { key: p.code },
                      h('td', null, `${p.name} (${p.code})`),
                      h('td', { className: 'r' }, fmtQty(p.a.salidas)),
                      h('td', { className: 'r' }, fmtQty(p.b.salidas)),
                      h('td', { className: `r ${p.deltaSalidas > 0 ? 'pos' : p.deltaSalidas < 0 ? 'neg' : ''}` }, `${p.deltaSalidas > 0 ? '+' : ''}${fmtQty(p.deltaSalidas)}`),
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

export function Reports({ user, branch, branches }) {
  const [tab, setTab] = useState('summary');
  const [weeks, setWeeks] = useState([]);
  const [weekId, setWeekId] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [allBranches, setAllBranches] = useState(false);
  const isAdmin = user.role === 'admin';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api('GET', `/branches/${branch.id}/weeks?limit=52`)
      .then((res) => {
        if (cancelled) return;
        setWeeks(res.weeks);
        setWeekId(res.weeks[0]?.id || null);
        setError('');
      })
      .catch((err) => !cancelled && setError(err.isNetwork ? 'Sin conexión: los reportes necesitan internet.' : errorText(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [branch.id]);

  // Los reportes de "más vendidos" y "tendencia" admiten todas las sucursales (solo admin).
  const scope = isAdmin && allBranches ? '' : branch.id;

  return h(
    'div',
    null,
    h('h2', { className: 'page-title' }, 'Reportes'),
    h('div', { className: 'tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', { key: id, role: 'tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, label))),
    isAdmin && (tab === 'top' || tab === 'trend') && branches.length > 1 && h('label', { className: 'check', style: { marginBottom: 12 } }, h('input', { type: 'checkbox', checked: allBranches, onChange: (e) => setAllBranches(e.target.checked) }), 'Sumar todas las sucursales'),
    !(isAdmin && allBranches && (tab === 'top' || tab === 'trend')) && h('p', { className: 'muted' }, `Sucursal: ${branch.name}`),
    error && h(Banner, { kind: 'error' }, error),
    loading ? h(Spinner, null) : null,
    !loading && tab === 'summary' && (weeks.length === 0 ? h(EmptyState, null, 'Todavía no hay semanas.') : h(SummaryTab, { weeks, weekId, setWeekId })),
    !loading && tab === 'top' && h(TopTab, { scope }),
    !loading && tab === 'trend' && h(TrendTab, { scope }),
    !loading && tab === 'compare' && h(CompareTab, { weeks, key: branch.id }),
  );
}
