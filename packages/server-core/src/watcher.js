const chokidar = require("chokidar");
const path = require("path");
const ignore = require("ignore");
const { toVaultRel } = require("./path-utils");
const { creationTime } = require("./file-times");

const DEFAULT_IGNORED_PATHS = [".git"];

function compileIgnoreList(patterns) {
  // escape '#' to avoid treating it like a gitignore comment
  const lines = patterns.map((line) =>
    line.startsWith("#") ? "\\" + line : line,
  );

  return ignore({ allowRelativePaths: true }).add(lines);
}

let ignoreList = compileIgnoreList(DEFAULT_IGNORED_PATHS);

function canCompileIgnorePattern(pattern) {
  try {
    compileIgnoreList([pattern]).ignores("a/b");
    return true;
  } catch {
    return false;
  }
}

function configure(opts) {
  if (Array.isArray(opts?.ignoredPaths)) {
    ignoreList = compileIgnoreList(opts.ignoredPaths);
  }
}

function isIgnoredPath(p) {
  const rel = toVaultRel(p);

  if (rel === "") {
    return false;
  }

  try {
    return ignoreList.ignores(rel);
  } catch {
    return false;
  }
}

// Idle window before a watcher with no listeners stops.
const IDLE_STOP_MS = 10 * 60 * 1000;

let idleStopMs = IDLE_STOP_MS;

// Per-vault chokidar watchers
// Map<vaultId, { watcher, listeners: Set<fn>, vaultPath, idleTimer, ready, errorCount, firstError, enospc }>
const vaultWatchers = new Map();

// Set<fn(vaultId, event)>, fires for events on all vaults
const globalListeners = new Set();

// Set<fn(vaultId, info)>, fires once per watcher ready
const startListeners = new Set();

// Set<fn(vaultId)>, fires on watcher teardown
const rebuildListeners = new Set();

function cancelIdleStop(entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

function countTrackedPaths(watchedDirs) {
  return Object.values(watchedDirs).reduce(
    (acc, names) => acc + names.length,
    0,
  );
}

function notifyStart(vaultId, info) {
  for (const fn of startListeners) {
    try {
      fn(vaultId, info);
    } catch (e) {
      require("./logger").emit("error", "core.watcher.start_listener_failed", { errorCode: e?.code });
    }
  }
}

function notifyRebuild(vaultId) {
  for (const fn of rebuildListeners) {
    try {
      fn(vaultId);
    } catch (e) {
      require("./logger").emit("error", "core.watcher.rebuild_listener_failed", { errorCode: e?.code });
    }
  }
}

function isDead(entry) {
  return entry.ready && countTrackedPaths(entry.watcher.getWatched()) === 0;
}

function startWatching(vaultId, vaultPath) {
  const existing = vaultWatchers.get(vaultId);
  let rebuilt = false;

  if (existing) {
    if (!isDead(existing)) {
      cancelIdleStop(existing);

      return existing;
    }

    require("./logger").emit("warn", "core.watcher.rebuilding");
    stopWatching(vaultId);
    notifyRebuild(vaultId);
    rebuilt = true;
  }

  const watcher = chokidar.watch(vaultPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
    ignored: (fullPath) => isIgnoredPath(path.relative(vaultPath, fullPath)),
  });

  const entry = {
    watcher,
    listeners: new Set(),
    vaultPath,
    idleTimer: null,
    ready: false,
    errorCount: 0,
    firstError: null,
    enospc: false,
  };

  function emit(type, fullPath, stat) {
    const rel = toVaultRel(path.relative(vaultPath, fullPath));

    const event = { type, path: rel };

    if (stat) {
      event.stat = {
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: creationTime(stat),
      };
    }

    for (const fn of entry.listeners) {
      try {
        fn(event);
      } catch (e) {
        require("./logger").emit("error", "core.watcher.listener_failed", { errorCode: e?.code });
      }
    }

    for (const fn of globalListeners) {
      try {
        fn(vaultId, event);
      } catch (e) {
        require("./logger").emit("error", "core.watcher.global_listener_failed", { errorCode: e?.code });
      }
    }
  }

  watcher
    .on("add", (fullPath, stats) => {
      emit("created", fullPath, stats || null);
    })
    .on("change", (fullPath, stats) => {
      emit("modified", fullPath, stats || null);
    })
    .on("unlink", (fullPath) => {
      emit("deleted", fullPath, null);
    })
    .on("addDir", (fullPath) => {
      // Skip vault root itself
      if (path.resolve(fullPath) === path.resolve(vaultPath)) return;
      emit("folder-created", fullPath, null);
    })
    .on("unlinkDir", (fullPath) => {
      emit("deleted", fullPath, null);
    })
    .on("error", (err) => {
      if (entry.ready) {
        require("./logger").emit("error", "core.watcher.runtime_error", { errorCode: err.code, vaultId });

        return;
      }

      entry.errorCount++;
      entry.enospc = entry.enospc || err.code === "ENOSPC";

      if (entry.errorCount === 1) {
        entry.firstError = {
          message: err.message,
          code: err.code,
          path: err.path,
        };

        require("./logger").emit("error", "core.watcher.initial_error", { errorCode: err.code, vaultId });
      }
    })
    .on("ready", () => {
      entry.ready = true;

      const tracked = countTrackedPaths(watcher.getWatched());

      if (entry.errorCount === 0) {
        require("./logger").emit("info", "core.watcher.ready", { count: tracked, vaultId });
      } else {
        require("./logger").emit("warn", "core.watcher.ready_with_errors", { count: entry.errorCount, errorCode: entry.enospc ? "ENOSPC" : undefined, vaultId });
      }

      notifyStart(vaultId, { rebuilt, tracked, errors: entry.errorCount });
    });

  vaultWatchers.set(vaultId, entry);
  entry.idleTimer = setTimeout(() => stopWatching(vaultId), idleStopMs);
  require("./logger").emit("info", "core.watcher.started");

  return entry;
}

