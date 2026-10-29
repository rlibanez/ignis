const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");
const fail = code => { throw Object.assign(new Error("Vault creation failed"), { code }); };
function validVaultName(name) {
  return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 255 &&
    name === name.trim() && !name.startsWith(".") && !name.endsWith(".") &&
    // eslint-disable-next-line no-control-regex
    !/[/\\:*?"<>|\x00-\x1f\x7f]/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name);
}
function audit(db, actor, action, id) {
  db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actor, action, id, Date.now());
}
function createRegisteredVault(db, root, actor, name, { isCurrent, io = fs } = {}) {
  if (!validVaultName(name) || !path.isAbsolute(root)) fail("INVALID_VAULT_NAME");
  const rootStat = io.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("INVALID_VAULT_ROOT");
  const target = path.join(root, name), id = randomUUID();
  const authorize = () => {
    if (typeof actor !== "string" || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active'").get(actor) ||
        typeof isCurrent !== "function" || !isCurrent(true)) fail("SESSION_CHANGED");
  };
  // Durable reservation before touching disk. Pending entries are hidden from discovery.
  transaction(db, () => {
    authorize();
    if (db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=? OR (state='pending' AND source=?)").get(name, name) ||
        db.prepare("SELECT 1 FROM vault_renames WHERE source=? OR target=?").get(name, name) ||
        db.prepare("SELECT 1 FROM vaults WHERE directory=? OR id=? OR directory=?").get(name, name, id)) fail("VAULT_EXISTS");
    db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES (?,?,?,'pending',?)").run(id, name, name, Date.now());
    db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").run(id, actor);
    audit(db, actor, "begin-create-vault", id);
  });
  let created = false, identity = null;
  try {
    io.mkdirSync(target, { mode: 0o700 }); created = true;
    identity = io.lstatSync(target);
    io.mkdirSync(path.join(target, ".obsidian"), { mode: 0o700 });
    for (const directory of [path.join(target, ".obsidian"), target, root]) {
      const fd = io.openSync(directory, "r");
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    }
    transaction(db, () => {
      authorize();
      if (db.prepare("SELECT status FROM vaults WHERE id=?").get(id)?.status !== "pending") fail("VAULT_STATE_CHANGED");
      db.prepare("UPDATE vaults SET status='active' WHERE id=?").run(id);
      audit(db, actor, "create-vault", id);
    });
    return { id, name, directory: name, path: target };
  } catch (error) {
    let cleaned = !created;
    if (created && identity) {
      try {
        const current = io.lstatSync(target);
        if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
          // Never recursively delete: unexpected files or directory replacement are preserved.
          try { io.rmdirSync(path.join(target, ".obsidian")); }
          catch (failure) { if (failure.code !== "ENOENT") throw failure; }
          io.rmdirSync(target); cleaned = true;
        }
      } catch { /* Preserve uncertain disk state in quarantine. */ }
    }
    transaction(db, () => {
      if (cleaned) db.prepare("DELETE FROM vaults WHERE id=?").run(id);
      else db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(id);
      audit(db, actor, cleaned ? "cancel-create-vault" : "quarantine-create-vault", id);
    });
    if (error.code === "EEXIST") fail("VAULT_EXISTS");
    throw error;
  }
}
// Startup recovery never guesses whether a pending directory contains user data.
function quarantinePendingVaults(db) {
  return transaction(db, () => {
    const pending = db.prepare("SELECT id FROM vaults WHERE status='pending'").all();
    for (const { id } of pending) {
      db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(id);
      audit(db, null, "quarantine-interrupted-vault", id);
    }
    return pending.length;
  });
}
function directoryAvailable(db, directory, root) {
  if (directory === ".ignis-trash" || db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=? OR (state='pending' AND source=?)").get(directory, directory)) return false;
  if (db.prepare("SELECT 1 FROM vault_renames WHERE source=? OR target=?").get(directory, directory)) return false;
  const row = db.prepare("SELECT status FROM vaults WHERE directory=?").get(directory);
  if (row && row.status !== "active") return false;
  if (!root) return true;
  // Legacy discovery supports aliases. They must not expose a quarantined tree.
  let candidate;
  try { candidate = fs.realpathSync(path.join(root, directory)); }
  catch (error) { return error.code === "ENOENT" && !row; }
  const realRoot = fs.realpathSync(root);
  const trash = path.join(realRoot, ".ignis-trash");
  if (candidate === trash || candidate.startsWith(trash + path.sep) || trash.startsWith(candidate + path.sep)) return false;
  for (const blocked of db.prepare("SELECT directory FROM vaults WHERE status!='active' UNION SELECT source AS directory FROM vault_renames UNION SELECT target AS directory FROM vault_renames").all()) {
    const blockedPath = path.resolve(realRoot, blocked.directory);
    if (candidate === blockedPath || candidate.startsWith(blockedPath + path.sep) || blockedPath.startsWith(candidate + path.sep)) return false;
  }
  return true;
}
module.exports = { validVaultName, createRegisteredVault, quarantinePendingVaults, directoryAvailable };
