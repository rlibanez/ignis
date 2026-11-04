
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { Notice } from "obsidian";

// Paired with the shim's write-giveup subscriber.
const WRITE_GIVEUP_EVENT = "ignis:write-giveup";

const REPORT_INTERVAL_MS = 60 * 1000;

export function initWriteGiveupNotice() {
  const lastNotified = new Map(); // path -> timestamp

  const handler = (event) => {
    const path = (event.detail && event.detail.path) || "";
    const now = Date.now();

    // drop expired entries
    for (const [k, at] of lastNotified) {
      if (now - at >= REPORT_INTERVAL_MS) {
        lastNotified.delete(k);
      }
    }

    if (lastNotified.has(path)) {
      return;
    }

    lastNotified.set(path, now);

    new Notice(
      translateIgnis("Ignis failed to save \"{p0}\". Changes may be lost on reload.", {p0: (path)}),
      10000,
    );
  };

  window.addEventListener(WRITE_GIVEUP_EVENT, handler);

  return () => window.removeEventListener(WRITE_GIVEUP_EVENT, handler);
}
