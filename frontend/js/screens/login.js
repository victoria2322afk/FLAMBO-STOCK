import { h, useState, Modal, Field, Banner, errorText } from '../ui.js';
import { api, setToken } from '../api.js';

export function Login({ onLoggedIn, notice }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await api('POST', '/auth/login', { body: { username: username.trim(), password } });
      setToken(res.token);
      onLoggedIn(res.user);
    } catch (err) {
      setError(err.isNetwork ? 'No hay conexión con el servidor. Revisá tu internet e intentá de nuevo.' : errorText(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return h(
    'main',
    { className: 'lock-screen' },
    h('img', { className: 'lock-logo', src: 'img/apple-touch-icon.png', alt: 'Flambo' }),
    h('h1', { className: 'lock-title' }, 'Stock Flambo'),
    h('p', { className: 'lock-sub' }, 'Ingresá con tu usuario'),
    notice && h(Banner, { kind: 'warn' }, notice),
    h(
      'form',
      { className: 'lock-form', onSubmit: submit },
      h('input', {
        className: 'lock-input plain',
        name: 'username',
        type: 'text',
        placeholder: 'Usuario',
        autoComplete: 'username',
        autoCapitalize: 'none',
        autoCorrect: 'off',
        'aria-label': 'Usuario',
        value: username,
        onChange: (e) => setUsername(e.target.value),
        autoFocus: true,
        required: true,
      }),
      h('input', {
        className: `lock-input${error ? ' error' : ''}`,
        name: 'password',
        type: 'password',
        placeholder: 'Clave',
        autoComplete: 'current-password',
        'aria-label': 'Clave',
        value: password,
        onChange: (e) => setPassword(e.target.value),
        required: true,
      }),
      h('div', { className: 'lock-error', role: 'alert' }, error),
      h('button', { className: 'lock-btn', type: 'submit', disabled: busy || !username || !password }, busy ? 'Entrando…' : 'Entrar'),
    ),
  );
}

/** Cambio de clave. Con `forced` es obligatorio (primer ingreso o clave reiniciada). */
export function ChangePassword({ forced, onDone, onCancel }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError('La clave nueva debe tener al menos 8 caracteres.');
    if (next !== again) return setError('Las dos claves nuevas no coinciden.');
    if (next === current) return setError('La clave nueva debe ser distinta de la actual.');
    setBusy(true);
    try {
      await api('POST', '/auth/change-password', { body: { currentPassword: current, newPassword: next } });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return h(
    Modal,
    { title: forced ? 'Elegí una clave nueva' : 'Cambiar clave', locked: forced, onClose: onCancel },
    h(
      'form',
      { onSubmit: submit, className: 'form' },
      forced && h('p', { className: 'muted' }, 'Por seguridad, tenés que cambiar la clave que te dieron antes de seguir.'),
      h(Field, { label: 'Clave actual' }, h('input', { type: 'password', autoComplete: 'current-password', value: current, onChange: (e) => setCurrent(e.target.value), required: true })),
      h(Field, { label: 'Clave nueva', hint: 'Mínimo 8 caracteres.' }, h('input', { type: 'password', autoComplete: 'new-password', value: next, onChange: (e) => setNext(e.target.value), required: true })),
      h(Field, { label: 'Repetir clave nueva' }, h('input', { type: 'password', autoComplete: 'new-password', value: again, onChange: (e) => setAgain(e.target.value), required: true })),
      error && h('div', { className: 'form-error', role: 'alert' }, error),
      h(
        'div',
        { className: 'actions' },
        !forced && h('button', { type: 'button', className: 'btn ghost', onClick: onCancel }, 'Cancelar'),
        h('button', { type: 'submit', className: 'btn primary', disabled: busy }, busy ? 'Guardando…' : 'Guardar clave'),
      ),
    ),
  );
}
