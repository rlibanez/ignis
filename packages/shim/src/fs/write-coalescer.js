// Coalesces boot-window writes per path so they flush in a few round-trips instead of one per save.

import { markSentOp } from "./echo-guard.js";
import { hasWriteInProgress, trackWrite } from "./write-durability.js";
import { normalize } from "../util/path.js";

const QUIET_MS = 100; // flush a path this long after its last write
const MAX_WAIT_MS = 2000; // but never hold a buffered write longer than this

// Bodies over transport's keepalive cap would not survive a pagehide flush, so they are not coalesced.
export const COALESCE_MAX_BYTES = 32 * 1024;

let transport = null;
let suspended = false;
const queuedWrites = new Map();
let nextQueuedId = 0;
let listenersBound = false;
const pending = new Map(); // path -> { data, encoding, onResult, quiet, max }
const tails = new Map(); // path -> promise serializing that path's in-flight write

// Set by init.js on the bootstrap path, cleared at layout-ready.
export function isBooting() {
  return typeof window !== "undefined" && window.__ignisBooting === true;
}

export function initWriteCoalescer(t) {
  transport = t;

  if (
    listenersBound ||
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  ) {
    return;
  }

  listenersBound = true;

  // Commit buffered writes on pagehide.
  window.addEventListener("pagehide", flushAll);

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushAll();
      }
    });
  }
}

function performWrite(path, data, encoding, onResult, opts) {
  markSentOp(path);
  const track = trackWrite(path, { ...opts, data, encoding });

  return transport.writeFile(path, data, encoding).then(
    (result) => {
      track.success();

      if (result && result.mtime && onResult) {
        onResult(result);
      }

      return result;
    },
    (err) => {
      // put the failed write in the durability queue, which retries it in the background.
      track.failure(data, encoding, onResult, err);
      throw err;
    },
  );
}

// Run a write only after any in-flight write to the same path completes.
export function enqueue(path, run) {
  const prev = tails.get(path) || Promise.resolve();
  const guarded = () => {
    if (suspended) throw new Error("Session locked");
    return run();
  };
  const result = prev.then(guarded, guarded);
  const tail = result.catch(() => {});

  tails.set(path, tail);
  tail.then(() => {
    if (tails.get(path) === tail) {
      tails.delete(path);
    }
  });

  return result;
}

export function flushPending(path) {
  if (suspended) return;
  const entry = pending.get(path);

  if (!entry) {
    return;
  }

  clearTimeout(entry.quiet);
  clearTimeout(entry.max);
  pending.delete(path);

  enqueueWrite(path, entry.data, entry.encoding, entry.onResult).catch(() => {
    // performWrite handed the failure to the durability queue; nothing more to do here.
  });
}

export function bufferWrite(path, data, encoding, onResult) {
  if (suspended) throw new Error("Session locked");
  const entry = pending.get(path) || { max: null };

  clearTimeout(entry.quiet);
  entry.data = data;
  entry.encoding = encoding;
  entry.onResult = onResult;
  entry.quiet = setTimeout(() => flushPending(path), QUIET_MS);

  if (!entry.max) {
    entry.max = setTimeout(() => flushPending(path), MAX_WAIT_MS);
  }

  pending.set(path, entry);
}

export function enqueueWrite(path, data, encoding, onResult, opts) {
  if (suspended) return Promise.reject(new Error("Session locked"));
  const id = ++nextQueuedId;
  queuedWrites.set(id, { path, data, encoding });
  return enqueue(path, () =>
    performWrite(path, data, encoding, onResult, opts),
  ).finally(() => queuedWrites.delete(id));
}

export function cancelPending(path) {
  const entry = pending.get(path);

  if (!entry) {
    return;
  }

  clearTimeout(entry.quiet);
  clearTimeout(entry.max);
  pending.delete(path);
}

export function hasPending(path) {
  return pending.has(path);
}

export function hasUnconfirmedWrite(path) {
  const norm = normalize(path);

  return pending.has(norm) || tails.has(norm) || hasWriteInProgress(norm);
}

function flushAll() {
  for (const path of Array.from(pending.keys())) {
    flushPending(path);
  }
}

// Test-only: drop buffered writes and per-path tails.
export function _reset() {
  suspended = false;
  queuedWrites.clear();
  for (const entry of pending.values()) {
    clearTimeout(entry.quiet);
    clearTimeout(entry.max);
  }

  pending.clear();
  tails.clear();
}

export function snapshotBuffered() {
  return [
    ...queuedWrites.values(),
    ...[...pending].map(([path, entry]) => ({
      path,
      data: entry.data,
      encoding: entry.encoding,
    })),
  ].map(({ path, data, encoding }) => ({
    path,
    encoding,
    data: typeof data === "string" ? data : Array.from(data),
  }));
}
export function suspendCoalescer() {
  suspended = true;
  for (const entry of pending.values()) {
    clearTimeout(entry.quiet);
    clearTimeout(entry.max);
  }
}
