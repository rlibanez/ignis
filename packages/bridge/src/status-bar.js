
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { Notice } from "obsidian";

const STATUS_LABELS = {
  open: translateIgnis("Connected"),
  connecting: translateIgnis("Connecting..."),
  closed: translateIgnis("Disconnected"),
};

const STATUS_DOT_CLASSES = {
  open: "ignis-statusbar-connected",
  connecting: "ignis-statusbar-connecting",
  closed: "ignis-statusbar-disconnected",
};

// One status-bar item shows connection (dot color) and write state.
// The dot pulses while writes lag or retry; a permanent give-up raises a Notice offering retry or reload.
function initStatusBar(plugin) {
  const ws = window.__ignis.ws;
  const writes = window.__ignis.writes;

  const item = plugin.addStatusBarItem();
  item.addClass("ignis-statusbar-item");

  const dot = item.createEl("span", { cls: "ignis-statusbar-dot" });

  item.setAttribute("data-tooltip-position", "top");

  let connState = ws.isOpen() ? "open" : "closed";
  let writeState = writes ? writes.getState() : "clean";
  let failureNotice = null;

  function render() {
    const pending = writeState === "pending";
    const connClass =
      STATUS_DOT_CLASSES[connState] || STATUS_DOT_CLASSES.closed;

    dot.className = `ignis-statusbar-dot ${connClass}${pending ? " ignis-statusbar-writes-pending" : ""}`;

    let label = translateIgnis("Server: {p0}", {p0: (STATUS_LABELS[connState] || STATUS_LABELS.closed)});

    if (pending && writes) {
      const { retrying } = writes.getDetail();

      label +=
        retrying > 0 ? translateIgnis(" · Writes: {p0} retrying", {p0: (retrying)}) : translateIgnis(" · Writes: pending");
    }

    item.setAttribute("aria-label", label);
  }

  const retryableFailures = () => writes.listRetryableFailed ? writes.listRetryableFailed() : writes.listFailed();

  // A give-up replaces any prior Notice so the count stays current instead of stacking one per write.
  function showFailureNotice() {
    const count = retryableFailures().length;

    if (count === 0) {
      failureNotice?.hide();failureNotice=null;
      return;
    }

    if (failureNotice) {
      failureNotice.hide();
    }

    const frag = document.createDocumentFragment();

    const text = document.createElement("div");
    text.textContent = translateIgnis("Ignis: {p0} change{p1} could not be saved after repeated retries.", {p0: (count), p1: (count === 1 ? "" : "s")});
    frag.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "ignis-write-failure-actions";

    const retry = document.createElement("button");
    retry.textContent = translateIgnis("Retry");
    retry.addEventListener("click", () => {
      writes.retryAll();

      if (failureNotice) {
        failureNotice.hide();
      }
    });

    const reload = document.createElement("button");
    reload.textContent = translateIgnis("Reload");
    reload.addEventListener("click", () => window.location.reload());

    actions.appendChild(retry);
    actions.appendChild(reload);
    frag.appendChild(actions);

    // Timeout 0 keeps the prompt until the user acts on it.
    failureNotice = new Notice(frag, 0);
  }

  // Once a superseded failure leaves nothing failed, drop the prompt.
  function reconcileFailureNotice() {
    if (failureNotice && retryableFailures().length === 0) {
      failureNotice.hide();
      failureNotice = null;
    }
  }

  render();

  //Refresh on hover so the tooltip reads the live count.
  item.addEventListener("mouseenter", render);

  const unsubConn = ws.onStateChange((state) => {
    connState = state;
    render();
  });

  let unsubWriteState = () => {};
  let unsubFailure = () => {};
  let unsubFailureChange = () => {};

  if (writes) {
    unsubWriteState = writes.onStateChange((state) => {
      writeState = state;
      render();
    });

    unsubFailure = writes.onFailure(() => showFailureNotice());
    unsubFailureChange = writes.onFailureChange(() => reconcileFailureNotice());
  }

  return () => {
    unsubConn();
    unsubWriteState();
    unsubFailure();
    unsubFailureChange();

    if (failureNotice) {
      failureNotice.hide();
      failureNotice = null;
    }
  };
}

export { initStatusBar };
