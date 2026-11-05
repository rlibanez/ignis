// Shared by owner-initiated vault removal and explicit administrator account deletion.
function deletionLifecycle() {
  const config = require("../config");
  const cache = require("../cache");
  const settings = require("../settings");
  const reconcile = require("../cache/reconcile");
  return {
    assertReady(id) {
      if (require("../plugin-system/manager").getDiscoveredPlugins().some(plugin => plugin.enabledVaults.includes(id)))
        throw Object.assign(new Error("Disable server plugins before deleting"), { code:"VAULT_BUSY" });
    },
    async quiesce(id, vaultPath, options) {
      reconcile.cancelVault(id);
      await require("./lifecycle").quiesceRegisteredVault(id,vaultPath,options);
    },
    invalidate(id, next) {
      reconcile.cancelVault(id);
      cache.invalidateVault(id);
      if(next)cache.invalidateVault(next);
      const trusted = settings.get("trustedVaults");
      if (trusted.includes(id)) settings.update({trustedVaults:next ? trusted.map(value=>value===id?next:value) : trusted.filter(value => value !== id)});
    },
    refresh() { config.refreshVaults(); },
  };
}
module.exports = { deletionLifecycle };
