const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");
const { resolveRegisteredVault } = require("./vault-catalog");
const { rejectLegacyAliases } = require("./vault-rename");
const fail = code => { throw Object.assign(new Error("Vault deletion failed"), { code }); };
function audit(db, actor, action, id) {
  db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actor, action, id, Date.now());
}
function syncDirectory(io, directory) {
  const fd = io.openSync(directory, "r");
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function trashDirectory(root, io, create = false) {
  const rootStat = io.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("VAULT_STATE_CHANGED");
  const trash = path.join(root, ".ignis-trash");
  if (create) {
    try { io.mkdirSync(trash, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = io.lstatSync(trash);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("VAULT_STATE_CHANGED");
  return trash;
}
function sameDirectory(stat, record) {
  return stat.isDirectory() && !stat.isSymbolicLink() && String(stat.dev) === record.device && String(stat.ino) === record.inode;
}

// Only a committed retirement authorizes irreversible cleanup. Never purge a
// pending/quarantined operation or a replacement directory, even on restart.
async function purgeRetiredVault(db, root, id, { io = fs } = {}) {
  const record = db.prepare("SELECT * FROM vault_deletions WHERE vault_id=? AND state='retired'").get(id);
  if (!record) return false;
  try {
    if (!/^[a-f0-9-]{36}$/.test(record.trash_name)) return false;
    const trash = trashDirectory(root, io);
    const target = path.join(trash, record.trash_name);
    let stat;
    try { stat = io.lstatSync(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) {
      if (!sameDirectory(stat, record)) return false;
      await io.promises.rm(target, { recursive: true, force: false });
    }
    syncDirectory(io, trash);
    transaction(db, () => {
      db.prepare("UPDATE vault_deletions SET state='purged' WHERE vault_id=? AND state='retired'").run(id);
      audit(db, null, "purge-vault", id);
    });
    return true;
  } catch { return false; } // Retry on restart; never fall back to the old path.
}
async function purgeRetiredVaults(db, root) {
  for (const { vault_id } of db.prepare("SELECT vault_id FROM vault_deletions WHERE state='retired'").all()) {
    await purgeRetiredVault(db, root, vault_id);
  }
}

async function deleteRegisteredVault(db, root, actor, id, {
  isCurrent, quiesce, invalidate, assertReady = () => {}, io = fs,
} = {}) {
  const authorize = () => {
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active'").get(actor) ||
        typeof isCurrent !== "function" || !isCurrent(true)) fail("SESSION_CHANGED");
  };
  let vault, record;
  transaction(db, () => {
    authorize();
    vault = resolveRegisteredVault(db, root, id);
    if (id !== vault.id) fail("VAULT_ID_REQUIRED");
    if (typeof quiesce !== "function" || typeof invalidate !== "function") fail("VAULT_STATE_CHANGED");
    rejectLegacyAliases(root, vault);
    assertReady(vault.directory);
    const stat = io.lstatSync(vault.path);
    record = { device: String(stat.dev), inode: String(stat.ino), trash_name: randomUUID() };
    db.prepare("INSERT INTO vault_deletions VALUES (?,?,?,?,?,'pending',?)").run(id, vault.directory, record.trash_name, record.device, record.inode, Date.now());
    db.prepare("UPDATE vaults SET status='pending' WHERE id=?").run(id);
    audit(db, actor, "begin-delete-vault", id);
  });
  try {
    await quiesce(vault.directory, vault.path);
    transaction(db, () => {
      authorize();
      if (db.prepare("SELECT status FROM vaults WHERE id=?").get(id)?.status !== "pending") fail("VAULT_STATE_CHANGED");
    });
    assertReady(vault.directory);
    rejectLegacyAliases(root, vault);
    if (!sameDirectory(io.lstatSync(vault.path), record)) fail("VAULT_STATE_CHANGED");
    const trash = trashDirectory(root, io, true);
    const target = path.join(trash, record.trash_name);
    try { io.lstatSync(target); fail("VAULT_STATE_CHANGED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    io.renameSync(vault.path, target);
    syncDirectory(io, trash);
    syncDirectory(io, root);
    invalidate(vault.directory);
    transaction(db, () => {
      authorize();
      if (db.prepare("SELECT status FROM vaults WHERE id=?").get(id)?.status !== "pending") fail("VAULT_STATE_CHANGED");
      db.prepare("DELETE FROM vaults WHERE id=?").run(id); // Memberships cascade.
      db.prepare("UPDATE vault_deletions SET state='retired' WHERE vault_id=?").run(id);
      audit(db, actor, "delete-vault", id);
    });
  } catch (error) {
    transaction(db, () => {
      db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(id);
      audit(db, actor, "quarantine-delete-vault", id);
    });
    throw error;
  }
  const purged = await purgeRetiredVault(db, root, id, { io });
  return { id, directory: vault.directory, cleanupPending: !purged };
}
module.exports = { deleteRegisteredVault, purgeRetiredVault, purgeRetiredVaults };
