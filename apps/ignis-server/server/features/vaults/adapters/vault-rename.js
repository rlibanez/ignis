const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { transaction } = require("../../../platform/persistence/database");
const {ownedDirectory,ensureUserDirectory,storagePath,assertAvailable}=require("./vault-storage");
const { validVaultName } = require("../application/vault-name");
const { resolveRegisteredVault } = require("./vault-catalog.js");
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
  const folders=[root];
  for(const entry of fs.readdirSync(root,{withFileTypes:true}))if(entry.isDirectory()&&!entry.name.startsWith('.'))folders.push(path.join(root,entry.name));
  for(const folder of folders)for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    let real;
    try { real = fs.realpathSync(path.join(folder, entry.name)); }
    catch { continue; }
    if (real === vault.path || real.startsWith(vault.path + path.sep) || vault.path.startsWith(real + path.sep))
      fail("VAULT_ALIAS");
  }
}

// A new owner must choose which of the transferred plugins to activate.
function clearCommunityPluginActivation(io, vaultPath) {
  const config = path.join(vaultPath, ".obsidian");
  const activation = path.join(config, "community-plugins.json");
  try {
    if (!io.lstatSync(config).isDirectory() || !io.lstatSync(activation).isFile()) fail("VAULT_STATE_CHANGED");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const temporary = path.join(config, ".ignis-transfer-" + randomUUID());
  const fd = io.openSync(temporary, "wx", 0o600);
  try {
    try { io.writeFileSync(fd, "[]"); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    io.renameSync(temporary, activation);
    const directory = io.openSync(config, "r");
    try { io.fsyncSync(directory); } finally { io.closeSync(directory); }
  } finally { io.rmSync(temporary, {force:true}); }
}

// Both names remain reserved if anything fails after reservation. Recovery never
// guesses which directory is authoritative and never reverses a filesystem move.
async function renameRegisteredVault(db, root, actor, reference, name, {
  isCurrent, quiesce, invalidate, assertReady = () => {}, io = fs,
  ownerId = actor, validate = () => {}, apply = () => {}, action = "rename-vault",
} = {}) {
  if (!validVaultName(name)) fail("INVALID_VAULT_NAME");
  const authorize = () => {
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role IN ('admin','user') AND status='active'").get(actor) ||
        typeof isCurrent !== "function" || !isCurrent(true)) fail("SESSION_CHANGED");
    if (!db.prepare("SELECT 1 FROM memberships WHERE vault_id=? AND user_id=? AND role='owner'").get(vault.id, actor))
      fail("VAULT_UNAVAILABLE");
  };
  let vault, identity, directory, target;
  transaction(db, () => {
    vault = resolveRegisteredVault(db, root, reference);
    authorize();
    validate(vault);
    directory=ownedDirectory(db,ownerId,name);
    if (directory === vault.directory) return;
    // Legacy aliases have independent watchers/plugin state. Until that catalog
    // is migrated, do not move their underlying directory behind those clients.
    rejectLegacyAliases(root, vault);
    assertReady(vault.directory);
    if (typeof quiesce !== "function" || typeof invalidate !== "function") fail("VAULT_STATE_CHANGED");
    assertAvailable(db,root,directory);
    ensureUserDirectory(root,directory,io);
    target=storagePath(root,directory,{io,missingLeaf:true});
    identity = io.lstatSync(vault.path);
    db.prepare("INSERT INTO vault_renames VALUES (?,?,?,?)").run(vault.id, vault.directory, directory, Date.now());
    db.prepare("UPDATE vaults SET status='pending' WHERE id=?").run(vault.id);
    audit(db, actor, "begin-"+action, vault.id);
  });
  if (directory === vault.directory) return { ...vault, previousDirectory: vault.directory, path: vault.path };
  try {
    // Reservation precedes the async watcher shutdown: neither name is routable.
    await quiesce(vault.directory, vault.path, {relocating:ownerId!==actor});
    transaction(db, () => {
      authorize();
      validate(vault);
      if (db.prepare("SELECT status FROM vaults WHERE id=?").get(vault.id)?.status !== "pending") fail("VAULT_STATE_CHANGED");
    });
    assertReady(vault.directory);
    rejectLegacyAliases(root, vault);
    try {storagePath(root,vault.directory,{io});storagePath(root,directory,{io,missingLeaf:true});}
    catch {fail("VAULT_STATE_CHANGED");}
    const current = io.lstatSync(vault.path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) fail("VAULT_STATE_CHANGED");
    // A host administrator modifying these paths concurrently is outside the
    // single-process lifecycle contract. Never overwrite an observed destination.
    absent(io, target);
    io.renameSync(vault.path, target);
    if (ownerId !== actor) clearCommunityPluginActivation(io, target);
    for(const folder of new Set([path.dirname(vault.path),path.dirname(target),root])) {
      const fd=io.openSync(folder,"r");try {io.fsyncSync(fd);}finally {io.closeSync(fd);}
    }
    if (ownerId !== actor) invalidate(vault.directory, directory, {ownershipChanged:true});
    else invalidate(vault.directory, directory);
    transaction(db, () => {
      authorize();
      validate(vault);
      if (db.prepare("SELECT status FROM vaults WHERE id=?").get(vault.id)?.status !== "pending") fail("VAULT_STATE_CHANGED");
      storagePath(root,directory,{io});
      const published=io.lstatSync(target);
      if(published.dev!==identity.dev || published.ino!==identity.ino)fail("VAULT_STATE_CHANGED");
      db.prepare("UPDATE vaults SET name=?, directory=?, status='active' WHERE id=?").run(name, directory, vault.id);
      db.prepare("DELETE FROM vault_renames WHERE vault_id=?").run(vault.id);
      apply(vault);
      audit(db, actor, action, vault.id);
    });
    return { ...vault, previousDirectory: vault.directory, name, directory, status: "active", path: target };
  } catch (error) {
    transaction(db, () => {
      db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(vault.id);
      audit(db, actor, "quarantine-"+action, vault.id);
    });
    throw error;
  }
}
module.exports = { renameRegisteredVault, rejectLegacyAliases };
