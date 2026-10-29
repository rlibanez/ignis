const config = require("../config");
const { watcher, writeCoalescer } = require("@ignis/server-core");

let wss = null;
const activeWork = new Set();

// Track completion of the handlers themselves, including after a client disconnect.
// Response close alone does not mean an asynchronous file write has completed.
function trackRouterWork(router) {
  for (const layer of router.stack) {
    for (const entry of layer.route?.stack || []) {
      const handler = entry.handle;
      entry.handle = function (req, res, next) {
        let done;
        const completion = new Promise(resolve => { done = resolve; });
        activeWork.add(completion);
        const finish = () => { activeWork.delete(completion); done(); };
        try {
          return Promise.resolve(handler(req, res, next)).then(finish, error => { finish(); next(error); });
        } catch (error) { finish(); next(error); }
      };
    }
  }
}

async function drainRouterWork() {
  let timer;
  try {
    await Promise.race([
      Promise.all(activeWork),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Vault operations still running")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function setWss(w) {
  wss = w;
}

async function withWatcherStopped(vaultId, vaultPath, mutate) {
  const stopping = watcher.stopWatching(vaultId);
  const wasWatching = stopping !== undefined;

  await stopping;

  try {
    return await mutate();
  } catch (e) {
    config.refreshVaults();

    if (wasWatching) {
      try {
        watcher.startWatching(vaultId, vaultPath);
      } catch (err) {
        console.error(
          `[vault] Watcher restore failed for "${vaultId}":`,
          err.message,
        );
      }

      if (wss) {
        wss.closeVaultSockets(vaultId);
      }
    }

    throw e;
  }
}

// Registered lifecycle operations keep failed vaults quarantined; do not restart
// their watcher on failure. Closing sockets also drops per-client listeners.
async function quiesceRegisteredVault(vaultId, vaultPath) {
  if (wss) wss.closeVaultSockets(vaultId);
  await drainRouterWork();
  await watcher.stopWatching(vaultId);
  await writeCoalescer.flushPendingSubtree(vaultPath);
}

module.exports = { setWss, withWatcherStopped, quiesceRegisteredVault, trackRouterWork };
