(() => {
var translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  const nativeFetch = window.fetch.bind(window);
  const XHR = window.XMLHttpRequest;
  const nativeOpen = XHR.prototype.open;
  const nativeSend = XHR.prototype.send;
  const nativeHeader = XHR.prototype.setRequestHeader;
  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel("ignis-auth")
      : null;
  let blocked = false,
    sessionId = null,
    userId = null,
    role = null,
    csrf = null,
    csrfAt = 0,
    refresh = null;
  let vaultCatalog = null, renaming = null;
  const pending = new Set();
  const xhrs = new Set();
  const requests = new WeakMap();
  function target(input) {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    return (
      url.origin === location.origin &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/auth/")
    );
  }
  function lock(
    message = translateIgnis("Your session has ended or changed. Sign in again to continue."),
    vaultLost = false,
  ) {
    if (blocked) return;
    blocked = true;
    document.title = vaultLost ? translateIgnis("Vault unavailable") : translateIgnis("Sign in to Ignis");
    csrf = null;
    const snapshot = [...(window.__ignis?.writes?.snapshotPending?.() || [])];
    // Include editor text that has not reached the write queue yet.
    if (vaultLost) {
      try { window.app?.workspace?.iterateAllLeaves?.(leaf => {
        try {
        const editor = leaf.view?.editor;
        const path = leaf.view?.file?.path;
        if (path && typeof editor?.getValue === "function")
          snapshot.push({ path, encoding: "utf8", data: editor.getValue(), source: "open-editor" });
        } catch { /* An unavailable editor must not prevent locking. */ }
      }); } catch { /* Preserve queued writes even if editor enumeration fails. */ }
    }
    window.dispatchEvent(new Event("ignis:auth-lost"));
    for (const controller of pending) controller.abort();
    for (const xhr of xhrs) xhr.abort();
    document.body.replaceChildren();
    document.body.style.visibility = "visible";
    const panel = document.createElement("main");
    panel.style.cssText =
      "max-width:32rem;margin:3rem auto;padding:2rem;font:16px system-ui";
    const heading = document.createElement("h1");
    heading.textContent = vaultLost ? translateIgnis("Vault unavailable") : translateIgnis("Session locked");
    const text = document.createElement("p");
    text.textContent = message;
    const link = document.createElement("a");
    link.href = vaultLost ? "/?manager=1" : "/login";
    link.textContent = vaultLost ? translateIgnis("Open Vault Manager") : translateIgnis("Sign in");
    const actionStyle =
      "box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:auto;min-height:2.75rem;padding:0.625rem 1rem;border:1px solid var(--background-modifier-border,#555);border-radius:6px;background:var(--interactive-normal,#333);color:var(--text-normal,#eee);font:inherit;font-weight:600;text-align:center;text-decoration:none;white-space:normal;cursor:pointer;box-shadow:none";
    link.style.cssText = actionStyle;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;flex-direction:column;gap:0.75rem;margin-top:1.5rem";
    panel.append(heading, text);
    if (snapshot.length) {
      const warning = document.createElement("p");
      warning.textContent =
        translateIgnis("Some writes were not confirmed. Download them before leaving this page; they will not be sent under a different session.");
      const save = document.createElement("button");
      save.textContent = translateIgnis("Download unconfirmed writes");
      save.style.cssText = actionStyle;
      save.onclick = () => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(snapshot, null, 2)], {
            type: "application/json",
          }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = "ignis-unconfirmed-writes.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      panel.append(warning);
      actions.append(save);
    }
    actions.append(link);
    panel.append(actions);
    document.body.append(panel);
  }
  function vaultUnavailable() {
    if(renaming){renaming.unavailable=true;return;}
    lock(translateIgnis("This vault was removed, renamed or made unavailable. Saving has stopped. Download any unconfirmed changes before returning to the Vault Manager."), true);
  }
  function hasPendingVaultChanges() {
    let dirty=(window.__ignis?.writes?.snapshotPending?.() || []).length>0;
    window.app?.workspace?.iterateAllLeaves?.(leaf=>{
      const view=leaf.view;
      if(view?.file && (view.saving || view.dirty || (typeof view.getViewData==="function" && view.lastSavedData!==view.getViewData()))) dirty=true;
    });
    return dirty;
  }
  async function beginVaultRename(uuid) {
    await ready;
    if(blocked || renaming || !uuid || uuid !== window.__currentVaultUuid) throw new Error(translateIgnis("Session locked"));
    const startingSession=sessionId;
    const saves=[];
    window.app?.workspace?.iterateAllLeaves?.(leaf=>{
      if(leaf.view?.file && typeof leaf.view.save === "function") saves.push(leaf.view.save());
    });
    await Promise.all(saves);
    if(blocked || renaming || sessionId!==startingSession || uuid!==window.__currentVaultUuid || hasPendingVaultChanges())
      throw new Error(translateIgnis("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before renaming the vault."));
    renaming={uuid,sessionId,unavailable:false};
  }
  async function finishVaultRename(success, deleted = false) {
    const operation=renaming;
    if(!operation)return;
    try {
      if(!success) { if(operation.unavailable) throw new Error("Vault unavailable"); return; }
      await context();
      if(blocked || sessionId!==operation.sessionId) return;
      const response=await nativeFetch("/api/vault/list",{credentials:"same-origin",cache:"no-store",headers:{"X-Ignis-Context":sessionId}});
      const list=response.ok ? await response.json() : [];
      if(!Array.isArray(list) || list.some(v=>v.uuid===operation.uuid) === deleted) throw new Error("Vault unavailable");
      if(hasPendingVaultChanges()) throw new Error("Pending changes");
      location.replace("/?manager=1");
      return;
    } catch { operation.unavailable=true; }
    finally { renaming=null; }
    if(operation.unavailable) vaultUnavailable();
  }
  async function checkVault() {
    if(renaming)return;
    const response = await nativeFetch("/api/vault/list", {
      credentials: "same-origin", cache: "no-store",
      headers: { "X-Ignis-Context": sessionId },
    });
    if (!response.ok) return; // An outage is not proof of deletion.
    const list = await response.json();
    if (renaming || !Array.isArray(list)) return;
    const id = window.__currentVaultId;
    if (vaultCatalog && id) {
      const before = window.__currentVaultUuid
        ? { id, uuid: window.__currentVaultUuid }
        : vaultCatalog.find(v => v.id === id);
      const now = list.find(v => v.id === id);
      if (before && (!now || (before.uuid && before.uuid !== now.uuid))) vaultUnavailable();
    }
    if (!vaultCatalog) vaultCatalog = list;
  }
  async function context() {
    let response;
    try {
      response = await nativeFetch("/api/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw Object.assign(new Error(translateIgnis("Session check unavailable")), { transient: true });
    }
    if (!response.ok)
      throw Object.assign(new Error(translateIgnis("Session unavailable")), {
        transient: response.status === 429 || response.status >= 500,
      });
    const state = await response.json();
    if (state.user) window.IgnisI18n?.useAccount(state.user.id);
    if (
      !["admin", "user"].includes(state.user.role) ||
      (sessionId && state.sessionId !== sessionId) ||
      (userId && state.user.id !== userId) ||
      typeof state.user.id !== "string" || !state.user.id
    )
      throw new Error(translateIgnis("Session changed"));
    sessionId = state.sessionId;
    userId = state.user.id;
    role = state.user.role;
    return state;
  }
  async function token() {
    if (blocked) throw new Error(translateIgnis("Session locked"));
    if (csrf && Date.now() - csrfAt < 5 * 60000) return csrf;
    if (!refresh)
      refresh = (async () => {
        await context();
        const response = await nativeFetch("/api/auth/csrf", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("CSRF unavailable");
        const value = (await response.json()).csrfToken;
        if (blocked) throw new Error(translateIgnis("Session locked"));
        csrf = value;
        csrfAt = Date.now();
        return csrf;
      })().finally(() => {
        refresh = null;
      });
    return refresh;
  }
  function syncToken() {
    if (csrf && Date.now() - csrfAt < 5 * 60000) return csrf;
    // Synchronous Obsidian filesystem calls cannot await fetch; use the original XHR methods.
    const xhr = new XHR();
    nativeOpen.call(xhr, "GET", "/api/auth/csrf", false);
    nativeSend.call(xhr);
    if (xhr.status !== 200)
      throw new Error(translateIgnis("Unable to refresh request protection"));
    csrf = JSON.parse(xhr.responseText).csrfToken;
    csrfAt = Date.now();
    return csrf;
  }
  function checkResponse(status, changed = false) {
    if (status === 401 || changed) lock();
  }
  window.fetch = async (input, init) => {
    if (!target(input)) return nativeFetch(input, init);
    await ready;
    if (blocked) throw new Error(translateIgnis("Session locked"));
    const method = (
      init?.method || (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    if (!["GET", "HEAD"].includes(method))
      headers.set("X-Ignis-Csrf", await token());
    if (blocked) throw new Error(translateIgnis("Session locked"));
    headers.set("X-Ignis-Context", sessionId);
    const controller = new AbortController();
    pending.add(controller);
    const signal =
      init?.signal || (input instanceof Request ? input.signal : undefined);
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await nativeFetch(input, {
        ...init,
        headers,
        credentials: "same-origin",
        signal: controller.signal,
      });
      const changed =
        response.status === 409 &&
        (
          await response
            .clone()
            .json()
            .catch(() => ({}))
        ).code === "AUTH_CONTEXT_CHANGED";
      checkResponse(response.status, changed);
      if (blocked) throw new Error(translateIgnis("Session locked"));
      return response;
    } finally {
      pending.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  };
  XHR.prototype.open = function (method, url, ...rest) {
    requests.set(this, {
      protected: target(url),
      method: method.toUpperCase(),
    });
    return nativeOpen.call(this, method, url, ...rest);
  };
  XHR.prototype.send = function (body) {
    const request = requests.get(this);
    if (request?.protected) {
      if (blocked || !sessionId) throw new Error(translateIgnis("Session locked"));
      if (!["GET", "HEAD"].includes(request.method))
        nativeHeader.call(this, "X-Ignis-Csrf", syncToken());
      nativeHeader.call(this, "X-Ignis-Context", sessionId);
      xhrs.add(this);
      this.addEventListener(
        "loadend",
        () => {
          xhrs.delete(this);
          let changed = false;
          if (this.status === 409)
            try {
              changed =
                JSON.parse(this.responseText).code === "AUTH_CONTEXT_CHANGED";
            } catch {
              /* Binary response. */
            }
          checkResponse(this.status, changed);
        },
        { once: true },
      );
    }
    return nativeSend.call(this, body);
  };
  async function check() {
    if (blocked) return;
    try {
      await context();
    } catch (error) {
      // Keep an already verified editor during an outage. Server requests still
      // carry the pinned session context and enforce authorization independently.
      if (error.transient && sessionId) return;
      lock(translateIgnis("Your session could not be verified. Sign in again to continue."));
    }
    if (!blocked) await checkVault().catch(() => {});
  }
  async function logout() {
    const unsaved = window.__ignis?.writes?.snapshotPending?.() || [];
    if (unsaved.length) {
      window.alert(
        translateIgnis("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before signing out."),
      );
      return;
    }
    try {
      const response = await nativeFetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Ignis-Csrf": await token(),
        },
        body: "{}",
      });
      if (!response.ok) throw new Error();
      // Clear the account-scoped storage while its local context is still valid.
      // Storage failure must not prevent leaving an already revoked session.
      try { localStorage.clear(); sessionStorage.clear(); window.IgnisI18n?.rememberLanguage(); } catch { /* Optional browser storage. */ }
      channel?.postMessage("lock");
      lock(translateIgnis("You have signed out."));
      location.replace("/login");
    } catch {
      window.alert(translateIgnis("Unable to sign out. Please try again."));
    }
  }
  const ready = (async () => {
    try {
      await context();
      await token();
      await checkVault().catch(() => {});
    } catch (error) {
      lock();
      throw error;
    }
  })();
  window.__ignisAuth = {
    ready,
    check,
    lock,
    logout,
    vaultUnavailable,
    beginVaultRename,
    finishVaultRename,
    beginVaultDelete: beginVaultRename,
    finishVaultDelete: success => finishVaultRename(success, true),
    get blocked() {
      return blocked;
    },
    get sessionId() {
      return sessionId;
    },
    get role() { return blocked ? null : role; },
    get userId() {
      return blocked ? null : userId;
    },
  };
  if (channel)
    channel.onmessage = (event) => {
      if (event.data === "lock") lock();
    };
  window.addEventListener("ignis:state-changed",event=>{if(event.detail?.account || event.detail?.vaults)void check();});
  window.addEventListener("focus", check);
  window.addEventListener("pagehide", () => {
    document.body.style.visibility = "hidden";
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) lock();
  });
})();
