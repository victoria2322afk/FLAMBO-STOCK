import { h, useState, useEffect, useCallback, useMemo, Fragment, Modal, Banner, Spinner, EmptyState, Field, errorText } from '../ui.js';
import { api } from '../api.js';
import { fmtDateTime, normalize, parseQty, qtyToText } from '../util.js';

const SUBTABS = [
  ['branches', 'Sucursales'],
  ['users', 'Usuarios'],
  ['catalog', 'Catálogo'],
  ['min', 'Stock mínimo'],
  ['audit', 'Auditoría'],
];

/** Carga datos al montar y permite recargar. */
function useLoad(loader, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await loader(), loading: false, error: '' });
    } catch (err) {
      setState((s) => ({ data: s.data, loading: false, error: err.isNetwork ? 'Sin conexión: la administración necesita internet.' : errorText(err) }));
    }
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}

function Confirm({ title, children, confirmLabel = 'Confirmar', danger = false, onConfirm, onClose }) {
  return h(
    Modal,
    { title, onClose },
    children,
    h('div', { className: 'actions' }, h('button', { className: 'btn ghost', onClick: onClose }, 'Cancelar'), h('button', { className: `btn ${danger ? 'danger' : 'primary'}`, onClick: onConfirm }, confirmLabel)),
  );
}

// ------------------------------------------------------------------ Sucursales

function NameModal({ title, initial = '', onSave, onClose }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(name.trim());
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return h(
    Modal,
    { title, onClose },
    h(
      'form',
      { className: 'form', onSubmit: submit },
      h(Field, { label: 'Nombre' }, h('input', { type: 'text', value: name, maxLength: 80, onChange: (e) => setName(e.target.value), required: true })),
      error && h('div', { className: 'form-error', role: 'alert' }, error),
      h('div', { className: 'actions' }, h('button', { type: 'button', className: 'btn ghost', onClick: onClose }, 'Cancelar'), h('button', { type: 'submit', className: 'btn primary', disabled: busy || !name.trim() }, busy ? 'Guardando…' : 'Guardar')),
    ),
  );
}

function BranchesTab({ reloadBranches, toast }) {
  const { data, loading, error, reload } = useLoad(() => api('GET', '/branches').then((r) => r.branches), []);
  const [modal, setModal] = useState(null);

  async function afterChange(message) {
    setModal(null);
    toast('ok', message);
    await Promise.all([reload(), reloadBranches()]);
  }

  async function toggle(b) {
    try {
      await api('PATCH', `/branches/${b.id}`, { body: { active: !b.active } });
      await afterChange(b.active ? `Sucursal "${b.name}" desactivada.` : `Sucursal "${b.name}" activada.`);
    } catch (err) {
      toast('error', errorText(err));
    }
  }

  return h(
    Fragment,
    null,
    h('div', { className: 'toolbar' }, h('button', { className: 'btn primary', onClick: () => setModal({ type: 'new' }) }, '+ Nueva sucursal')),
    error && h(Banner, { kind: 'error' }, error),
    loading && !data && h(Spinner, null),
    data &&
      h(
        'ul',
        { className: 'list' },
        data.map((b) =>
          h(
            'li',
            { key: b.id, className: `list-row${b.active ? '' : ' off'}` },
            h('div', { className: 'main' }, h('div', { className: 'title' }, b.name), h('div', { className: 'sub' }, b.active ? 'Activa' : 'Inactiva')),
            h('div', { className: 'side' }, h('button', { className: 'btn small ghost', onClick: () => setModal({ type: 'rename', branch: b }) }, 'Renombrar'), h('button', { className: 'btn small ghost', onClick: () => toggle(b) }, b.active ? 'Desactivar' : 'Activar')),
          ),
        ),
      ),
    h('p', { className: 'muted' }, 'Una sucursal no se elimina para conservar su historial. Para desactivarla no puede tener usuarios activos.'),
    modal?.type === 'new' &&
      h(NameModal, {
        title: 'Nueva sucursal',
        onClose: () => setModal(null),
        onSave: async (name) => {
          await api('POST', '/branches', { body: { name } });
          await afterChange(`Sucursal "${name}" creada.`);
        },
      }),
    modal?.type === 'rename' &&
      h(NameModal, {
        title: 'Renombrar sucursal',
        initial: modal.branch.name,
        onClose: () => setModal(null),
        onSave: async (name) => {
          await api('PATCH', `/branches/${modal.branch.id}`, { body: { name } });
          await afterChange('Nombre actualizado.');
        },
      }),
  );
}

