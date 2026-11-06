import { h, useState, useEffect, useRef, useCallback, useMemo, Toasts, Banner, Spinner, Modal, EmptyState } from './ui.js';
import { api, getToken, setToken, setUnauthorizedHandler, API_BASE } from './api.js';
import { flush, pendingCount, clearUserData } from './offline.js';
import { store, debounce } from './util.js';
import { Login, ChangePassword } from './screens/login.js';
import { Stock } from './screens/stock.js';
import { Alerts } from './screens/alerts.js';
import { History } from './screens/history.js';
import { Reports } from './screens/reports.js';
import { Admin } from './screens/admin.js';
import { Help } from './screens/help.js';

const PROBE_MS = 15 * 1000;
const ALERTS_REFRESH_MS = 2 * 60 * 1000;

/**
 * Estado de la conexión y de los cambios pendientes de envío.
 * `online` es falso si el navegador está sin red o si el servidor no responde.
 */
function useSync(userId, notify) {
  const [reachable, setReachable] = useState(true);
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(() => (userId ? pendingCount(userId) : 0));
  const [syncing, setSyncing] = useState(false);

  const userRef = useRef(userId);
  const notifyRef = useRef(notify);
  const live = useRef({ pending: 0, reachable: true });
  userRef.current = userId;
  notifyRef.current = notify;
  live.current = { pending, reachable };

  const refreshPending = useCallback(() => {
    setPending(userRef.current ? pendingCount(userRef.current) : 0);
  }, []);

  const flushNow = useCallback(async () => {
    const uid = userRef.current;
    if (!uid || pendingCount(uid) === 0) return;
    setSyncing(true);
    try {
      const res = await flush(uid);
      if (res.stopped === 'network') setReachable(false);
      else if (res.sent > 0 || !res.stopped) setReachable(true);
      if (res.discarded > 0) {
        notifyRef.current('error', `${res.discarded} cambio(s) no se pudieron guardar porque la semana ya se cerró o no tenés permiso.`);
      }
    } catch {
      /* se reintenta en el próximo ciclo */
    } finally {
      setSyncing(false);
      refreshPending();
    }
  }, [refreshPending]);

  const debouncedFlush = useRef(null);
  if (!debouncedFlush.current) debouncedFlush.current = debounce(() => flushNow(), 800);
  const changed = useCallback(() => {
    refreshPending();
    debouncedFlush.current();
  }, [refreshPending]);

  useEffect(() => {
    refreshPending();
  }, [userId]);

  useEffect(() => {
    const goOnline = () => {
      setBrowserOnline(true);
      flushNow();
    };
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const timer = setInterval(async () => {
      if (!userRef.current) return;
      if (live.current.pending === 0 && live.current.reachable) return;
      try {
        const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
        if (res.ok) {
          setReachable(true);
          flushNow();
        } else setReachable(false);
      } catch {
        setReachable(false);
      }
    }, PROBE_MS);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      clearInterval(timer);
    };
  }, [flushNow]);

  const online = browserOnline && reachable;
  return useMemo(() => ({ online, pending, syncing, flushNow, changed }), [online, pending, syncing, flushNow, changed]);
}

function SyncPill({ sync }) {
  let cls = 'sync-pill';
  let text = 'Al día';
  if (!sync.online) {
    cls += ' offline';
    text = sync.pending > 0 ? `Sin conexión · ${sync.pending} pendiente${sync.pending === 1 ? '' : 's'}` : 'Sin conexión';
  } else if (sync.syncing) {
    cls += ' pending syncing';
    text = 'Enviando…';
  } else if (sync.pending > 0) {
    cls += ' pending';
    text = `${sync.pending} pendiente${sync.pending === 1 ? '' : 's'}`;
  }
  return h('span', { className: cls, role: 'status', 'data-testid': 'sync-pill' }, text);
}

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';

