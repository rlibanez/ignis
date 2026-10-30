const { selectVaultReference } = require("../auth/vault-selection");

// UUID references have already been resolved by the authentication boundary.
// Authenticated requests must always carry an authorized view.
function selectRequestVault(req, config, { allowDefault = false } = {}) {
  const reference = selectVaultReference(req.query, req.body);
  if (req.vaultView) {
    return req.vaultView.select(reference, {
      defaultVault: config.defaultVaultId,
      candidates: Object.keys(config.vaults),
      allowDefault,
    });
  }
  // Fail closed for every authenticated role if no view exists.
  if (req.auth) return null;
  return reference ?? config.defaultVaultId;
}

module.exports = { selectRequestVault };
