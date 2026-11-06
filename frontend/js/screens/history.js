import { h, useState, useEffect, Banner, Spinner, EmptyState, errorText } from '../ui.js';
import { api, download } from '../api.js';
import { fmtQty, fmtShortDate, fmtDate, fmtDateTime } from '../util.js';
import { addDays } from '../dates.js';

const PAGE = 20;

export function History({ branch, onOpenWeek, toast, sync }) {
  const [weeks, setWeeks] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load(offset) {
    setLoading(true);
    try {
      if (offset === 0) await sync.flushNow();
      const res = await api('GET', `/branches/${branch.id}/weeks?limit=${PAGE}&offset=${offset}`);
      setWeeks((prev) => (offset === 0 ? res.weeks : [...prev, ...res.weeks]));
      setTotal(res.total);
      setError('');
    } catch (err) {
      setError(err.isNetwork ? 'Sin conexión: el historial necesita internet.' : errorText(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setWeeks([]);
    load(0);
  }, [branch.id]);

  async function exportWeek(e, week) {
    e.stopPropagation();
    try {
      await download(`/weeks/${week.id}/export.xlsx`, 'stock.xlsx');
    } catch (err) {
      toast('error', err.isNetwork ? 'Para descargar la planilla hace falta conexión.' : errorText(err));
    }
  }

  return h(
    'div',
    null,
    h('h2', { className: 'page-title' }, 'Historial de semanas'),
    h('p', { className: 'muted' }, `Semanas de ${branch.name}. Las cerradas se pueden consultar y descargar, pero no modificar.`),
    error && h(Banner, { kind: 'error' }, error),
    loading && weeks.length === 0 && h(Spinner, null),
    !loading && weeks.length === 0 && !error && h(EmptyState, null, 'Todavía no hay semanas registradas.'),
    h(
      'ul',
      { className: 'list' },
      weeks.map((w) =>
        h(
          'li',
          { key: w.id },
          h(
            'div',
            { className: 'list-row clickable', role: 'button', tabIndex: 0, onClick: () => onOpenWeek(w.id), onKeyDown: (e) => e.key === 'Enter' && onOpenWeek(w.id) },
            h(
              'div',
              { className: 'main' },
              h('div', { className: 'title' }, `Semana del ${fmtShortDate(w.startDate)} al ${fmtShortDate(addDays(w.startDate, 5))}`),
              h('div', { className: 'sub' }, `Entradas ${fmtQty(w.entradas)} · Salidas ${fmtQty(w.salidas)}`, w.closedAt ? ` · cerrada ${fmtDateTime(w.closedAt)}` : ''),
            ),
            h(
              'div',
              { className: 'side' },
              h('span', { className: `badge ${w.status}` }, w.status === 'open' ? 'Abierta' : 'Cerrada'),
              h('button', { className: 'btn small ghost', onClick: (e) => exportWeek(e, w), 'aria-label': `Descargar la semana del ${fmtDate(w.startDate)}`, disabled: !sync.online }, 'Excel'),
            ),
          ),
        ),
      ),
    ),
    weeks.length < total && h('div', { className: 'pager' }, h('button', { className: 'btn', disabled: loading, onClick: () => load(weeks.length) }, loading ? 'Cargando…' : `Ver más (${total - weeks.length})`)),
  );
}
