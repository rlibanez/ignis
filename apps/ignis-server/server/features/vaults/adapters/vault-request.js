const { resolveRegisteredVault } = require("./vault-catalog.js");
const { selectVaultReference } = require("../application/vault-selection.js");

// Resolve every explicit reference through the registered catalog. No physical-name fallback.
function resolveVaultRequest(db, vaultRoot, query, body) {
  const resolved = new Map();
  const resolveIdentity = reference => {
    if (resolved.has(reference)) return resolved.get(reference);
    if (db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=?").get(reference))
      throw Object.assign(new Error("Vault unavailable"), { code: "VAULT_UNAVAILABLE" });
    const directory = resolveRegisteredVault(db, vaultRoot, reference).directory;
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
