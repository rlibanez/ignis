const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { transaction } = require("./database");
const { validVaultName, directoryAvailable } = require("./vault-creation");
const { rejectLegacyAliases } = require("./vault-rename");

const messages = {
  INVALID_DIRECTORY: "Vault directory must be one visible directory name",
  INVALID_ROOT: "Vault root must be a real directory",
  INVALID_VAULT: "Vault must be a real directory",
  VAULT_ALIAS: "Remove legacy symlink aliases before registering this vault",
  VAULT_RESERVED: "Vault directory or identity is already registered or reserved",
  OWNER_UNAVAILABLE: "Owner must be an active user",
  SESSION_CHANGED: "Administrator authentication required",
  DIRECTORY_CHANGED: "The directory changed. Reload the vault list and try again",
};
function fail(code) { throw Object.assign(new Error(messages[code]), { code }); }

// This is a stale-selection check, not an authentication token. No file content
// or directory mtime is included: normal note edits do not invalidate selection.
function inspectDirectory(root, directory) {
  if (!path.isAbsolute(root) || !validVaultName(directory)) fail("INVALID_DIRECTORY");
  let rootStat, stat, realRoot, realPath;
  try {
    rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("INVALID_ROOT");
    realRoot = fs.realpathSync(root);
    const location = path.join(root, directory);
    stat = fs.lstatSync(location);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_VAULT");
    realPath = fs.realpathSync(location);
    if (path.dirname(realPath) !== realRoot) fail("INVALID_VAULT");
  } catch (error) {
    if (messages[error.code]) throw error;
    fail("INVALID_VAULT");
  }
  const identity = createHash("sha256").update(JSON.stringify([
    realRoot, String(rootStat.dev), String(rootStat.ino), rootStat.birthtimeMs,
    directory, String(stat.dev), String(stat.ino), stat.birthtimeMs,
  ])).digest("hex");
  return { identity, path: realPath };
}
function requireUnregistered(db, root, directory) {
  if (db.prepare("SELECT 1 FROM vaults WHERE directory=? OR id=?").get(directory, directory) ||
      !directoryAvailable(db, directory, root)) fail("VAULT_RESERVED");
}

function registrationOptions(db, root) {
  if (!path.isAbsolute(root)) fail("INVALID_ROOT");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_ROOT");
  const vaults = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        db.prepare("SELECT 1 FROM vaults WHERE directory=?").get(entry.name)) continue;
    try {
      const snapshot = inspectDirectory(root, entry.name);
      requireUnregistered(db, root, entry.name);
      rejectLegacyAliases(root, snapshot);
      vaults.push({ directory: entry.name, identity: snapshot.identity, eligible: true });
    } catch (error) {
      vaults.push({ directory: entry.name, eligible: false, reason: messages[error.code] || "Vault cannot be registered" });
    }
  }
  return {
    vaults: vaults.sort((a, b) => a.directory.localeCompare(b.directory)),
    owners: db.prepare("SELECT id,login FROM users WHERE status='active' ORDER BY login,id").all(),
  };
}

// Local CLI calls are privileged by host access. HTTP callers must supply their
// session actor and the snapshot explicitly; ownership is never inferred.
function registerExistingVault(db, root, directory, ownerId, {
  actorId = null, isCurrent, expectedIdentity,
} = {}) {
  return transaction(db, () => {
    if (actorId !== null && (
      !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active'").get(actorId) ||
      typeof isCurrent !== "function" || !isCurrent(true)
    )) fail("SESSION_CHANGED");
    if (typeof ownerId !== "string" || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(ownerId)) fail("OWNER_UNAVAILABLE");
    const snapshot = inspectDirectory(root, directory);
    requireUnregistered(db, root, directory);
    rejectLegacyAliases(root, snapshot);
    if ((actorId !== null || expectedIdentity !== undefined) && expectedIdentity !== snapshot.identity) fail("DIRECTORY_CHANGED");
    const id = randomUUID();
    if (db.prepare("SELECT 1 FROM vaults WHERE directory=? OR id=?").get(id, id)) fail("VAULT_RESERVED");
    db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES (?,?,?,'active',?)").run(id, directory, directory, Date.now());
    db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").run(id, ownerId);
    db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?)").run(randomUUID(), actorId, actorId === null ? "register-vault-local" : "register-vault", id, Date.now());
    // A failed final check rolls back identity, owner and audit together.
    if (inspectDirectory(root, directory).identity !== snapshot.identity) fail("DIRECTORY_CHANGED");
    return { id, name: directory };
  });
}
module.exports = { registrationOptions, registerExistingVault, inspectDirectory, messages };
