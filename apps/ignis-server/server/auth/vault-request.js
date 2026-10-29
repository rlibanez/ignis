const { resolveRegisteredVault } = require("./vault-catalog");
const { selectVaultReference } = require("./vault-selection");

// Transitional adapter for administrator-only HTTP routes. Internal caches and
// watchers still use directory names; registered references resolve before routing.
// This does not authorize membership access or register legacy directories.
function resolveVaultRequest(db, vaultRoot, query, body) {
  const resolved = new Map();
  const resolveIdentity = reference => {
    if (resolved.has(reference)) return resolved.get(reference);
    if (db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=?").get(reference))
      throw Object.assign(new Error("Vault unavailable"), { code: "VAULT_UNAVAILABLE" });
    const registered = db.prepare("SELECT 1 FROM vaults WHERE id=? OR directory=?").get(reference, reference);
    const directory = registered ? resolveRegisteredVault(db, vaultRoot, reference).directory : reference;
    resolved.set(reference, directory);
    return directory;
  };
  return selectVaultReference(query, body, { resolveIdentity });
}
module.exports = { resolveVaultRequest };
