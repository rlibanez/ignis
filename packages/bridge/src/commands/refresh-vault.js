
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { Notice } from "obsidian";
import { vaultService } from "@ignis/services";

function registerRefreshVault(plugin) {
  plugin.addCommand({
    id: "refresh-vault-from-disk",
    name: translateIgnis("Refresh vault from disk"),
    callback: async () => {
      try {
        const result = await vaultService.refreshVault(
          vaultService.getCurrentVaultId(),
        );

        new Notice(
          result.drifted ? translateIgnis("Vault refreshed") : translateIgnis("Vault already up to date"),
        );
      } catch (e) {
        new Notice(translateIgnis("Refresh failed: {p0}", {p0: (e.message)}));
      }
    },
  });
}

export { registerRefreshVault };
