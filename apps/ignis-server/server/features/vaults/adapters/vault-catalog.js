const fs = require("node:fs");
const path = require("node:path");
const fail = code => { throw Object.assign(new Error("Vault unavailable"), { code }); };

// Identity resolution only; callers must authorize access separately.
function resolveRegisteredVault(db, vaultRoot, reference) {
  if (typeof reference !== "string" || !reference || reference.length > 255) fail("VAULT_UNAVAILABLE");
  const matches = db.prepare("SELECT id, name, directory, status, policy_version FROM vaults WHERE id=? OR directory=?").all(reference, reference);
  // Never prefer an ID over an alias belonging to another vault.
  if (matches.length !== 1 || matches[0].status !== "active") fail("VAULT_UNAVAILABLE");
  const vault = matches[0];
  if (!path.isAbsolute(vaultRoot) || typeof vault.directory !== "string" || !vault.directory || vault.directory.startsWith(".") ||
      // eslint-disable-next-line no-control-regex
      /[/\\\x00-\x1f\x7f]/.test(vault.directory)) fail("VAULT_UNAVAILABLE");
  try {
    const rootStat = fs.lstatSync(vaultRoot);
    const directoryPath = path.join(vaultRoot, vault.directory);
    const stat = fs.lstatSync(directoryPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()) fail("VAULT_UNAVAILABLE");
    const realRoot = fs.realpathSync(vaultRoot);
    const realPath = fs.realpathSync(directoryPath);
    if (path.dirname(realPath) !== realRoot) fail("VAULT_UNAVAILABLE");
    return Object.freeze({ ...vault, path: realPath });
  } catch { fail("VAULT_UNAVAILABLE"); }
}

function listRegisteredVaults(db) {
  return db.prepare("SELECT id, name, directory, status FROM vaults ORDER BY name, id").all();
}
module.exports = { resolveRegisteredVault, listRegisteredVaults };