function stopWatching(vaultId) {
  const entry = vaultWatchers.get(vaultId);

  if (!entry) {
    return;
  }

  cancelIdleStop(entry);
  entry.listeners.clear();
  vaultWatchers.delete(vaultId);
  require("./logger").emit("info", "core.watcher.stopped");

  return entry.watcher.close().catch((e) => {
    require("./logger").emit("error", "core.watcher.close_failed");
  });
}

function stopAll() {
  const closings = [];

  for (const vaultId of vaultWatchers.keys()) {
    closings.push(stopWatching(vaultId));
    notifyRebuild(vaultId);
  }

  return Promise.all(closings);
}

function isWatching(vaultId) {
  const entry = vaultWatchers.get(vaultId);

  return !!entry && entry.ready;
}

function addGlobalListener(fn) {
  globalListeners.add(fn);
}

function removeGlobalListener(fn) {
  globalListeners.delete(fn);
}

function onWatcherStart(fn) {
  startListeners.add(fn);
}

function offWatcherStart(fn) {
  startListeners.delete(fn);
}

function onWatcherRebuild(fn) {
  rebuildListeners.add(fn);
}

function offWatcherRebuild(fn) {
  rebuildListeners.delete(fn);
}

function addListener(vaultId, fn) {
  const entry = vaultWatchers.get(vaultId);

  if (entry) {
    cancelIdleStop(entry);
    entry.listeners.add(fn);
  }
}

function removeListener(vaultId, fn) {
  const entry = vaultWatchers.get(vaultId);

  if (entry) {
    entry.listeners.delete(fn);

    if (entry.listeners.size === 0) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => stopWatching(vaultId), idleStopMs);
    }
  }
}

// Test-only.
function _setIdleStopMs(ms) {
  idleStopMs = ms ?? IDLE_STOP_MS;
}

function _reset() {
  const closings = [];

  for (const vaultId of vaultWatchers.keys()) {
    closings.push(stopWatching(vaultId));
  }

  globalListeners.clear();
  startListeners.clear();
  rebuildListeners.clear();
  ignoreList = compileIgnoreList(DEFAULT_IGNORED_PATHS);

  return Promise.all(closings);
}

module.exports = {
  configure,
  startWatching,
  stopWatching,
  stopAll,
  isWatching,
  isIgnoredPath,
  canCompileIgnorePattern,
  addListener,
  removeListener,
  addGlobalListener,
  removeGlobalListener,
  onWatcherStart,
  offWatcherStart,
  onWatcherRebuild,
  offWatcherRebuild,
  _setIdleStopMs,
  _reset,
};
