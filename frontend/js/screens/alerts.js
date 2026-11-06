import { h, useState, useEffect, useCallback, Banner, Spinner, EmptyState, errorText } from '../ui.js';
import { api } from '../api.js';
import { DAY_LONG, fmtQty } from '../util.js';

export function Alerts({ branch, sync }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await sync.flushNow();
      setData(await api('GET', `/branches/${branch.id}/alerts`));
      setError('');
    } catch (err) {
      setError(err.isNetwork ? 'Sin conexión: las alertas se actualizan cuando vuelve internet.' : errorText(err));
    } finally {
      setLoading(false);
    }
  }, [branch.id, sync.flushNow]);

  useEffect(() => {
    load();
  }, [branch.id]);

  if (loading && !data) return h(Spinner, null);

  return h(
    'div',
    null,
    h('h2', { className: 'page-title' }, 'Alertas de stock bajo'),
    error && h(Banner, { kind: 'error' }, error),
    data &&
      h(
        'p',
        { className: 'muted' },
        `Productos de ${branch.name} cuyo stock de hoy (${DAY_LONG[data.dayIndex]}) está por debajo del mínimo definido.`,
      ),
    data && data.alerts.length === 0 && !error && h(EmptyState, { glyph: '✓' }, 'Todo en orden: ningún producto está por debajo de su mínimo.'),
    data &&
      data.alerts.length > 0 &&
      h(
        'ul',
        { className: 'list' },
        data.alerts.map((a) =>
          h(
            'li',
            { key: a.productId, className: 'list-row' },
            h('div', { className: 'main' }, h('div', { className: 'title' }, a.name), h('div', { className: 'sub' }, `${a.groupName} · código ${a.code}`)),
            h(
              'div',
              { className: 'side' },
              h('span', { className: 'tag warn' }, `Faltan ${fmtQty(a.missing)}`),
              h('span', { className: 'num' }, `${fmtQty(a.stock)} / mín. ${fmtQty(a.minQty)}`),
            ),
          ),
        ),
      ),
    h('div', { className: 'actions' }, h('button', { className: 'btn', onClick: load, disabled: loading }, loading ? 'Actualizando…' : 'Actualizar')),
  );
}
