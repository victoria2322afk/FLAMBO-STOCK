// Componentes de interfaz básicos. Sin JSX: se usa React.createElement (alias `h`).
const React = window.React;

export const h = React.createElement;
export const { useState, useEffect, useRef, useMemo, useCallback, Fragment } = React;

/** Ventana modal. Se cierra con Escape o tocando el fondo, salvo que `locked` sea true. */
export function Modal({ title, onClose, locked = false, wide = false, children, actions }) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !locked && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    // Foco en el primer campo para poder escribir enseguida.
    const first = ref.current?.querySelector('input, select, textarea');
    if (first) first.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return h(
    'div',
    {
      className: 'overlay',
      onMouseDown: (e) => {
        if (e.target === e.currentTarget && !locked && onClose) onClose();
      },
    },
    h(
      'div',
      { className: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, ref },
      h('h3', null, title),
      h('div', { className: 'modal-body' }, children),
      actions && h('div', { className: 'actions' }, actions),
    ),
  );
}

/** Aviso en una franja de color: kind = ok | error | warn | info. */
export function Banner({ kind = 'info', children, onClose }) {
  return h(
    'div',
    { className: `banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('div', { className: 'banner-text' }, children),
    onClose && h('button', { className: 'banner-close', onClick: onClose, 'aria-label': 'Cerrar aviso' }, '×'),
  );
}

/** Avisos temporales en pantalla. */
export function Toasts({ toasts, onDismiss }) {
  return h(
    'div',
    { className: 'toasts', 'aria-live': 'polite' },
    toasts.map((t) =>
      h(
        'div',
        { key: t.id, className: `toast ${t.kind}`, role: t.kind === 'error' ? 'alert' : 'status', onClick: () => onDismiss(t.id) },
        t.text,
      ),
    ),
  );
}

export function Spinner({ label = 'Cargando…' }) {
  return h('div', { className: 'spinner-wrap', role: 'status' }, h('div', { className: 'spinner' }), h('span', null, label));
}

export function EmptyState({ glyph = '∅', children }) {
  return h('div', { className: 'empty-state' }, h('div', { className: 'glyph' }, glyph), h('p', null, children));
}

/** Campo de formulario con etiqueta. `children` es el control. */
export function Field({ label, hint, children }) {
  return h('label', { className: 'form-field' }, h('span', { className: 'form-label' }, label), children, hint && h('span', { className: 'form-hint' }, hint));
}

/** Mensaje de error legible a partir de cualquier error. */
export function errorText(err) {
  if (err && err.message) return err.message;
  return 'Ocurrió un error inesperado.';
}
