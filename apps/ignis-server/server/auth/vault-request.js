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
function resolvePluginVaultRequest(db, vaultRoot, query, body, field) {
  const invalid = () => { throw Object.assign(new Error("Invalid vault selection"), { code: "INVALID_VAULT_SELECTION" }); };
  const other = field === "vaultId" ? "vault" : "vaultId";
  if ([query, body].some(source => source && Object.hasOwn(source, other))) invalid();
  const select = source => source && Object.hasOwn(source, field) ? { vault: source[field] } : {};
  const directory = resolveVaultRequest(db, vaultRoot, select(query), select(body));
  if (directory === null) invalid();
  return directory;
}
module.exports = { resolveVaultRequest, resolvePluginVaultRequest };
