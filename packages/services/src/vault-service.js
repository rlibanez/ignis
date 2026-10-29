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
    try { return localStorage.getItem("ignis:last-vault:" + encodeURIComponent(auth.userId)); }
    catch { return null; }
  },

  rememberVault(reference) {
    const auth = window.__ignisAuth;
    if (auth?.blocked || !auth?.userId) return;
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

  async registrationOptions() {
    return fetchJson(API_BASE + "/registration");
  },

  async registerVault(directory, ownerId, identity) {
    return fetchJson(API_BASE + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory, ownerId, identity }),
    });
  },

  async vaultOwners() {
    return fetchJson(API_BASE + "/owners");
  },

  async createVault(name, ownerId) {
    await fetchJson(API_BASE + "/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...(ownerId === undefined ? {} : { ownerId }) }),
    });

    const list = await this.listVaults();
    this.setVaultTrust(name);
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

    return true;
  },

  async refreshVault(id) {
    return fetchJson(API_BASE + "/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vault: this.referenceFor(id) }),
    });
  },

  async renameVault(id, newName) {
    await fetchJson(API_BASE + "/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vault: this.referenceFor(id), name: newName }),
    });

    this._migrateLocalStorage(id, newName);

    if (id === this.getCurrentVaultId()) {
      window.__currentVaultId = newName;

      if (window.__vaultConfig) {
        window.__vaultConfig.id = this.browserVaultId(this.getCurrentVaultReference());
      }

      history.replaceState(null, "", "/?vault=" + encodeURIComponent(this.getCurrentVaultReference()));
    }

    return this.listVaults();
  },

  async deleteVault(id, uuid) {
    const result = await fetchJson(API_BASE + "/remove?vault=" + encodeURIComponent(uuid || id), {
      method: "DELETE",
    });

    const wasCurrentVault = id === this.getCurrentVaultId();

    await this.listVaults();

    return { wasCurrentVault, cleanupPending: result.cleanupPending === true };
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
