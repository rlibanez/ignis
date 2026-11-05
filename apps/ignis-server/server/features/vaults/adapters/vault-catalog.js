const fail = code => { throw Object.assign(new Error("Vault unavailable"), { code }); };

// Identity resolution only; callers must authorize access separately.
function resolveRegisteredVault(db, vaultRoot, reference) {
  if (typeof reference !== "string" || !reference || reference.length > 321) fail("VAULT_UNAVAILABLE");
  const matches = db.prepare("SELECT id, name, directory, status, policy_version FROM vaults WHERE id=? OR directory=?").all(reference, reference);
  // Never prefer an ID over an alias belonging to another vault.
  if (matches.length !== 1 || matches[0].status !== "active") fail("VAULT_UNAVAILABLE");
  const vault = matches[0];
  try {
    const location = require("./vault-storage").storagePath(vaultRoot,vault.directory);
    return Object.freeze({...vault,path:location});
  } catch { fail("VAULT_UNAVAILABLE"); }
}

function listRegisteredVaults(db) {
  return db.prepare("SELECT id, name, directory, status FROM vaults ORDER BY name, id").all();
}
module.exports = { resolveRegisteredVault, listRegisteredVaults };
