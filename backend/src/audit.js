/** Registra una acción en el registro de auditoría. */
export function audit(db, now, { userId = null, branchId = null, action, entity = null, entityId = null, detail = null }) {
  db.run(
    `INSERT INTO audit_log (user_id, branch_id, action, entity, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId,
    branchId,
    action,
    entity,
    entityId === null || entityId === undefined ? null : String(entityId),
    detail === null ? null : JSON.stringify(detail),
    now().toISOString(),
  );
}