function App() {
  const [phase, setPhase] = useState('boot'); // boot | login | app
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState('');
  const [toasts, setToasts] = useState([]);
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(null);
  const [screen, setScreen] = useState({ id: 'stock' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const toastId = useRef(0);

  const toast = useCallback((kind, text) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((t) => [...t, { id, kind, text }].slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);
  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const sync = useSync(user?.id, toast);

  // ---- Arranque: ¿hay una sesión guardada?
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setPhase('login');
      setNotice('Tu sesión venció o fue cerrada. Ingresá de nuevo; tus cambios pendientes se conservan.');
    });
    (async () => {
      if (!getToken()) return setPhase('login');
      try {
        const res = await api('GET', '/auth/me');
        store.setJson('flambo_user', res.user);
        setUser(res.user);
        setPhase('app');
      } catch (err) {
        if (err.isNetwork || err.status >= 500) {
          const cached = store.getJson('flambo_user');
          if (cached) {
            setUser(cached);
            setPhase('app');
            return;
          }
        }
        setToken(null);
        setPhase('login');
      }
    })();
  }, []);

  // ---- Sucursales disponibles
  const applyBranches = useCallback((list) => {
    const active = list.filter((b) => b.active);
    setBranches(active);
    const saved = Number(store.get('flambo_branch'));
    const pick = active.find((b) => b.id === saved) || active[0];
    setBranchId(pick ? pick.id : null);
  }, []);

  const reloadBranches = useCallback(async () => {
    try {
      const res = await api('GET', '/branches');
      store.setJson('flambo_branches', res.branches);
      applyBranches(res.branches);
    } catch {
      applyBranches(store.getJson('flambo_branches', []));
    }
  }, [applyBranches]);

  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    if (user.role !== 'admin') {
      setBranches([{ id: user.branchId, name: user.branchName, active: true }]);
      setBranchId(user.branchId);
    } else {
      reloadBranches();
    }
  }, [user && user.id, user && user.mustChangePassword]);

  const branch = useMemo(() => branches.find((b) => b.id === branchId) || null, [branches, branchId]);

  // ---- Cantidad de alertas (insignia en el menú)
  useEffect(() => {
    if (!user || user.mustChangePassword || !branch) return undefined;
    let cancelled = false;
    const refresh = () => {
      if (!sync.online || document.hidden) return;
      api('GET', `/branches/${branch.id}/alerts`)
        .then((res) => !cancelled && setAlertCount(res.alerts.length))
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, ALERTS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user && user.id, branch && branch.id, screen.id, sync.online, sync.pending === 0]);

  // ---- La sección activa siempre queda visible en la barra de navegación
  useEffect(() => {
    const el = document.querySelector('.nav [aria-current="page"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [screen.id, phase]);

  // ---- Menú de usuario: se cierra al tocar afuera
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => {
      if (!e.target.closest || !e.target.closest('.user-wrap')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [menuOpen]);

  function onLoggedIn(u) {
    store.setJson('flambo_user', u);
    setNotice('');
    setScreen({ id: 'stock' });
    setUser(u);
    setPhase('app');
  }

  function logout(force = false) {
    setMenuOpen(false);
    if (!force && sync.pending > 0) return setConfirmLogout(true);
    if (user) clearUserData(user.id);
    store.remove('flambo_user');
    store.remove('flambo_branches');
    setToken(null);
    setConfirmLogout(false);
    setUser(null);
    setBranches([]);
    setBranchId(null);
    setPhase('login');
  }

  async function passwordChanged() {
    setShowPassword(false);
    try {
      const res = await api('GET', '/auth/me');
      store.setJson('flambo_user', res.user);
      setUser(res.user);
      toast('ok', 'Clave actualizada.');
    } catch {
      /* queda como estaba */
    }
  }

  function go(id, params) {
    setScreen({ id, ...params });
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }

  function selectBranch(id) {
    store.set('flambo_branch', String(id));
    setBranchId(id);
    setScreen({ id: 'stock' });
  }

  // ---------------------------------------------------------------- Render
  if (phase === 'boot') return h(Spinner, { label: 'Abriendo…' });
  if (phase === 'login' || !user) return h('div', null, h(Login, { onLoggedIn, notice }), h(Toasts, { toasts, onDismiss: dismissToast }));

  if (user.mustChangePassword) {
    return h('div', null, h('main', { className: 'lock-screen' }, h('img', { className: 'lock-logo', src: 'img/apple-touch-icon.png', alt: 'Flambo' }), h('h1', { className: 'lock-title' }, `Hola, ${user.name.split(' ')[0]}`)), h(ChangePassword, { forced: true, onDone: passwordChanged }), h(Toasts, { toasts, onDismiss: dismissToast }));
  }

  const isAdmin = user.role === 'admin';
  const nav = [
    ['stock', 'Stock'],
    ['alerts', 'Alertas'],
    ['history', 'Historial'],
    ['reports', 'Reportes'],
    ...(isAdmin ? [['admin', 'Admin']] : []),
    ['help', 'Ayuda'],
  ];
  const activeNav = screen.id === 'week' ? 'history' : screen.id;

  let content;
  if (!branch && screen.id !== 'help' && screen.id !== 'admin') {
    content = h(EmptyState, null, isAdmin ? 'No hay sucursales activas. Creá una en Administración.' : 'Tu usuario no tiene una sucursal activa. Avisale a un administrador.');
  } else if (screen.id === 'stock') content = h(Stock, { key: `stock-${branch.id}`, user, branch, sync, toast });
  else if (screen.id === 'week') content = h(Stock, { key: `week-${screen.weekId}`, user, branch, weekId: screen.weekId, sync, toast, onBack: () => go('history') });
  else if (screen.id === 'alerts') content = h(Alerts, { key: branch.id, branch, sync });
  else if (screen.id === 'history') content = h(History, { key: branch.id, branch, sync, toast, onOpenWeek: (weekId) => go('week', { weekId }) });
  else if (screen.id === 'reports') content = h(Reports, { user, branch, branches });
  else if (screen.id === 'admin' && isAdmin) content = h(Admin, { user, branch: branch || { id: 0, name: '' }, branches, reloadBranches, toast });
  else content = h(Help, { user });

  const showSummary = screen.id === 'stock' || screen.id === 'week';

  return h(
    'div',
    { className: `app${showSummary ? '' : ' no-summary'}` },
    h(
      'header',
      { className: 'top' },
      h(
        'div',
        { className: 'top-row' },
        h('div', { className: 'brand' }, h('img', { src: 'img/logo.png', alt: 'Flambo' }), h('span', { className: 'brand-name' }, 'Stock')),
        h(
          'div',
          { className: 'top-right' },
          h(SyncPill, { sync }),
          h(
            'div',
            { className: 'user-wrap' },
            h('button', { className: 'user-btn', onClick: () => setMenuOpen((o) => !o), 'aria-label': 'Menú de usuario', 'aria-expanded': menuOpen }, initials(user.name)),
            menuOpen &&
              h(
                'div',
                { className: 'menu', role: 'menu' },
                h('div', { className: 'menu-head' }, h('strong', null, user.name), h('span', null, isAdmin ? 'Administrador' : user.branchName)),
                h('button', { role: 'menuitem', onClick: () => { setMenuOpen(false); setShowPassword(true); } }, 'Cambiar clave'),
                h('button', { role: 'menuitem', onClick: () => logout(false) }, 'Cerrar sesión'),
              ),
          ),
        ),
      ),
      isAdmin && branches.length > 0 && h('div', { className: 'branch-bar' }, h('label', { htmlFor: 'branch-select' }, 'Sucursal'), h('select', { id: 'branch-select', value: branchId ?? '', onChange: (e) => selectBranch(Number(e.target.value)) }, branches.map((b) => h('option', { key: b.id, value: b.id }, b.name)))),
      !isAdmin && h('div', { className: 'branch-bar' }, h('strong', null, user.branchName)),
      h(
        'nav',
        { className: 'nav', 'aria-label': 'Secciones' },
        nav.map(([id, label]) =>
          h(
            'button',
            { key: id, 'aria-current': activeNav === id ? 'page' : undefined, onClick: () => go(id) },
            label,
            id === 'alerts' && alertCount > 0 && h('span', { className: 'count', 'aria-label': `${alertCount} alertas` }, alertCount),
          ),
        ),
      ),
    ),
    !sync.online && h(Banner, { kind: 'warn' }, 'Sin conexión. Tus cambios se guardan en este dispositivo y se envían solos cuando vuelva internet.'),
    h('main', { className: 'content' }, content),
    !showSummary && h('footer', { className: 'app-footer' }, 'Flambo · desde 1956'),
    h(Toasts, { toasts, onDismiss: dismissToast }),
    showPassword && h(ChangePassword, { forced: false, onDone: passwordChanged, onCancel: () => setShowPassword(false) }),
    confirmLogout &&
      h(
        Modal,
        { title: 'Hay cambios sin enviar', onClose: () => setConfirmLogout(false) },
        h('p', null, `Tenés ${sync.pending} cambio${sync.pending === 1 ? '' : 's'} que todavía no llegó al servidor. Si cerrás sesión ahora se van a perder.`),
        h('div', { className: 'actions' }, h('button', { className: 'btn primary', onClick: () => setConfirmLogout(false) }, 'Volver y esperar'), h('button', { className: 'btn danger', onClick: () => logout(true) }, 'Cerrar sesión igual')),
      ),
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
