const { createHash } = require("node:crypto");

// Callbacks are server-owned and consult the current session and policy.
function createVaultView({ administrator, authorize, uuid }) {
  function list(items) {
    if (administrator) return items;
    return items.filter(item => authorize(item.id)).map(item => ({
      id: item.id,
      name: item.name,
      uuid: uuid(item.id),
    }));
  }

  function info(item) {
    if (administrator) return item;
    if (!authorize(item.id)) {
      throw Object.assign(new Error("Vault unavailable"), { code: "VAULT_UNAVAILABLE" });
    }
    return {
      id: item.id,
      name: item.name,
      uuid: uuid(item.id),
      path: "/",
      platform: item.platform,
      version: item.version,
      trustPlugins: false,
    };
  }

  function bootstrap(response) {
    if (administrator) return response;
    const vault = info(response.vault);
    // The route has already filtered this tree using the resource policy.
    const tree = response.tree;
    // New upstream properties must not become visible by default.
    return {
      vault,
      vaultList: list(response.vaultList),
      tree,
      etag: '"' + createHash("sha256").update(JSON.stringify(tree)).digest("hex") + '"',
      configurationMode: "private",
      privateConfiguration: response.privateConfiguration,
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

  return Object.freeze({ list, info, bootstrap });
}

module.exports = { createVaultView };
