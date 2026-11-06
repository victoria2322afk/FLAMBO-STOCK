import { h, useState, useEffect, useRef, useMemo, useCallback, Modal, Banner, Spinner, EmptyState, Field, errorText } from '../ui.js';
import { api, download, upload } from '../api.js';
import { cacheView, cachedView, cachedCurrentView, pendingForWeek, enqueue } from '../offline.js';
import { DAY_SHORT, DAY_LONG, fmtQty, qtyToText, parseQty, fmtShortDate, fmtDate, fmtDateTime, normalize, recomputeDays } from '../util.js';

const REFRESH_MS = 60 * 1000;

/** Superpone los cambios que todavía no se enviaron sobre la semana bajada del servidor. */
function applyPending(userId, data) {
  const pending = pendingForWeek(userId, data.week.id);
  if (pending.length === 0) return data;
  const byProduct = new Map();
  for (const c of pending) {
    if (!byProduct.has(c.productId)) byProduct.set(c.productId, []);
    byProduct.get(c.productId).push(c);
  }
  const groups = data.groups.map((g) => ({
    ...g,
    products: g.products.map((p) => {
      const changes = byProduct.get(p.id);
      if (!changes) return p;
      const days = p.days.map((d) => ({ ...d }));
      for (const c of changes) {
        if (c.entrada !== undefined) days[c.dayIndex].entrada = c.entrada;
        if (c.salida !== undefined) days[c.dayIndex].salida = c.salida;
      }
      return { ...p, days: recomputeDays(p.initial, days) };
    }),
  }));
  return { ...data, groups };
}

const defaultDay = (week) => (week.currentDayIndex === null || week.currentDayIndex === undefined ? 0 : week.currentDayIndex);

/** Campo numérico de una celda. Mantiene lo que se está escribiendo y avisa cada valor válido. */
function CellInput({ value, readOnly, label, onCommit }) {
  const [text, setText] = useState(qtyToText(value));
  const [bad, setBad] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setText(qtyToText(value));
      setBad(false);
    }
  }, [value]);

  return h('input', {
    type: 'text',
    inputMode: 'decimal',
    autoComplete: 'off',
    className: bad ? 'bad' : '',
    value: text,
    readOnly,
    placeholder: '0',
    'aria-label': label,
    'aria-invalid': bad ? 'true' : undefined,
    onFocus: (e) => {
      focused.current = true;
      e.target.select();
    },
    onBlur: () => {
      focused.current = false;
      const r = parseQty(text);
      setText(r.ok ? qtyToText(r.value) : qtyToText(value));
      setBad(false);
    },
    onChange: (e) => {
      const t = e.target.value;
      setText(t);
      const r = parseQty(t);
      if (!r.ok) return setBad(true);
      setBad(false);
      if (r.value !== value) onCommit(r.value);
    },
  });
}

const ProductCard = React.memo(function ProductCard({ product, day, dayIndex, editable, canEditInitial, isToday, onCell, onEditInitial }) {
  const d = product.days[dayIndex];
  const touched = d.entrada !== 0 || d.salida !== 0;
  const low = isToday && product.minQty !== null && product.minQty > 0 && d.total < product.minQty;

  return h(
    'div',
    { className: `product-card${touched ? ' touched' : ''}${low ? ' low' : ''}${product.active ? '' : ' inactive'}`, 'data-code': product.code },
    h(
      'div',
      { className: 'product-head' },
      h('div', { className: 'product-name-row' }, h('span', { className: 'product-code' }, product.code), h('span', { className: 'product-name' }, product.name)),
      h('div', { className: 'tags' }, low && h('span', { className: 'tag warn' }, 'Bajo mínimo'), !product.active && h('span', { className: 'tag muted' }, 'Inactivo')),
    ),
    h(
      'div',
      { className: 'field-row' },
      h('div', { className: 'field entrada' }, h('label', null, 'Entrada'), h(CellInput, { value: d.entrada, readOnly: !editable, label: `Entrada de ${product.name}`, onCommit: (v) => onCell(product.id, dayIndex, 'entrada', v) })),
      h('div', { className: 'field salida' }, h('label', null, 'Salida'), h(CellInput, { value: d.salida, readOnly: !editable, label: `Salida de ${product.name}`, onCommit: (v) => onCell(product.id, dayIndex, 'salida', v) })),
      h('div', { className: 'field total' }, h('label', null, 'Total'), h('output', { className: `total-value${d.total < 0 ? ' negative' : ''}`, 'aria-label': `Total de ${product.name}` }, fmtQty(d.total))),
    ),
    h(
      'div',
      { className: 'initial-note' },
      dayIndex === 0 ? 'Stock inicial de la semana' : `Inicial = total del ${DAY_LONG[dayIndex - 1].toLowerCase()}`,
      h('span', { className: 'num' }, fmtQty(d.initial)),
      dayIndex === 0 && canEditInitial && h('button', { type: 'button', className: 'link-btn', onClick: () => onEditInitial(product) }, 'Editar'),
    ),
  );
});