// ------------------------------------------------------------------ Usuarios

function UserModal({ mode, user, branches, onSave, onClose }) {
  const creating = mode === 'create';
  const [username, setUsername] = useState(user?.username || '');
  const [name, setName] = useState(user?.name || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(user?.role || 'employee');
  const [branchId, setBranchId] = useState(user?.branchId || branches[0]?.id || '');
  const [active, setActive] = useState(user ? user.active : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (creating && password.length < 8) return setError('La clave inicial debe tener al menos 8 caracteres.');
    setBusy(true);
    try {
      const branch = role === 'employee' ? Number(branchId) : null;
      await onSave(creating ? { username: username.trim(), name: name.trim(), password, role, branchId: branch } : { name: name.trim(), role, branchId: branch, active });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return h(
    Modal,
    { title: creating ? 'Nuevo usuario' : `Editar a ${user.name}`, onClose },
    h(
      'form',
      { className: 'form', onSubmit: submit },
      creating && h(Field, { label: 'Usuario', hint: 'Letras, números, punto y guion. Mínimo 3.' }, h('input', { type: 'text', value: username, autoCapitalize: 'none', onChange: (e) => setUsername(e.target.value), required: true })),
      h(Field, { label: 'Nombre y apellido' }, h('input', { type: 'text', value: name, onChange: (e) => setName(e.target.value), required: true })),
      creating && h(Field, { label: 'Clave inicial', hint: 'La persona tendrá que cambiarla al ingresar.' }, h('input', { type: 'text', autoComplete: 'off', value: password, onChange: (e) => setPassword(e.target.value), required: true })),
      h(
        'div',
        { className: 'form-row' },
        h(Field, { label: 'Rol' }, h('select', { value: role, onChange: (e) => setRole(e.target.value) }, h('option', { value: 'employee' }, 'Empleado'), h('option', { value: 'admin' }, 'Administrador'))),
        role === 'employee' && h(Field, { label: 'Sucursal' }, h('select', { value: branchId, onChange: (e) => setBranchId(e.target.value), required: true }, branches.map((b) => h('option', { key: b.id, value: b.id }, b.name)))),
      ),
      !creating && h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: active, onChange: (e) => setActive(e.target.checked) }), 'Usuario activo'),
      error && h('div', { className: 'form-error', role: 'alert' }, error),
      h('div', { className: 'actions' }, h('button', { type: 'button', className: 'btn ghost', onClick: onClose }, 'Cancelar'), h('button', { type: 'submit', className: 'btn primary', disabled: busy }, busy ? 'Guardando…' : 'Guardar')),
    ),
  );
}

