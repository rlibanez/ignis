const API_BASE = "/api/vault";

async function fetchJson(url, options) {
  const res = await fetch(url, options);

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Request failed");
  }

  return res.json();
}

export const vaultService = {
  browserVaultId(reference) {
    const auth = window.__ignisAuth;
    if (auth?.blocked || !auth?.userId || !reference) return null;
    return "ignis-v1:" + encodeURIComponent(auth.userId) + ":" + encodeURIComponent(reference);
  },
  rememberedVault() {
    const auth = window.__ignisAuth;
    if (auth?.blocked || !auth?.userId) return null;
    if (auth.rememberedVault) return auth.rememberedVault();
    try { return localStorage.getItem("ignis:last-vault:" + encodeURIComponent(auth.userId)); }
    catch { return null; }
  },

  rememberVault(reference) {
    const auth = window.__ignisAuth;
    if (auth?.blocked || !auth?.userId) return;
    if (auth.rememberVault) { auth.rememberVault(reference); return; }
    try { localStorage.setItem("ignis:last-vault:" + encodeURIComponent(auth.userId), reference); }
    catch { /* Browser storage is optional; authorization stays on the server. */ }
  },

  getCurrentVaultId() {
    return window.__currentVaultId || "";
  },

  getCurrentVaultReference() {
    return window.__currentVaultUuid || this.getCurrentVaultId();
  },

  referenceFor(id) {
    if (id === this.getCurrentVaultId()) return this.getCurrentVaultReference();
    return window.__vaultList?.find(vault => vault.id === id)?.uuid || id;
  },

  async listVaults() {
    const list = await fetchJson(API_BASE + "/list");

    window.__vaultList = list;

    return list;
  },

  listVaultsSync() {
    const xhr = new XMLHttpRequest();

    xhr.open("GET", API_BASE + "/list", false);
    xhr.send();

    if (xhr.status === 200) {
      const list = JSON.parse(xhr.responseText);

      window.__vaultList = list;

      return list;
    }

    return [];
  },


  async vaultMembers(uuid) {
    return fetchJson(API_BASE + "/members?vault=" + encodeURIComponent(uuid));
  },

  async updateVaultMember(vault, login, role, expectedRole, revision) {
    return fetchJson(API_BASE + "/members", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vault, login, role, expectedRole, revision }),
    });
  },

  async transferVaultOwnership(vault, userId, expectedRole, revision) {
    const current=!!window.__currentVaultUuid && vault===this.getCurrentVaultReference();
    if(current)await window.__ignisAuth?.beginVaultRename?.(vault);
    let success=false;
    try {
      const result=await fetchJson(API_BASE + "/transfer-ownership", {
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({vault,userId,expectedRole,revision,confirm:true}),
      });
      if(current)window.__currentVaultId=result.directory;
      success=true;return result;
    }finally{if(current)await window.__ignisAuth?.finishVaultRename?.(success);}
  },

  async vaultOwners() {
    return fetchJson(API_BASE + "/owners");
  },

  async createVault(name) {
    const created=await fetchJson(API_BASE + "/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    const list = await this.listVaults();
    this.setVaultTrust(created.uuid);
    return list;
  },

  createVaultSync(name) {
    const xhr = new XMLHttpRequest();

    xhr.open("POST", API_BASE + "/create", false);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify({ name }));

    if (xhr.status >= 400) {
      return null;
    }

    try {return JSON.parse(xhr.responseText);}catch {return null;}
  },

  async refreshVault(id) {
    return fetchJson(API_BASE + "/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vault: this.referenceFor(id) }),
    });
  },

  async renameVault(id, newName) {
    const current = id === this.getCurrentVaultId() && !!window.__currentVaultUuid;
    if(current) await window.__ignisAuth?.beginVaultRename?.(window.__currentVaultUuid);
    let success=false;
    try {
      const renamed=await fetchJson(API_BASE + "/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vault: this.referenceFor(id), name: newName }),
      });

      this._migrateLocalStorage(id, renamed.id);

      if (id === this.getCurrentVaultId()) {
        window.__currentVaultId = renamed.id;

        if (window.__vaultConfig) {
          window.__vaultConfig.id = this.browserVaultId(this.getCurrentVaultReference());
        }

        history.replaceState(history.state, "", "/?vault=" + encodeURIComponent(this.getCurrentVaultReference()));
      }

      const list = await this.listVaults();
      success=true;
      return list;
    } finally { if(current) await window.__ignisAuth?.finishVaultRename?.(success); }
  },

  async deleteVault(id, uuid) {
    const reference = uuid || this.referenceFor(id);
    const wasCurrentVault = window.__currentVaultUuid
      ? reference === window.__currentVaultUuid
      : id === this.getCurrentVaultId();
    const coordinated = wasCurrentVault && !!window.__currentVaultUuid;
    if (coordinated) await window.__ignisAuth?.beginVaultDelete?.(reference);
    let success = false;
    try {
      const result = await fetchJson(API_BASE + "/remove?vault=" + encodeURIComponent(reference), {
        method: "DELETE",
      });
      success = true;
      await this.listVaults();
      return { wasCurrentVault, cleanupPending: result.cleanupPending === true };
    } finally {
      if (coordinated) await window.__ignisAuth?.finishVaultDelete?.(success);
    }
  },

  deleteVaultSync(id) {
    const reference = window.__vaultList?.find(vault => vault.id === id)?.uuid || id;
    const xhr = new XMLHttpRequest();

    xhr.open(
      "DELETE",
      API_BASE + "/remove?vault=" + encodeURIComponent(reference),
      false,
    );

    xhr.send();

    return xhr.status < 400;
  },

  openVault(id) {
    const reference = this.referenceFor(id);
    this.rememberVault(reference);

    const target = window.parent !== window ? window.parent : window;

    target.location.href = "/?vault=" + encodeURIComponent(reference);
  },

  setVaultTrust(vaultId, trusted = true) {
    const storageId = this.browserVaultId(this.referenceFor(vaultId));
    if (!storageId) return;
    localStorage.setItem("enable-plugin-" + storageId, String(trusted));
  },

  _migrateLocalStorage(oldId, newId) {
    const pluginKey = "enable-plugin-";

    const reference = this.referenceFor(oldId);
    const oldStorageId = this.browserVaultId(reference);
    const newStorageId = this.browserVaultId(reference === oldId ? newId : reference);
    const oldVal = oldStorageId ? localStorage.getItem(pluginKey + oldStorageId) : null;

    if (oldVal !== null && newStorageId && newStorageId !== oldStorageId) {
      localStorage.setItem(pluginKey + newStorageId, oldVal);
      localStorage.removeItem(pluginKey + oldStorageId);
    }

    if (this.rememberedVault() === oldId) {
      this.rememberVault(newId);
    }
  },
};
