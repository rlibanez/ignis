const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");
const { validVaultName } = require("./vault-creation");
const { resolveRegisteredVault } = require("./vault-catalog");
const fail = code => { throw Object.assign(new Error("Vault rename failed"), { code }); };
function audit(db, actor, action, id) {
  db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actor, action, id, Date.now());
}
function absent(io, target) {
  try { io.lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  fail("VAULT_EXISTS");
}
function rejectLegacyAliases(root, vault) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    let real;
    try { real = fs.realpathSync(path.join(root, entry.name)); }
    catch { continue; }
    if (real === vault.path || real.startsWith(vault.path + path.sep) || vault.path.startsWith(real + path.sep))
      fail("VAULT_ALIAS");
  }
}

// Both names remain reserved if anything fails after reservation. Recovery never
// guesses which directory is authoritative and never reverses a filesystem move.
async function renameRegisteredVault(db, root, actor, reference, name, {
  isCurrent, quiesce, invalidate, assertReady = () => {}, io = fs,
} = {}) {
  if (!validVaultName(name)) fail("INVALID_VAULT_NAME");
  const authorize = () => {
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role IN ('admin','user') AND status='active'").get(actor) ||
        typeof isCurrent !== "function" || !isCurrent(true)) fail("SESSION_CHANGED");
    if (!db.prepare("SELECT 1 FROM memberships WHERE vault_id=? AND user_id=? AND role='owner'").get(vault.id, actor))
      fail("VAULT_UNAVAILABLE");
  };
  let vault, identity;
  transaction(db, () => {
    vault = resolveRegisteredVault(db, root, reference);
    authorize();
    if (name === vault.directory) return;
    // Legacy aliases have independent watchers/plugin state. Until that catalog
    // is migrated, do not move their underlying directory behind those clients.
    rejectLegacyAliases(root, vault);
    assertReady(vault.directory);
    if (typeof quiesce !== "function" || typeof invalidate !== "function") fail("VAULT_STATE_CHANGED");
    if (db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=? OR (state='pending' AND source=?)").get(name, name) ||
        db.prepare("SELECT 1 FROM vaults WHERE directory=? OR id=?").get(name, name) ||
        db.prepare("SELECT 1 FROM vault_renames WHERE source=? OR target=?").get(name, name)) fail("VAULT_EXISTS");
    absent(io, path.join(root, name));
    identity = io.lstatSync(vault.path);
    db.prepare("INSERT INTO vault_renames VALUES (?,?,?,?)").run(vault.id, vault.directory, name, Date.now());
    db.prepare("UPDATE vaults SET status='pending' WHERE id=?").run(vault.id);
    audit(db, actor, "begin-rename-vault", vault.id);
  });
  if (name === vault.directory) return { ...vault, path: vault.path };
  const target = path.join(root, name);
  try {
    // Reservation precedes the async watcher shutdown: neither name is routable.
    await quiesce(vault.directory, vault.path);
    transaction(db, () => {
      authorize();
      if (db.prepare("SELECT status FROM vaults WHERE id=?").get(vault.id)?.status !== "pending") fail("VAULT_STATE_CHANGED");
    });
    assertReady(vault.directory);
    rejectLegacyAliases(root, vault);
    const current = io.lstatSync(vault.path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) fail("VAULT_STATE_CHANGED");
    // A host administrator modifying these paths concurrently is outside the
    // single-process lifecycle contract. Never overwrite an observed destination.
    absent(io, target);
    io.renameSync(vault.path, target);
    const fd = io.openSync(root, "r");
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    invalidate(vault.directory, name);
    transaction(db, () => {
      authorize();
      if (db.prepare("SELECT status FROM vaults WHERE id=?").get(vault.id)?.status !== "pending") fail("VAULT_STATE_CHANGED");
      db.prepare("UPDATE vaults SET name=?, directory=?, status='active' WHERE id=?").run(name, name, vault.id);
      db.prepare("DELETE FROM vault_renames WHERE vault_id=?").run(vault.id);
      audit(db, actor, "rename-vault", vault.id);
    });
    return { ...vault, name, directory: name, status: "active", path: target };
  } catch (error) {
    transaction(db, () => {
      db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(vault.id);
      audit(db, actor, "quarantine-rename-vault", vault.id);
    });
    throw error;
  }
}
module.exports = { renameRegisteredVault, rejectLegacyAliases };