function ResetPasswordModal({ user, onSave, onClose }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (password.length < 8) return setError('La clave debe tener al menos 8 caracteres.');
    setBusy(true);
    try {
      await onSave(password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return h(
    Modal,
    { title: `Reiniciar clave de ${user.name}`, onClose },
    h(
      'form',
      { className: 'form', onSubmit: submit },
      h('p', { className: 'muted' }, 'Elegí una clave temporal y pasásela a la persona. Va a tener que cambiarla al ingresar.'),
      h(Field, { label: 'Clave temporal' }, h('input', { type: 'text', autoComplete: 'off', value: password, onChange: (e) => setPassword(e.target.value), required: true })),
      error && h('div', { className: 'form-error', role: 'alert' }, error),
      h('div', { className: 'actions' }, h('button', { type: 'button', className: 'btn ghost', onClick: onClose }, 'Cancelar'), h('button', { type: 'submit', className: 'btn primary', disabled: busy }, 'Reiniciar clave')),
    ),
  );
}

function UsersTab({ user: me, toast }) {
  const { data, loading, error, reload } = useLoad(async () => {
    const [users, branches] = await Promise.all([api('GET', '/users'), api('GET', '/branches')]);
    return { users: users.users, branches: branches.branches.filter((b) => b.active) };
  }, []);
  const [modal, setModal] = useState(null);

  const done = async (message) => {
    setModal(null);
    toast('ok', message);
    await reload();
  };

  return h(
    Fragment,
    null,
    h('div', { className: 'toolbar' }, h('button', { className: 'btn primary', onClick: () => setModal({ type: 'new' }), disabled: !data }, '+ Nuevo usuario')),
    error && h(Banner, { kind: 'error' }, error),
    loading && !data && h(Spinner, null),
    data &&
      h(
        'ul',
        { className: 'list' },
        data.users.map((u) =>
          h(
            'li',
            { key: u.id, className: `list-row${u.active ? '' : ' off'}` },
            h('div', { className: 'main' }, h('div', { className: 'title' }, u.name, u.id === me.id ? ' (vos)' : ''), h('div', { className: 'sub' }, `${u.username} · ${u.role === 'admin' ? 'Administrador' : `Empleado de ${u.branchName}`}`)),
            h(
              'div',
              { className: 'side' },
              !u.active && h('span', { className: 'tag muted' }, 'Inactivo'),
              u.mustChangePassword && h('span', { className: 'tag warn' }, 'Clave pendiente'),
              h('button', { className: 'btn small ghost', onClick: () => setModal({ type: 'edit', user: u }) }, 'Editar'),
              h('button', { className: 'btn small ghost', onClick: () => setModal({ type: 'reset', user: u }) }, 'Reiniciar clave'),
            ),
          ),
        ),
      ),
    modal?.type === 'new' &&
      h(UserModal, {
        mode: 'create',
        branches: data.branches,
        onClose: () => setModal(null),
        onSave: async (body) => {
          await api('POST', '/users', { body });
          await done(`Usuario "${body.username}" creado.`);
        },
      }),
    modal?.type === 'edit' &&
      h(UserModal, {
        mode: 'edit',
        user: modal.user,
        branches: data.branches,
        onClose: () => setModal(null),
        onSave: async (body) => {
          await api('PATCH', `/users/${modal.user.id}`, { body });
          await done('Usuario actualizado.');
        },
      }),
    modal?.type === 'reset' &&
      h(ResetPasswordModal, {
        user: modal.user,
        onClose: () => setModal(null),
        onSave: async (newPassword) => {
          await api('POST', `/users/${modal.user.id}/reset-password`, { body: { newPassword } });
          await done(`Clave de ${modal.user.name} reiniciada.`);
        },
      }),
  );
}

// ------------------------------------------------------------------ Catálogo

function ProductModal({ product, groups, onSave, onDelete, onClose }) {
  const editing = !!product;
  const [code, setCode] = useState(product ? String(product.code) : '');
  const [name, setName] = useState(product?.name || '');
  const [groupId, setGroupId] = useState(product?.groupId || groups[0]?.id || '');
  const [active, setActive] = useState(product ? product.active : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{1,6}$/.test(code.trim()) || Number(code) < 1) return setError('El código debe ser un número entero positivo (hasta 6 cifras).');
    setBusy(true);
    try {
      await onSave({ code: Number(code), name: name.trim(), groupId: Number(groupId), active });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (confirmDelete) {
    return h(
      Confirm,
      {
        title: 'Eliminar producto',
        danger: true,
        confirmLabel: 'Eliminar',
        onClose: () => setConfirmDelete(false),
        onConfirm: async () => {
          try {
            await onDelete();
          } catch (err) {
            setConfirmDelete(false);
            setError(errorText(err));
          }
        },
      },
      h('p', null, `¿Eliminar "${product.name}"? Solo se puede si nunca tuvo movimientos; si no, desactivalo.`),
    );
  }

  return h(
    Modal,
    { title: editing ? `Editar ${product.name}` : 'Nuevo producto', onClose },
    h(
      'form',
      { className: 'form', onSubmit: submit },
      h('div', { className: 'form-row' }, h(Field, { label: 'Código' }, h('input', { type: 'text', inputMode: 'numeric', value: code, onChange: (e) => setCode(e.target.value), required: true })), h(Field, { label: 'Grupo' }, h('select', { value: groupId, onChange: (e) => setGroupId(e.target.value) }, groups.map((g) => h('option', { key: g.id, value: g.id }, g.name))))),
      h(Field, { label: 'Nombre' }, h('input', { type: 'text', value: name, maxLength: 80, onChange: (e) => setName(e.target.value), required: true })),
      h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: active, onChange: (e) => setActive(e.target.checked) }), 'Activo (aparece para cargar stock)'),
      error && h('div', { className: 'form-error', role: 'alert' }, error),
      h(
        'div',
        { className: 'actions' },
        editing && h('button', { type: 'button', className: 'btn ghost', style: { marginRight: 'auto' }, onClick: () => setConfirmDelete(true) }, 'Eliminar'),
        h('button', { type: 'button', className: 'btn ghost', onClick: onClose }, 'Cancelar'),
        h('button', { type: 'submit', className: 'btn primary', disabled: busy || !name.trim() }, busy ? 'Guardando…' : 'Guardar'),
      ),
    ),
  );
}

