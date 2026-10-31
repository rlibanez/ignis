// The catalog controls UI availability; the server authorizes every operation.
export function openShareDialog(obsidian, app, file, sharedFiles, host = window) {
  const session = host.__ignisAuth?.sessionId;
  const vault = host.__currentVaultUuid;
  const path = file.path;
  const check = () => {
    if (!session || !vault || host.__ignisAuth?.blocked || host.__ignisAuth?.sessionId !== session || host.__currentVaultUuid !== vault)
      throw new Error("Your session or vault changed. Reopen the sharing dialog.");
  };
  async function request(operation, input) {
    check();
    const headers = { "X-Ignis-Context": session };
    if (operation) {
      const csrf = await host.fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", headers });
      if (!csrf.ok) throw new Error("Unable to verify your session. Sign in again.");
      headers["X-Ignis-Csrf"] = (await csrf.json()).csrfToken;
      headers["Content-Type"] = "application/json";
      check();
    }
    const response = await host.fetch("/api/shares", {
      method: operation ? "POST" : "GET", credentials: "same-origin", cache: "no-store", headers,
      ...(operation ? { body: JSON.stringify({ operation, input }) } : {}),
    });
    check();
    const data = await response.json();
    check();
    if (!response.ok) throw new Error(data.error || "Unable to share this resource.");
    return data;
  }
  const create = (tag, text) => {
    const el = host.document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const style = (el, values) => Object.assign(el.style, values);
  function button(text, action, icon) {
    const el = create("button", text); el.type = "button"; el.onclick = action;
    if (icon) {
      el.textContent = ""; obsidian.setIcon(el, icon);
      el.title = text; el.setAttribute("aria-label", text);
      style(el, { width: "2rem", height: "2rem", padding: ".4rem" });
    }
    return el;
  }
  function permission(value = "reader", label = "Permission") {
    const select = create("select"); select.setAttribute("aria-label", label);
    for (const [id, text] of [["reader", "Read"], ["editor", "Read / Write"]]) {
      const option = create("option", text); option.value = id; select.append(option);
    }
    select.value = value; return select;
  }
  class ShareDialog extends obsidian.Modal {
    onOpen() {
      this.active = true; this.busy = false; this.ready = false;
      this.setTitle("Manage sharing");
      style(this.modalEl, { width: "min(44rem, 95vw)" });
      const description = create("p", path);
      style(description, { overflowWrap: "anywhere", color: "var(--text-accent)", fontWeight: "600" });
      this.status = create("p", "Checking sharing permissions…"); this.status.setAttribute("role", "status");
      this.panel = create("section"); this.panel.hidden = true;
      style(this.panel, { border: "1px solid var(--background-modifier-border)", borderRadius: ".65rem", padding: "1rem" });
      const header = create("div"); style(header, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: ".75rem", marginBottom: "1rem" });
      const title = create("h3", "People with access"); title.style.margin = "0";
      const add = button("Add access", () => { if (!this.busy && this.ready) { this.child = new AddAccessDialog(app, this); this.child.open(); } }); add.className = "mod-cta";
      header.append(title, add);
      this.grants = create("div"); this.grants.style.overflowX = "auto"; this.panel.append(header, this.grants);
      const actions = create("div"); style(actions, { display: "flex", justifyContent: "flex-end", gap: ".75rem", marginTop: "1.5rem" });
      this.revoke = button("Stop sharing", () => {
        if (!this.ready || this.busy || !this.resource) return;
        if (!host.confirm("Stop sharing this resource with all recipients? Other shares and vault memberships are unaffected.")) return;
        void this.change(() => request("revoke", { action: "revoke", id: this.resource.id, revision: this.resource.revision }));
      });
      this.revoke.className = "mod-warning"; this.revoke.hidden = true;
      actions.append(this.revoke, button("Done", () => this.close()));
      this.contentEl.append(description, this.status, this.panel, actions);
      this.onAuthLost = () => this.close(); host.addEventListener("ignis:auth-lost", this.onAuthLost);
      void this.load().catch(error => this.error(error));
    }
    error(error) {
      if (!this.active) return;
      this.status.textContent = error.message; this.status.style.color = "var(--text-error)";
    }
    async load() {
      this.ready = false;
      const data = await request();
      if (!this.active) return;
      if (!data.ownedVaults.some(item => item.id === vault)) throw new Error("Only the vault owner can share its resources.");
      this.resource = data.resources.find(item => item.owned && item.vault === vault && item.path === path);
      if (this.resource && !this.resource.available) throw new Error("This shared resource is unavailable. Review it in Shared resources.");
      this.status.textContent = ""; this.panel.hidden = false; this.revoke.hidden = !this.resource;
      this.renderGrants(); this.ready = true;
    }
    renderGrants() {
      this.grants.replaceChildren();
      const grants = this.resource?.grants || [];
      if (!grants.length) { this.grants.append(create("p", "No direct recipients.")); return; }
      const table = create("table"); style(table, { width: "100%", borderCollapse: "collapse" });
      const head = create("thead"), heading = create("tr");
      for (const text of ["User", "Permission", "Actions"]) heading.append(create("th", text));
      head.append(heading); table.append(head);
      const body = create("tbody");
      for (const grant of grants) {
        const row = create("tr"), user = create("td", grant.login), access = create("td"), actions = create("td");
        const select = permission(grant.role, "Permission for " + grant.login);
        const save = button("Save permission for " + grant.login, () => {
          if (this.ready) void this.change(() => this.grant(grant.login, select.value));
        }, "save"); save.disabled = true;
        select.onchange = () => { save.disabled = select.value === grant.role; };
        const remove = button("Remove access for " + grant.login, () => {
          if (!this.ready || this.busy) return;
          if (host.confirm(`Remove ${grant.login}'s access to this resource? Other permissions are unaffected.`)) void this.change(() => this.grant(grant.login, null));
        }, "trash-2");
        const controls = create("div"); style(controls, { display: "flex", gap: ".5rem", justifyContent: "flex-end" });
        controls.append(save, remove); access.append(select); actions.append(controls); row.append(user, access, actions); body.append(row);
      }
      table.append(body);
      for (const cell of table.querySelectorAll("th,td")) style(cell, { textAlign: "left", padding: ".65rem .5rem", borderBottom: "1px solid var(--background-modifier-border)" });
      this.grants.append(table);
    }
    grant(login, role) {
      return request(this.resource ? "grant" : "create", this.resource
        ? { action: "grant", id: this.resource.id, revision: this.resource.revision, login, role }
        : { vault, path, login, role });
    }
    async change(action, errorTarget = this.status) {
      if (this.busy || !this.active || !this.ready) return false;
      this.busy = true; errorTarget.textContent = "";
      const controls = [...this.contentEl.querySelectorAll("button,select")];
      const disabled = controls.map(el => el.disabled); controls.forEach(el => { el.disabled = true; });
      try {
        await action();
        if (!this.active) return false;
        await this.load();
        try {
          await sharedFiles.refresh();
          for (const leaf of app.workspace.getLeavesOfType("ignis-shared-resources")) await leaf.view.reload?.();
        } catch { new obsidian.Notice("Sharing updated. Refresh Shared to update its display."); }
        return true;
      } catch (error) {
        if (this.active) { errorTarget.textContent = error.message; errorTarget.style.color = "var(--text-error)"; }
        return false;
      } finally { this.busy = false; controls.forEach((el, i) => { el.disabled = disabled[i]; }); }
    }
    onClose() {
      this.active = false; this.child?.close();
      host.removeEventListener("ignis:auth-lost", this.onAuthLost); this.contentEl.empty();
    }
  }
  class AddAccessDialog extends obsidian.Modal {
    constructor(application, parent) { super(application); this.parent = parent; }
    onOpen() {
      this.active = true; this.setTitle("Add access");
      const form = create("form"), loginLabel = create("label", "Username"), login = create("input");
      login.type = "text"; login.required = true; login.maxLength = 64; login.autocomplete = "off"; loginLabel.append(login);
      const roleLabel = create("label", "Permission"), role = permission(); roleLabel.append(role);
      for (const label of [loginLabel, roleLabel]) style(label, { display: "block", marginTop: "1rem" });
      for (const field of [login, role]) style(field, { display: "block", width: "100%", marginTop: ".5rem" });
      const status = create("p"); status.setAttribute("role", "alert");
      const actions = create("div"); style(actions, { display: "flex", justifyContent: "flex-end", gap: ".75rem", marginTop: "1.5rem" });
      const cancel = button("Cancel", () => this.close()), submit = create("button", "Add access"); submit.type = "submit"; submit.className = "mod-cta";
      actions.append(cancel, submit); form.append(loginLabel, roleLabel, status, actions); this.contentEl.append(form);
      form.onsubmit = async event => {
        event.preventDefault(); if (submit.disabled || !this.active || this.parent.busy) return;
        submit.disabled = cancel.disabled = true; login.disabled = role.disabled = true;
        try {
          const success = await this.parent.change(() => this.parent.grant(login.value, role.value), status);
          if (success && this.active) this.close();
        } finally { submit.disabled = cancel.disabled = false; login.disabled = role.disabled = false; }
      };
      login.focus();
    }
    onClose() { this.active = false; this.contentEl.empty(); }
  }
  new ShareDialog(app).open();
}
