const config = require("../config");

function registerCacheListeners({
  bootstrapCache,
  metadataChannel,
  watcher,
  writeCoalescer,
}) {
  const offSwap = bootstrapCache.onEntrySwapped((vaultId, revision) =>
    metadataChannel.reportReplacement(vaultId, revision),
  );

  const offInvalidated = bootstrapCache.onVaultInvalidated((vaultId) =>
    metadataChannel.forgetVault(vaultId),
  );

  const changed = (vaultId, event) => {
    bootstrapCache.applyMutation(vaultId, event).then(
      (revision) => {
        try {
          metadataChannel.reportRevision(vaultId, revision);
        } catch (e) {
          require("@ignis/server-core/src/logger").emit("warn", "server.cache.listeners.revision_failed", { errorCode: e?.code });
        }
      },
      (e) =>
        require("@ignis/server-core/src/logger").emit("warn", "server.cache.listeners.event_failed"),
    );
  };
  watcher.addGlobalListener(changed);

  const offFlush = writeCoalescer.onFlushSuccess((absPath) => {
    const match = config.vaultForPath(absPath);

    if (!match) {
      return;
    }

    // no stat, read mtime from disk.
    bootstrapCache
      .applyMutation(match.vaultId, { type: "modified", path: match.relPath })
      .catch((e) =>
        require("@ignis/server-core/src/logger").emit("warn", "server.cache.listeners.flush_failed"),
      );
  });
  return () => {offSwap();offInvalidated();offFlush();watcher.removeGlobalListener(changed);};
}

module.exports = { registerCacheListeners };
