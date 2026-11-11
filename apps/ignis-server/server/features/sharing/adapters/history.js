// Call inside the transaction that changes access. Keep names as they were at
// the time of the change so deleting the live records preserves the history.
function recordPermission(db, actor, resourceId, recipient, previousRole, newRole) {
  if (previousRole === newRole) return;
  db.prepare(`
    INSERT INTO sharing_history (owner_id,actor,resource_id,vault_id,vault_name,path,recipient,previous_role,new_role,cause,created_at)
    SELECT ?,?,r.id,v.id,v.name,r.path,?,?,?,'permission',?
    FROM shared_resources r JOIN vaults v ON v.id=r.vault_id WHERE r.id=?
  `).run(actor.id, actor.login, recipient, previousRole, newRole, Date.now(), resourceId);
}

const revocationFilters = {
  "stop-sharing": "r.id",
  "resource-deleted": "r.id",
  "user-deleted": "g.user_id",
  "vault-deleted": "r.vault_id",
};

function recordRevocations(db, actorId, cause, id) {
  db.prepare(`
    INSERT INTO sharing_history (owner_id,actor,resource_id,vault_id,vault_name,path,recipient,previous_role,new_role,cause,created_at)
    SELECT m.user_id,a.login,r.id,v.id,v.name,r.path,u.login,g.role,NULL,?,?
    FROM shared_resources r
    JOIN vaults v ON v.id=r.vault_id
    JOIN memberships m ON m.vault_id=v.id AND m.role='owner'
    JOIN resource_grants g ON g.resource_id=r.id
    JOIN users u ON u.id=g.user_id
    JOIN users a ON a.id=?
    WHERE ${revocationFilters[cause]}=?
  `).run(cause, Date.now(), actorId, id);
}

const pageSize = 50;
const sortColumns = Object.freeze({
  date: "created_at",
  actor: "lower(actor)",
  resource: "lower(vault_name || ' / ' || path)",
  change: "CASE WHEN new_role IS NULL THEN 3 WHEN previous_role IS NULL THEN 1 ELSE 2 END",
});
function readHistory(db, ownerId, { resource, before, sort = "date", direction = "desc" }) {
  if (typeof sort !== "string" || !Object.hasOwn(sortColumns,sort) || !["asc","desc"].includes(direction)) {
    throw Object.assign(new Error("Invalid history sort"),{code:"INVALID_SHARE"});
  }
  const column = sortColumns[sort];
  const comparator = direction === "asc" ? ">" : "<";
  const conditions = ["owner_id=?"];
  const values = [ownerId];
  if (resource !== null) {
    conditions.push("resource_id=?");
    values.push(resource);
  }
  if (before !== null) {
    conditions.push(`(${column},id) ${comparator} (SELECT ${column},id FROM sharing_history WHERE cursor=? AND ${conditions.join(" AND ")})`);
    values.push(before,...values);
  }
  const rows = db.prepare(`
    SELECT cursor,actor,vault_name AS vault,path,recipient,previous_role AS previousRole,
           new_role AS newRole,cause,created_at AS createdAt
    FROM sharing_history WHERE ${conditions.join(" AND ")} ORDER BY ${column} ${direction},id ${direction} LIMIT ?
  `).all(...values, pageSize + 1);
  const entries = rows.slice(0, pageSize).map(({cursor, ...entry}) => entry);
  return { entries, next: rows.length > pageSize ? rows[pageSize - 1].cursor : null };
}
module.exports = {recordPermission,recordRevocations,readHistory};