function GroupModal({ group, onSave, onDelete, onClose }) {
  const editing = !!group;
  const [name, setName] = useState(group?.name || '');
  const [order, setOrder] = useState(group ? String(group.sortOrder) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (order.trim() !== '' && !/^\d{1,4}$/.test(order.trim())) return setError('El orden debe ser un número entero (0 o más).');
    setBusy(true);
    try {
      await onSave({ name: name.trim(), ...(order.trim() === '' ? {} : { sortOrder: Number(order) }) });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return h(
    Modal,
    { title: editing ? `Editar grupo "${group.name}"` : 'Nuevo grupo', onClose },
    h(
      'form',
      { className: 'form', onSubmit: submit },
      h(Field, { label: 'Nombre' }, h('input', { type: 'text', value: name, maxLength: 80, onChange: (e) => setName(e.target.value), required: true })),
      h(Field, { label: 'Orden', hint: 'Los grupos con número menor aparecen primero. Vacío = al final.' }, h('input', { type: 'text', inputMode: 'numeric', value: order, onChange: (e) => setOrder(e.target.value) })),
      error && h('div', { className: 'form-error', role: 'alert' }, error),
      h(
        'div',
        { className: 'actions' },
        editing &&
          h('button', {
            type: 'button',
            className: 'btn ghost',
            style: { marginRight: 'auto' },
            onClick: async () => {
              try {
                await onDelete();
              } catch (err) {
                setError(errorText(err));
              }
            },
          }, 'Eliminar grupo'),
        h('button', { type: 'button', className: 'btn ghost', onClick: onClose }, 'Cancelar'),
        h('button', { type: 'submit', className: 'btn primary', disabled: busy || !name.trim() }, busy ? 'Guardando…' : 'Guardar'),
      ),
    ),
  );
}

function CatalogTab({ toast }) {
  const { data, loading, error, reload } = useLoad(() => api('GET', '/catalog?includeInactive=1').then((r) => r.groups), []);
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState('');

  const done = async (message) => {
    setModal(null);
    toast('ok', message);
    await reload();
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = normalize(search.trim());
    if (!q) return data;
    return data.map((g) => ({ ...g, products: g.products.filter((p) => normalize(p.name).includes(q) || String(p.code).includes(q)) })).filter((g) => g.products.length > 0);
  }, [data, search]);

  return h(
    Fragment,
    null,
    h(
      'div',
      { className: 'toolbar' },
      h('button', { className: 'btn primary', onClick: () => setModal({ type: 'product' }), disabled: !data || data.length === 0 }, '+ Producto'),
      h('button', { className: 'btn', onClick: () => setModal({ type: 'group' }) }, '+ Grupo'),
    ),
    h('div', { className: 'search-wrap' }, h('span', { className: 'ic', 'aria-hidden': 'true' }, '⌕'), h('input', { type: 'search', placeholder: 'Buscar producto', 'aria-label': 'Buscar producto', value: search, onChange: (e) => setSearch(e.target.value) })),
    error && h(Banner, { kind: 'error' }, error),
    loading && !data && h(Spinner, null),
    data && filtered.length === 0 && h(EmptyState, null, 'No hay productos para mostrar.'),
    filtered.map((g) =>
      h(
        'section',
        { key: g.id },
        h('div', { className: 'group-title' }, g.name, !search && h('button', { className: 'link-btn', onClick: () => setModal({ type: 'group', group: g }) }, 'Editar grupo')),
        h(
          'ul',
          { className: 'list' },
          g.products.map((p) =>
            h(
              'li',
              { key: p.id, className: `list-row${p.active ? '' : ' off'}` },
              h('div', { className: 'main' }, h('div', { className: 'title' }, p.name), h('div', { className: 'sub' }, `Código ${p.code}${p.active ? '' : ' · inactivo'}`)),
              h('div', { className: 'side' }, h('button', { className: 'btn small ghost', onClick: () => setModal({ type: 'product', product: p }) }, 'Editar')),
            ),
          ),
        ),
      ),
    ),
    modal?.type === 'product' &&
      h(ProductModal, {
        product: modal.product,
        groups: data,
        onClose: () => setModal(null),
        onSave: async (body) => {
          if (modal.product) await api('PATCH', `/products/${modal.product.id}`, { body });
          else await api('POST', '/products', { body });
          await done(modal.product ? 'Producto actualizado.' : `Producto "${body.name}" creado. Ya aparece en las semanas abiertas.`);
        },
        onDelete: async () => {
          await api('DELETE', `/products/${modal.product.id}`);
          await done('Producto eliminado.');
        },
      }),
    modal?.type === 'group' &&
      h(GroupModal, {
        group: modal.group,
        onClose: () => setModal(null),
        onSave: async (body) => {
          if (modal.group) await api('PATCH', `/groups/${modal.group.id}`, { body });
          else await api('POST', '/groups', { body });
          await done(modal.group ? 'Grupo actualizado.' : `Grupo "${body.name}" creado.`);
        },
        onDelete: async () => {
          await api('DELETE', `/groups/${modal.group.id}`);
          await done('Grupo eliminado.');
        },
      }),
  );
}

// ------------------------------------------------------------------ Stock mínimo

function MinStockTab({ branches, branch, toast }) {
  const [branchId, setBranchId] = useState(branch.id);
  const { data, loading, error, reload } = useLoad(() => api('GET', `/branches/${branchId}/min-stock`).then((r) => r.items), [branchId]);
  const [values, setValues] = useState({});
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setValues(Object.fromEntries(data.map((i) => [i.productId, qtyToText(i.minQty)])));
  }, [data]);

  const original = useMemo(() => Object.fromEntries((data || []).map((i) => [i.productId, qtyToText(i.minQty)])), [data]);
  const dirty = (data || []).filter((i) => (values[i.productId] ?? '') !== original[i.productId]);
  const invalid = dirty.filter((i) => !parseQty(values[i.productId]).ok);

  const shown = useMemo(() => {
    const q = normalize(search.trim());
    return (data || []).filter((i) => !q || normalize(i.name).includes(q) || String(i.code).includes(q));
  }, [data, search]);

  async function save() {
    setSaving(true);
    try {
      const items = dirty.map((i) => {
        const text = (values[i.productId] ?? '').trim();
        return { productId: i.productId, minQty: text === '' ? null : parseQty(text).value };
      });
      await api('PUT', `/branches/${branchId}/min-stock`, { body: { items } });
      toast('ok', `Stock mínimo guardado (${items.length} producto${items.length === 1 ? '' : 's'}).`);
      await reload();
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return h(
    Fragment,
    null,
    h('p', { className: 'muted' }, 'Cuando el stock de hoy de un producto baja de su mínimo, aparece en Alertas. Dejalo vacío para no controlar ese producto.'),
    h(
      'div',
      { className: 'toolbar' },
      h('label', { className: 'form-label', htmlFor: 'min-branch' }, 'Sucursal'),
      h('select', { id: 'min-branch', value: branchId, onChange: (e) => setBranchId(Number(e.target.value)) }, branches.map((b) => h('option', { key: b.id, value: b.id }, b.name))),
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn primary', onClick: save, disabled: saving || dirty.length === 0 || invalid.length > 0 }, saving ? 'Guardando…' : dirty.length ? `Guardar cambios (${dirty.length})` : 'Guardar cambios'),
    ),
    invalid.length > 0 && h(Banner, { kind: 'error' }, 'Hay valores inválidos: usá números de 0 a 100000 con hasta 3 decimales.'),
    h('div', { className: 'search-wrap' }, h('span', { className: 'ic', 'aria-hidden': 'true' }, '⌕'), h('input', { type: 'search', placeholder: 'Buscar producto', 'aria-label': 'Buscar producto', value: search, onChange: (e) => setSearch(e.target.value) })),
    error && h(Banner, { kind: 'error' }, error),
    loading && !data && h(Spinner, null),
    h(
      'ul',
      { className: 'list', style: { marginTop: 12 } },
      shown.map((i) =>
        h(
          'li',
          { key: i.productId, className: 'list-row' },
          h('div', { className: 'main' }, h('div', { className: 'title' }, i.name), h('div', { className: 'sub' }, `${i.groupName} · código ${i.code}`)),
          h('div', { className: 'side' }, h('input', { type: 'text', inputMode: 'decimal', placeholder: 'Sin mínimo', 'aria-label': `Mínimo de ${i.name}`, style: { width: 110, textAlign: 'center' }, value: values[i.productId] ?? '', onChange: (e) => setValues((v) => ({ ...v, [i.productId]: e.target.value })), 'aria-invalid': parseQty(values[i.productId]).ok ? undefined : 'true' })),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ Auditoría

const ACTION_LABELS = {
  login: 'Inicio de sesión',
  login_failed: 'Intento de ingreso fallido',
  change_password: 'Cambio de clave',
  seed_admin: 'Alta del admin inicial',
  branch_create: 'Sucursal creada',
  branch_update: 'Sucursal modificada',
  user_create: 'Usuario creado',
  user_update: 'Usuario modificado',
  user_reset_password: 'Clave reiniciada',
  group_create: 'Grupo creado',
  group_update: 'Grupo modificado',
  group_delete: 'Grupo eliminado',
  product_create: 'Producto creado',
  product_update: 'Producto modificado',
  product_delete: 'Producto eliminado',
  min_stock_update: 'Stock mínimo modificado',
  movements_update: 'Movimientos cargados',
  initial_stock_update: 'Stock inicial modificado',
  week_open: 'Semana abierta',
  week_close: 'Semana cerrada',
  week_import: 'Planilla importada',
  week_export: 'Planilla exportada',
};

function summarize(detail) {
  if (!detail) return '';
  const { changes, items, ...rest } = detail;
  const parts = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  if (Array.isArray(changes)) parts.push(`${changes.length} celda(s)`);
  if (Array.isArray(items)) parts.push(`${items.length} ítem(s)`);
  const text = parts.join(' · ');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

function AuditTab() {
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const PAGE = 25;

  const load = useCallback(
    async (offset) => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ limit: PAGE, offset });
        if (action) q.set('action', action);
        if (from) q.set('from', from);
        if (to) q.set('to', to);
        const res = await api('GET', `/audit?${q}`);
        setEntries((prev) => (offset === 0 ? res.entries : [...prev, ...res.entries]));
        setTotal(res.total);
        setError('');
      } catch (err) {
        setError(err.isNetwork ? 'Sin conexión: la auditoría necesita internet.' : errorText(err));
      } finally {
        setLoading(false);
      }
    },
    [action, from, to],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  return h(
    Fragment,
    null,
    h(
      'div',
      { className: 'toolbar' },
      h('select', { 'aria-label': 'Filtrar por acción', value: action, onChange: (e) => setAction(e.target.value) }, h('option', { value: '' }, 'Todas las acciones'), Object.entries(ACTION_LABELS).map(([k, v]) => h('option', { key: k, value: k }, v))),
      h('input', { type: 'date', 'aria-label': 'Desde', value: from, onChange: (e) => setFrom(e.target.value), style: { width: 'auto' } }),
      h('input', { type: 'date', 'aria-label': 'Hasta', value: to, onChange: (e) => setTo(e.target.value), style: { width: 'auto' } }),
    ),
    h('p', { className: 'muted' }, 'Las fechas del filtro se toman en hora UTC; en la tabla se muestran en tu hora local.'),
    error && h(Banner, { kind: 'error' }, error),
    loading && entries.length === 0 && h(Spinner, null),
    !loading && entries.length === 0 && !error && h(EmptyState, null, 'No hay registros con esos filtros.'),
    entries.length > 0 &&
      h(
        'div',
        { className: 'table-wrap' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, 'Fecha'), h('th', null, 'Usuario'), h('th', null, 'Sucursal'), h('th', null, 'Acción'), h('th', null, 'Detalle'))),
          h('tbody', null, entries.map((e) => h('tr', { key: e.id }, h('td', null, fmtDateTime(e.createdAt)), h('td', null, e.username || '—'), h('td', null, e.branchName || '—'), h('td', null, ACTION_LABELS[e.action] || e.action), h('td', null, summarize(e.detail))))),
        ),
      ),
    entries.length < total && h('div', { className: 'pager' }, h('button', { className: 'btn', disabled: loading, onClick: () => load(entries.length) }, loading ? 'Cargando…' : `Ver más (${total - entries.length})`)),
  );
}

// ------------------------------------------------------------------ Pantalla

export function Admin({ user, branch, branches, reloadBranches, toast }) {
  const [tab, setTab] = useState('branches');
  return h(
    'div',
    null,
    h('h2', { className: 'page-title' }, 'Administración'),
    h('div', { className: 'tabs', role: 'tablist' }, SUBTABS.map(([id, label]) => h('button', { key: id, role: 'tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, label))),
    tab === 'branches' && h(BranchesTab, { reloadBranches, toast }),
    tab === 'users' && h(UsersTab, { user, toast }),
    tab === 'catalog' && h(CatalogTab, { toast }),
    tab === 'min' && h(MinStockTab, { branches, branch, toast }),
    tab === 'audit' && h(AuditTab, null),
  );
}