function buildShareText(view, dayIndex, branchName) {
  const day = view.week.days[dayIndex];
  const lines = [`*Stock Flambo* — ${branchName}`, `${DAY_LONG[dayIndex]} ${fmtDate(day.date)}`, ''];
  let any = false;
  let totalE = 0;
  let totalS = 0;
  for (const g of view.groups) {
    for (const p of g.products) {
      const d = p.days[dayIndex];
      if (d.entrada === 0 && d.salida === 0) continue;
      any = true;
      totalE += d.entrada;
      totalS += d.salida;
      lines.push(`• ${p.name} (${p.code}): +${fmtQty(d.entrada)} −${fmtQty(d.salida)} = ${fmtQty(d.total)}`);
    }
  }
  if (!any) lines.push('Sin movimientos cargados.');
  else lines.push('', `Entradas: ${fmtQty(totalE)} · Salidas: ${fmtQty(totalS)}`);
  let text = lines.join('\n');
  if (text.length > 3500) text = `${text.slice(0, 3450)}\n… (resumen recortado)`;
  return text;
}

/**
 * Pantalla de carga de stock de una semana.
 * Sin `weekId` muestra la semana vigente de la sucursal; con `weekId`, esa semana (historial).
 */
export function Stock({ user, branch, weekId, onBack, sync, toast }) {
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cachedAt, setCachedAt] = useState(null);
  const [activeDay, setActiveDay] = useState(null);
  const [search, setSearch] = useState('');
  const [initialFor, setInitialFor] = useState(null);
  const [importErrors, setImportErrors] = useState(null);
  const [busy, setBusy] = useState('');
  const weekIdRef = useRef(null);
  const fileRef = useRef(null);
  const isAdmin = user.role === 'admin';

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        await sync.flushNow();
        const path = weekId ? `/weeks/${weekId}` : `/branches/${branch.id}/weeks/current`;
        const data = await api('GET', path);
        cacheView(user.id, data);
        setView(applyPending(user.id, data));
        setCachedAt(null);
        setError('');
        setActiveDay((prev) => (prev === null ? defaultDay(data.week) : prev));
      } catch (err) {
        const cached = weekId ? cachedView(user.id, weekId) : cachedCurrentView(user.id, branch.id);
        if (cached && (err.isNetwork || err.status >= 500)) {
          setView(applyPending(user.id, cached.view));
          setCachedAt(cached.savedAt);
          setError('');
          setActiveDay((prev) => (prev === null ? defaultDay(cached.view.week) : prev));
        } else if (!silent) {
          setError(err.isNetwork ? 'No hay conexión y todavía no hay datos guardados en este dispositivo.' : errorText(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [weekId, branch.id, user.id, sync.flushNow],
  );

  // Cambió la semana o la sucursal: empezar de cero.
  useEffect(() => {
    setView(null);
    setActiveDay(null);
    setSearch('');
    load(false);
  }, [weekId, branch.id]);

  // Refresco periódico y al volver a la pestaña, sin pisar lo que se está escribiendo.
  useEffect(() => {
    const refresh = () => {
      if (document.hidden || !sync.online || sync.pending > 0) return;
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.product-card')) return;
      load(true);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load, sync.online, sync.pending]);

  // Al terminar de enviar lo pendiente, se pide de nuevo la semana si estuvimos sin conexión.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!sync.online) wasOffline.current = true;
    else if (wasOffline.current && sync.pending === 0) {
      wasOffline.current = false;
      load(true);
    }
  }, [sync.online, sync.pending]);

  weekIdRef.current = view ? view.week.id : null;

  const onCell = useCallback(
    (productId, dayIndex, field, value) => {
      setView((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          groups: prev.groups.map((g) => ({
            ...g,
            products: g.products.map((p) => {
              if (p.id !== productId) return p;
              const days = p.days.map((d, i) => (i === dayIndex ? { ...d, [field]: value } : d));
              return { ...p, days: recomputeDays(p.initial, days) };
            }),
          })),
        };
      });
      enqueue(user.id, { weekId: weekIdRef.current, productId, dayIndex, [field]: value });
      sync.changed();
    },
    [user.id, sync.changed],
  );

  const editable = !!view && view.week.status === 'open';
  const todayIndex = view && view.week.status === 'open' ? view.week.currentDayIndex : null;

  const dayInfo = useMemo(() => {
    if (!view) return [];
    return view.week.days.map((_, i) => {
      let hasData = false;
      for (const g of view.groups) {
        for (const p of g.products) {
          if (p.days[i].entrada !== 0 || p.days[i].salida !== 0) {
            hasData = true;
            break;
          }
        }
        if (hasData) break;
      }
      return hasData;
    });
  }, [view]);

  const totals = useMemo(() => {
    const t = { entrada: 0, salida: 0, total: 0 };
    if (!view || activeDay === null) return t;
    for (const g of view.groups) {
      for (const p of g.products) {
        const d = p.days[activeDay];
        t.entrada += d.entrada;
        t.salida += d.salida;
        t.total += d.total;
      }
    }
    return t;
  }, [view, activeDay]);

  const groups = useMemo(() => {
    if (!view) return [];
    const q = normalize(search.trim());
    if (!q) return view.groups;
    return view.groups
      .map((g) => ({ ...g, products: g.products.filter((p) => normalize(p.name).includes(q) || String(p.code).includes(q)) }))
      .filter((g) => g.products.length > 0);
  }, [view, search]);

  async function exportExcel() {
    setBusy('export');
    try {
      await download(`/weeks/${view.week.id}/export.xlsx`, 'stock.xlsx');
      toast('ok', 'Planilla descargada.');
    } catch (err) {
      toast('error', err.isNetwork ? 'Para descargar la planilla hace falta conexión.' : errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function importExcel(file) {
    if (!file) return;
    setBusy('import');
    try {
      await sync.flushNow();
      const res = await upload(`/weeks/${view.week.id}/import`, file);
      const extra = res.warnings.length ? ` Avisos: ${res.warnings.length}.` : '';
      toast(res.warnings.length ? 'warn' : 'ok', `Planilla importada: ${res.products} productos, ${res.cellsChanged} celdas cambiadas.${extra}`);
      await load(true);
    } catch (err) {
      if (Array.isArray(err.details) && err.details.length) setImportErrors({ message: err.message, details: err.details });
      else toast('error', err.isNetwork ? 'Para importar hace falta conexión.' : errorText(err));
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function shareWhatsApp() {
    const text = buildShareText(view, activeDay, view.week.branchName);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }

  async function saveInitial(product, qty) {
    try {
      await api('PUT', `/weeks/${view.week.id}/initial-stock`, { body: { items: [{ productId: product.id, qty }] } });
      toast('ok', `Stock inicial de ${product.name} actualizado.`);
      setInitialFor(null);
      await load(true);
    } catch (err) {
      toast('error', err.isNetwork ? 'Para cambiar el stock inicial hace falta conexión.' : errorText(err));
    }
  }

  if (loading && !view) return h(Spinner, { label: 'Cargando la semana…' });
  if (error && !view) {
    return h('div', null, h(Banner, { kind: 'error' }, error), h('button', { className: 'btn primary', onClick: () => load(false) }, 'Reintentar'));
  }
  if (!view) return null;

  const { week } = view;

  return h(
    'div',
    { className: 'stock-screen' },
    onBack && h('button', { className: 'back-btn', onClick: onBack }, '← Volver al historial'),
    h(
      'div',
      { className: 'week-head' },
      h('div', null, h('div', { className: 'week-title' }, `Semana del ${fmtShortDate(week.startDate)} al ${fmtShortDate(week.endDate)}`), h('div', { className: 'week-sub' }, week.branchName)),
      h('span', { className: `badge ${week.status}` }, week.status === 'open' ? 'Abierta' : 'Cerrada'),
    ),
    week.status === 'closed' && h(Banner, { kind: 'info' }, 'Esta semana está cerrada: solo se puede consultar.'),
    cachedAt && h(Banner, { kind: 'warn' }, `Mostrando datos guardados en este dispositivo (${fmtDateTime(cachedAt)}). Se actualizan solos cuando vuelve la conexión.`),

    h(
      'div',
      { className: 'header-actions' },
      h('button', { className: 'action-link', onClick: exportExcel, disabled: busy === 'export' || !sync.online }, busy === 'export' ? 'Descargando…' : 'Excel'),
      editable && h('button', { className: 'action-link', onClick: () => fileRef.current && fileRef.current.click(), disabled: busy === 'import' || !sync.online }, busy === 'import' ? 'Importando…' : 'Importar'),
      h('button', { className: 'action-link whatsapp-btn', onClick: shareWhatsApp }, 'WhatsApp'),
      h('input', { ref: fileRef, type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true, onChange: (e) => importExcel(e.target.files[0]) }),
    ),

    h(
      'div',
      { className: 'week-strip', role: 'tablist', 'aria-label': 'Días de la semana' },
      week.days.map((d, i) =>
        h(
          'button',
          { key: d.index, role: 'tab', 'aria-selected': activeDay === i, className: `day-chip${activeDay === i ? ' active' : ''}`, onClick: () => setActiveDay(i) },
          h('span', { className: 'day-name' }, DAY_SHORT[i]),
          h('span', { className: 'day-date' }, fmtShortDate(d.date)),
          todayIndex === i && h('span', { className: 'today-mark' }, 'hoy'),
          dayInfo[i] && h('span', { className: 'dot', 'aria-label': 'tiene movimientos' }),
        ),
      ),
    ),

    h('div', { className: 'section-label' }, DAY_LONG[activeDay], h('span', { className: 'sub' }, fmtDate(week.days[activeDay].date))),

    h(
      'div',
      { className: 'search-wrap' },
      h('span', { className: 'ic', 'aria-hidden': 'true' }, '⌕'),
      h('input', { type: 'search', placeholder: 'Buscar por nombre o código', 'aria-label': 'Buscar producto', value: search, onChange: (e) => setSearch(e.target.value) }),
    ),

    groups.length === 0 && h(EmptyState, null, search ? `Ningún producto coincide con "${search}"` : 'Todavía no hay productos en el catálogo.'),

    groups.map((g) =>
      h(
        'section',
        { key: g.id },
        h('div', { className: 'group-title' }, g.name),
        g.products.map((p) =>
          h(ProductCard, {
            key: p.id,
            product: p,
            dayIndex: activeDay,
            editable,
            canEditInitial: isAdmin && editable,
            isToday: todayIndex === activeDay,
            onCell,
            onEditInitial: setInitialFor,
          }),
        ),
      ),
    ),

    h(
      'div',
      { className: 'summary-bar', role: 'status', 'aria-label': `Resumen del ${DAY_LONG[activeDay]}` },
      h(
        'div',
        { className: 'max-wrap' },
        h('div', { className: 'summary-item entrada' }, h('div', { className: 'label' }, 'Entradas'), h('div', { className: 'value' }, fmtQty(totals.entrada))),
        h('div', { className: 'summary-item salida' }, h('div', { className: 'label' }, 'Salidas'), h('div', { className: 'value' }, fmtQty(totals.salida))),
        h('div', { className: 'summary-item total' }, h('div', { className: 'label' }, 'Total stock'), h('div', { className: 'value' }, fmtQty(totals.total))),
      ),
    ),

    initialFor && h(InitialModal, { product: initialFor, onClose: () => setInitialFor(null), onSave: saveInitial }),
    importErrors &&
      h(
        Modal,
        {
          title: 'No se pudo importar',
          onClose: () => setImportErrors(null),
          actions: h('button', { className: 'btn primary', onClick: () => setImportErrors(null) }, 'Entendido'),
        },
        h('p', { className: 'muted' }, importErrors.message),
        h(
          'ul',
          { className: 'error-list' },
          importErrors.details.slice(0, 12).map((d, i) => h('li', { key: i }, h('strong', null, d.row ? `Fila ${d.row}: ` : ''), d.message)),
        ),
        importErrors.details.length > 12 && h('p', { className: 'muted' }, `…y ${importErrors.details.length - 12} más.`),
      ),
  );
}

function InitialModal({ product, onClose, onSave }) {
  const current = product.days[0].initial;
  const [text, setText] = useState(current === 0 ? '0' : String(current).replace('.', ','));
  const parsed = parseQty(text, { allowNegative: true });
  return h(
    Modal,
    { title: `Stock inicial · ${product.name}`, onClose },
    h(
      'form',
      {
        className: 'form',
        onSubmit: (e) => {
          e.preventDefault();
          if (parsed.ok) onSave(product, parsed.value);
        },
      },
      h('p', { className: 'muted' }, 'Es la cantidad con la que arranca el lunes. Los totales de toda la semana se recalculan.'),
      h(Field, { label: 'Cantidad inicial', hint: parsed.ok ? undefined : 'Escribí un número válido (hasta 3 decimales).' }, h('input', { type: 'text', inputMode: 'decimal', value: text, onChange: (e) => setText(e.target.value), 'aria-invalid': parsed.ok ? undefined : 'true' })),
      h('div', { className: 'actions' }, h('button', { type: 'button', className: 'btn ghost', onClick: onClose }, 'Cancelar'), h('button', { type: 'submit', className: 'btn primary', disabled: !parsed.ok }, 'Guardar')),
    ),
  );
}
