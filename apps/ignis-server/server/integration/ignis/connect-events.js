const {disposeAll} = require('../../app/dispose');

function connectEvents({auth,wss,config,watcher,writeCoalescer,bootstrapCache}) {
  const treeReconcile = require('../../cache/reconcile');
  const {createMetadataChannel} = require('../../cache/metadata-channel');
  const {registerCacheListeners} = require('../../cache/listeners');
  treeReconcile.resume();
  const metadataChannel = createMetadataChannel(wss);
  const disposers = [() => metadataChannel.close(),() => treeReconcile.stop()];
  auth.observeSharedSources(watcher,config.getVaultPath);
  const shared = (vault,event) => auth.sharedContentChanged(vault,event);
  watcher.addGlobalListener(shared);
  disposers.push(() => watcher.removeGlobalListener(shared));
  disposers.push(registerCacheListeners({bootstrapCache,metadataChannel,watcher,writeCoalescer}));
  const started = vault => {bootstrapCache.markForRevalidation(vault);treeReconcile.startSchedule(vault);};
  watcher.onWatcherStart(started);
  disposers.push(() => watcher.offWatcherStart(started));
  disposers.push(bootstrapCache.onStaleEntryServed(vault => treeReconcile.scheduleReconcile(vault)));
  const rebuilt = vault => {bootstrapCache.invalidateVault(vault);wss.closeVaultSockets(vault);};
  watcher.onWatcherRebuild(rebuilt);
  disposers.push(() => watcher.offWatcherRebuild(rebuilt));
  disposers.push(writeCoalescer.onFlushGiveUp(absolute => {
    const match = config.vaultForPath(absolute);
    if (match) wss.broadcastToVault(match.vaultId,{type:'write-giveup',path:match.relPath});
  }));
  return () => disposeAll(disposers);
}
module.exports = {connectEvents};
