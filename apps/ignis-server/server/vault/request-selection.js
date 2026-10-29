const { selectVaultReference } = require("../auth/vault-selection");

// UUID references have already been resolved by the authentication boundary.
// Keep the legacy default only for administrator requests.
function selectRequestVault(req, config, { allowDefault = false } = {}) {
  const reference = selectVaultReference(req.query, req.body);
  if (req.vaultView) {
    return req.vaultView.select(reference, {
      defaultVault: config.defaultVaultId,
      candidates: Object.keys(config.vaults),
      allowDefault,
    });
  }
  // Fail closed if the session identifies a normal account but no view exists.
  if (req.auth?.user.role === "user") return null;
  return reference ?? config.defaultVaultId;
}

module.exports = { selectRequestVault };
