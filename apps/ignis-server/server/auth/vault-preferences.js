const { transaction } = require("./database");
const { resolveRegisteredVault } = require("./vault-catalog");

const files = new Set(["app.json", "appearance.json", "hotkeys.json", "graph.json", "workspace.json", "workspace-mobile.json", "workspaces.json"]);
const fail = code => { throw Object.assign(new Error("Preferences unavailable"), { code }); };
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_FILE_BYTES;
const MAX_FILES = 40;
function validPath(path) {
  if (typeof path !== "string" || !path.startsWith(".obsidian/")) return false;
  const file = path.slice(10);
  return files.has(file) || /^workspace\.[a-z0-9_-]{1,64}\.json$/.test(file);
}
function validateContent(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) fail("INVALID_PREFERENCES");
  let value;
  try { value = JSON.parse(content); } catch { fail("INVALID_PREFERENCES"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_PREFERENCES");
  const inspect = (node, depth) => {
    if (depth > 32) fail("INVALID_PREFERENCES");
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("INVALID_PREFERENCES");
      inspect(node[key], depth + 1);
    }
  };
  inspect(value, 0);
}

// Internal persistence only: no HTTP overlay yet. Private JSON is never seeded
// from the shared vault or served as executable configuration without projection.
function createVaultPreferencesService(db, vaultRoot, sessions) {
  function identity(token, reference, path) {
    if (!validPath(path)) fail("INVALID_PREFERENCES");
    const session = sessions.resolve(token, { withinTransaction: true });
    if (!session) fail("PREFERENCES_UNAVAILABLE");
    let vault;
    try { vault = resolveRegisteredVault(db, vaultRoot, reference); }
    catch { fail("PREFERENCES_UNAVAILABLE"); }
    const user = db.prepare("SELECT role,status,auth_version FROM users WHERE id=?").get(session.user.id);
    const member = db.prepare("SELECT role FROM memberships WHERE user_id=? AND vault_id=?").get(session.user.id, vault.id);
    if (!user || user.status !== "active" || user.auth_version !== session.user.authVersion ||
        (!["admin", "user"].includes(user.role) || !["reader", "editor", "owner"].includes(member?.role))) fail("PREFERENCES_UNAVAILABLE");
    return { userId: session.user.id, vaultId: vault.id };
  }
  function read(token, { reference, path } = {}) {
    return transaction(db, () => {
      const { userId, vaultId } = identity(token, reference, path);
      const row = db.prepare("SELECT content,revision FROM vault_preferences WHERE user_id=? AND vault_id=? AND path=?").get(userId, vaultId, path);
      return row ? { content: row.content, revision: row.revision } : { content: "{}", revision: 0 };
    });
  }
  function write(token, { reference, path, content, expectedRevision } = {}) {
    return transaction(db, () => {
      const { userId, vaultId } = identity(token, reference, path);
      validateContent(content);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail("INVALID_PREFERENCES");
      const row = db.prepare("SELECT revision FROM vault_preferences WHERE user_id=? AND vault_id=? AND path=?").get(userId, vaultId, path);
      if ((row?.revision || 0) !== expectedRevision) fail("PREFERENCES_CONFLICT");
      const quota = db.prepare("SELECT count(*) n,coalesce(sum(length(CAST(content AS BLOB))),0) bytes FROM vault_preferences WHERE user_id=? AND vault_id=? AND path!=?").get(userId, vaultId, path);
      if (quota.n >= MAX_FILES || quota.bytes + Buffer.byteLength(content) > MAX_TOTAL_BYTES) fail("PREFERENCES_QUOTA");
      const revision = expectedRevision + 1;
      db.prepare(`INSERT INTO vault_preferences(user_id,vault_id,path,content,revision) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id,vault_id,path) DO UPDATE SET content=excluded.content,revision=excluded.revision`).run(userId, vaultId, path, content, revision);
      return { revision };
    });
  }
  return Object.freeze({ read, write });
}
module.exports = { createVaultPreferencesService };
