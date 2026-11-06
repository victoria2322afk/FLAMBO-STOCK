import { forbidden, notFound } from './http.js';

export function isAdmin(user) {
  return user.role === 'admin';
}

/** Un admin accede a todas las sucursales; un empleado solo a la suya. */
export function canAccessBranch(user, branchId) {
  return isAdmin(user) || user.branchId === branchId;
}

/** Valida existencia y permiso sobre una sucursal. Devuelve la fila de la sucursal. */
export function requireBranch(db, user, branchId) {
  const branch = db.get('SELECT id, name, active FROM branches WHERE id = ?', branchId);
  if (!branch) throw notFound('La sucursal no existe.');
  if (!canAccessBranch(user, branch.id)) throw forbidden('No tenés acceso a esa sucursal.');
  return branch;
}
