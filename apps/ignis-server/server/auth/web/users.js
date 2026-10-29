(() => {
  let providerName = "OpenID Connect";
  function setProviderName(name) {
    providerName = name || "OpenID Connect";
    for (const element of document.querySelectorAll("[data-provider-template]"))
      element.textContent = element.dataset.providerTemplate.replaceAll("OpenID Connect", () => providerName);
  }

  const status = document.getElementById("status");
  const area = document.getElementById("administration");
  const form = document.getElementById("create-user");
  const list = document.getElementById("users");
  const button = form.querySelector('button[type="submit"]');
  const dialog = document.getElementById("create-dialog");
  const addButton = document.getElementById("add-user");
  const cancelButton = document.getElementById("cancel-create");
  const createStatus = document.getElementById("create-status");
  const editDialog = document.getElementById("edit-dialog");
  const editForm = document.getElementById("edit-user");
  const editButton = editForm.querySelector('button[type="submit"]');
  const editCancel = document.getElementById("cancel-edit");
  const editStatus = document.getElementById("edit-status");
  const revokeButton = document.getElementById("revoke-sessions");
  const revokeConfirmation = document.getElementById("revoke-confirmation");
  const confirmRevoke = document.getElementById("confirm-revoke");
  const cancelRevoke = document.getElementById("cancel-revoke");
  revokeButton.addEventListener("click", () => {
    if (locked || editBusy || !editing) return;
    document.getElementById("revoke-warning").textContent = editing.id === currentUserId
      ? "Close all your Ignis sessions, including this one? You will need to sign in again. Your account and provider session are kept."
      : "Close all Ignis sessions for this user? Their account status and provider session are kept. They can sign in again if the account is active.";
    unlinkConfirmation.hidden = true;
    revokeConfirmation.hidden = false;
    confirmRevoke.focus();
  });
  cancelRevoke.addEventListener("click", () => {
    revokeConfirmation.hidden = true;
    revokeButton.focus();
  });
  const unlinkSection = document.getElementById("unlink-section");
  const unlinkButton = document.getElementById("unlink-oidc");
  const unlinkConfirmation = document.getElementById("unlink-confirmation");
  const confirmUnlink = document.getElementById("confirm-unlink");
  const cancelUnlink = document.getElementById("cancel-unlink");
  unlinkButton.addEventListener("click", () => {
    if (locked || editBusy || !editing) return;
    revokeConfirmation.hidden = true;
    unlinkConfirmation.hidden = false;
    confirmUnlink.focus();
  });
  cancelUnlink.addEventListener("click", () => {
    if (editBusy) return;
    unlinkConfirmation.hidden = true;
    unlinkButton.focus();
  });
  let editing = null;
  let editBusy = false;
  let currentUserId;
  editCancel.addEventListener("click", () => editDialog.close());
  editDialog.addEventListener("cancel", (event) => {
    if (editBusy) event.preventDefault();
  });
  editDialog.addEventListener("close", () => { editing = null; revokeConfirmation.hidden = unlinkConfirmation.hidden = true; });
  const reauthDialog = document.getElementById("reauth-dialog");
  document.getElementById("cancel-reauth").addEventListener("click", () => reauthDialog.close());
  function requireReauthentication() {
    if (locked) return;
    clearPasswords();
    if (dialog.open) dialog.close();
    if (editDialog.open) editDialog.close();
    if (!reauthDialog.open) reauthDialog.showModal();
  }
  async function checkRecentSession() {
    if (locked) return false;
    try {
      const response = await request("/api/auth/session");
      if (locked) return;
      if (!response.ok) throw new Error();
      const session = await response.json();
      if (locked) return;
      if (session.sessionId !== context) { lock(); return; }
      if (!session.recentAuthentication) { requireReauthentication(); return; }
    } catch {
      if (!locked) status.textContent = "Unable to check your session. Please try again.";
      return;
    }
    return !locked;
  }
  addButton.addEventListener("click", async () => {
    if (locked || button.disabled || !await checkRecentSession()) return;
    if (dialog.open || editDialog.open) return;
    form.reset();
    createStatus.textContent = "";
    dialog.showModal();
    form.elements.login.focus();
  });
  cancelButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (button.disabled) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    form.reset();
    createStatus.textContent = "";
  });
  let context;
  let locked = false;
  function clearPasswords() {
    form.elements.password.value = "";
    form.elements.confirmation.value = "";
  }
  function lock() {
    locked = true;
    if (dialog.open) dialog.close();
    if (editDialog.open) editDialog.close();
    if (reauthDialog.open) reauthDialog.close();
    area.hidden = true;
    list.replaceChildren();
    clearPasswords();
    status.textContent = "Session changed or expired. Return to Account and sign in again.";
  }
  const channel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel("ignis-auth") : null;
  if (channel) channel.onmessage = lock;
  async function request(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: { "X-Ignis-Context": context, ...options.headers },
    });
    if (response.status === 403 &&
        (await response.clone().json()).code === "REAUTH_REQUIRED") {
      requireReauthentication();
      return response;
    }
    if (response.status === 409 &&
        (await response.clone().json()).code === "USER_STATE_CHANGED") return response;
    if (response.status === 409 &&
        (await response.clone().json()).code === "OIDC_NOT_LINKED") return response;
    if ([401, 403, 409].includes(response.status)) {
      lock();
      throw new Error();
    }
    return response;
  }
  async function refresh() {
    const response = await request("/api/auth/users");
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (locked) return;
    list.replaceChildren();
    setProviderName(data.oidcButtonText);
    unlinkSection.setAttribute("aria-label", `${providerName} linking`);
    const showOidc = data.oidcAvailable === true;
    document.getElementById("oidc-column").hidden = !showOidc;
    for (const user of data.users) {
      const row = document.createElement("tr");
      const values = [user.login, user.role, user.status];
      if (showOidc) values.push(user.oidcLinked === true ? "Linked" : "Not linked");
      for (const [index, value] of values.entries()) {
        const cell = document.createElement(index === 0 ? "th" : "td");
        if (index === 0) cell.scope = "row";
        const label = document.createElement("span");
        label.textContent = value;
        if (index > 0) label.className = "badge";
        cell.append(label);
        row.append(cell);
      }
      const actions = document.createElement("td");
      actions.className = "actions";
      for (const [name, paths] of [
        ["Edit", ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z"]],
        ["Delete", ["M3 6h18", "M9 6V4h6v2", "M5 6l1 14h12l1-14", "M10 10v6", "M14 10v6"]],
      ]) {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "icon-button";
        action.disabled = name === "Delete";
        action.title = name === "Edit" ? "Edit account" : "Delete — not available yet";
        action.setAttribute("aria-label", `${name} ${user.login}${name === "Delete" ? " — not available yet" : ""}`);
        if (name === "Edit") action.addEventListener("click", async () => {
          if (!await checkRecentSession() || editDialog.open || dialog.open) return;
          editing = user;
          unlinkSection.hidden = user.oidcLinked !== true;
          unlinkConfirmation.hidden = true;
          revokeConfirmation.hidden = true;
          document.getElementById("edit-user-name").textContent = user.login;
          editForm.elements.status.value = user.status;
          const ownAccount = user.id === currentUserId;
          editForm.elements.status.disabled = ownAccount;
          editButton.disabled = ownAccount;
          editStatus.textContent = ownAccount ? "You cannot disable your own account." : "";
          editDialog.showModal();
        });
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [key, value] of Object.entries({
          viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
          "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round",
          "aria-hidden": "true",
        })) svg.setAttribute(key, value);
        for (const d of paths) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", d);
          svg.append(path);
        }
        action.append(svg);
        actions.append(action);
      }
      row.append(actions);
      list.append(row);
    }
    document.getElementById("policy").textContent =
      `Password: at least ${data.passwordPolicy.minLength} characters and ${data.passwordPolicy.minSpecialChars} punctuation/symbol characters.`;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (locked || button.disabled) return;
    if (form.elements.password.value !== form.elements.confirmation.value) {
      createStatus.textContent = "Passwords do not match.";
      clearPasswords();
      return;
    }
    button.disabled = cancelButton.disabled = true;
    let created = false;
    try {
      const csrf = await request("/api/auth/csrf");
      if (!csrf.ok || locked) throw new Error();
      const response = await request("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Ignis-Csrf": (await csrf.json()).csrfToken },
        body: JSON.stringify({ login: form.elements.login.value, password: form.elements.password.value }),
      });
      if (locked) return;
      if (!response.ok) {
        createStatus.textContent = response.status === 429
          ? "Too many attempts. Wait before trying again."
          : "Unable to create user. Check username availability and password policy.";
        return;
      }
      created = true;
      dialog.close();
      status.textContent = "User created.";
      await refresh();
    } catch {
      if (!locked) {
        if (created) status.textContent = "User created, but the list could not be refreshed. Reload this page.";
        else createStatus.textContent = "Request could not be confirmed. Close this dialog and reload the list before trying again.";
      }
    } finally {
      clearPasswords();
      button.disabled = cancelButton.disabled = false;
    }
  });
  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (locked || editButton.disabled || !editing) return;
    const target = editing;
    const nextStatus = editForm.elements.status.value;
    editBusy = true;
    editButton.disabled = editCancel.disabled = revokeButton.disabled = true;
    let saved = false;
    try {
      const csrf = await request("/api/auth/csrf");
      if (!csrf.ok || locked) throw new Error();
      const response = await request("/api/auth/users/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Ignis-Csrf": (await csrf.json()).csrfToken },
        body: JSON.stringify({ userId: target.id, status: nextStatus, expectedStatus: target.status }),
      });
      if (locked || !editDialog.open) return;
      if (!response.ok) {
        const data = await response.json();
        const messages = {
          LAST_ADMIN: "The last active administrator cannot be disabled.",
          SELF_DISABLE: "You cannot disable your own account.",
          USER_STATE_CHANGED: "Account changed. Close this dialog and reload the page.",
          USER_NOT_FOUND: "Account no longer exists. Reload the page.",
        };
        editStatus.textContent = messages[data.code] || (response.status === 429
          ? "Too many attempts. Wait before trying again." : "Unable to update the account.");
        return;
      }
      saved = true;
      editDialog.close();
      status.textContent = nextStatus === "disabled" ? "Account disabled. Sessions revoked." : "Account enabled.";
      await refresh();
    } catch {
      if (!locked) {
        if (saved) status.textContent = "Account updated, but the list could not be refreshed. Reload this page.";
        else editStatus.textContent = "Update could not be confirmed. Reload the page before trying again.";
      }
    } finally {
      editBusy = false;
      editButton.disabled = editCancel.disabled = revokeButton.disabled = false;
    }
  });
  async function revokeOrUnlink(unlink) {
    if (locked || editBusy || !editing) return;
    const target = editing;
    editBusy = true;
    editButton.disabled = editCancel.disabled = revokeButton.disabled =
      confirmRevoke.disabled = cancelRevoke.disabled = unlinkButton.disabled =
      confirmUnlink.disabled = cancelUnlink.disabled = true;
    try {
      const csrf = await request("/api/auth/csrf");
      if (!csrf.ok || locked) throw new Error();
      const response = await request(unlink ? "/api/auth/users/unlink-oidc" : "/api/auth/users/revoke-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Ignis-Csrf": (await csrf.json()).csrfToken },
        body: JSON.stringify({ userId: target.id }),
      });
      if (locked || !editDialog.open) return;
      if (!response.ok) {
        const failure = await response.json();
        editStatus.textContent = failure.code === "LOCAL_PASSWORD_REQUIRED"
          ? "Cannot unlink: this account needs a local password first."
          : failure.code === "OIDC_NOT_LINKED"
            ? "The link has already changed. Close this dialog and reload the page."
            : response.status === 429 ? "Too many attempts. Wait before trying again."
              : "Unable to complete the operation.";
        return;
      }
      const result = await response.json();
      if (result.signedOut) {
        channel?.postMessage("lock");
        lock();
        location.replace("/login");
        return;
      }
      revokeConfirmation.hidden = unlinkConfirmation.hidden = true;
      if (unlink) {
        editDialog.close();
        status.textContent = `${providerName} unlinked. All Ignis sessions closed.`;
        await refresh();
      } else editStatus.textContent = "All Ignis sessions closed. Account status unchanged.";
    } catch {
      if (!locked) editStatus.textContent = "The result could not be confirmed. Reload before trying again.";
    } finally {
      editBusy = false;
      editButton.disabled = editing?.id === currentUserId;
      editCancel.disabled = revokeButton.disabled = confirmRevoke.disabled = cancelRevoke.disabled =
        unlinkButton.disabled = confirmUnlink.disabled = cancelUnlink.disabled = false;
    }
  }
  confirmRevoke.addEventListener("click", () => revokeOrUnlink(false));
  confirmUnlink.addEventListener("click", () => revokeOrUnlink(true));
  window.addEventListener("pagehide", lock);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
  async function start() {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) { lock(); return; }
      const session = await response.json();
      if (session.user.role !== "admin") {
        status.textContent = "Administrator access required.";
        return;
      }
      context = session.sessionId;
      currentUserId = session.user.id;
      await refresh();
      if (locked) return;
      area.hidden = false;
      status.textContent = "";
    } catch {
      if (!locked) status.textContent = "Unable to load users. Reload to try again.";
    }
  }
  start();
})();
