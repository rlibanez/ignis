const { createHash } = require("node:crypto");

// Callbacks are server-owned and consult the current session and policy.
function createVaultView({ administrator, authorize, uuid, membership }) {
  function select(reference, { candidates = [], allowDefault = false } = {}) {
    // A stale or forbidden explicit selection must never open another vault.
    if (reference !== null && reference !== undefined) {
      return authorize(reference) ? reference : null;
    }
    // Only the initial information request may choose an accessible vault.
    // Reads, writes and bootstrap must keep an explicit vault identity.
    if (!allowDefault) return null;
    return candidates.find(directory => authorize(directory)) ?? null;
  }

  function list(items) {
    return items.filter(item => authorize(item.id)).map(item => ({
      id: item.id,
      name: item.name,
      path: item.path,
      uuid: uuid(item.id),
      ...(membership ? { membership: membership(item.id) } : {}),
    }));
  }

  function info(item) {
    if (!authorize(item.id)) {
      throw Object.assign(new Error("Vault unavailable"), { code: "VAULT_UNAVAILABLE" });
    }
    return {
      id: item.id,
      name: item.name,
      uuid: uuid(item.id),
      ...(membership ? { membership: membership(item.id) } : {}),
      path: "/",
      platform: item.platform,
      version: item.version,
      trustPlugins: true,
    };
  }

  function bootstrap(response) {
    const vault = info(response.vault);
    if (administrator) return {
      ...response, vault, vaultList: list(response.vaultList),
      plugins: (response.plugins || []).map(plugin => typeof plugin === "object" && Array.isArray(plugin.enabledVaults)
        ? { ...plugin, enabledVaults: plugin.enabledVaults.filter(authorize) } : plugin),
    };
    // The route has already filtered this tree using the resource policy.
    const tree = response.tree;
    // New upstream properties must not become visible by default.
    return {
      vault,
      vaultList: list(response.vaultList),
      tree,
      etag: '"' + createHash("sha256").update(JSON.stringify(tree)).digest("hex") + '"',
      configurationMode: "shared",
      plugins: [],
      virtualPlugins: [],
      settings: {
        contentCacheBytes: response.settings?.contentCacheBytes,
        inputCacheBytes: response.settings?.inputCacheBytes,
        inputCacheTtlMs: response.settings?.inputCacheTtlMs,
        directFetchHosts: [],
        devSuppressWriteFailures: false,
        devForceReadingView: false,
      },
    };
  }

  return Object.freeze({ list, info, bootstrap, select });
}

module.exports = { createVaultView };
