const express = require("express");
const fs = require("fs");
const config = require("../config");
const path = require("path");
const bootstrapCache = require("../cache");
const settings = require("../settings");
const treeReconcile = require("../cache/reconcile");
const { withWatcherStopped, quiesceRegisteredVault } = require("../vault/lifecycle");
const { sanitizeError } = require("@ignis/server-core");

const router = express.Router();

// Vault names become directories under VAULT_ROOT; reject traversal, hidden, and reserved-device names.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// skip a refresh shortly after the last refresh
const REFRESH_COOLDOWN_MS = 10 * 1000;

// vaultId -> time of the last manual refresh
const lastRefreshAt = new Map();

function isValidVaultName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) {
    return false;
  }

  if (/[/\\:*?"<>|]/.test(name)) {
    return false;
  }

  if (name.startsWith(".")) {
    return false;
  }

  return !WINDOWS_RESERVED.test(name);
}

// GET /api/vault/list - returns all discovered vaults (re-scans on each call)
router.get("/list", (req, res) => {
  config.refreshVaults();

  const list = Object.entries(config.vaults).map(([id, vaultPath]) => ({
    id,
    name: id,
    path: vaultPath,
  }));

  res.json(list);
});

// GET /api/vault/info?vault=<id> - returns info for a specific vault
router.get("/info", async (req, res) => {
  const vaultId = req.query.vault || config.defaultVaultId;
  const vaultPath = config.getVaultPathOrRescan(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault not found", id: vaultId });
  }

  res.json(bootstrapCache.buildVaultInfo(vaultId, vaultPath));
});

// POST /api/vault/refresh { vault } - reconcile the whole vault against disk, including ignored paths
router.post("/refresh", async (req, res) => {
  const vault = req.body?.vault;

  if (!config.getVaultPath(vault)) {
    return res.status(404).json({ error: "Vault not found" });
  }

  if (Date.now() - (lastRefreshAt.get(vault) || 0) < REFRESH_COOLDOWN_MS) {
    return res
      .status(429)
      .json({ error: "Vault was refreshed a moment ago, try again shortly" });
  }

  lastRefreshAt.set(vault, Date.now());

  try {
    const result = await bootstrapCache.reconcileVault(vault, {
      includeIgnored: true,
    });

    if (!result) {
      return res.json({ ok: true, reconciled: false, drifted: false });
    }

    res.json({ ok: true, reconciled: true, drifted: result.drifted });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

// POST /api/vault/create { name } - create a new vault in VAULT_ROOT
router.post("/create", async (req, res) => {
  const name = req.body?.name;

  if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => key !== "name") || !isValidVaultName(name)) {
    return res.status(400).json({ error: "Invalid vault name" });
  }

  if (typeof req.createRegisteredVault !== "function")
    return res.status(503).json({ error: "Vault registration unavailable" });
  try {
    const vault = req.createRegisteredVault(name);
    config.refreshVaults();
    bootstrapCache.invalidateVault(name);
    // Keep the directory ID used by the current editor; UUID is its stable identity.
    res.json({ ok: true, id: name, uuid: vault.id, path: vault.path });
  } catch (e) {
    const statuses = { INVALID_VAULT_NAME: 400, INVALID_VAULT_ROOT: 503, VAULT_EXISTS: 409, SESSION_CHANGED: 401, VAULT_STATE_CHANGED: 409 };
    return res.status(statuses[e.code] || 503).json({ error: e.code === "VAULT_EXISTS" ? "Vault already exists" : "Vault creation could not be completed" });
  }
});

// POST /api/vault/rename { vault, name } - rename a vault
router.post("/rename", async (req, res) => {
  const vaultId = req.body?.vault;
  const newName = req.body?.name;

  if (!isValidVaultName(newName)) {
    return res.status(400).json({ error: "Invalid vault name" });
  }

  if (req.renameRegisteredVault) {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => !["vault", "name"].includes(key)))
      return res.status(400).json({ error: "Invalid rename request" });
    try {
      const vault = await req.renameRegisteredVault(newName, {
        assertReady: id => {
          if (require("../plugin-system/manager").getDiscoveredPlugins().some(plugin => plugin.enabledVaults.includes(id)))
            throw Object.assign(new Error("Disable server plugins before renaming"), { code: "VAULT_BUSY" });
        },
        quiesce: async (id, vaultPath) => {
          treeReconcile.cancelVault(id);
          await quiesceRegisteredVault(id, vaultPath);
        },
        invalidate: (oldId, newId) => {
          treeReconcile.cancelVault(oldId);
          bootstrapCache.invalidateVault(oldId);
          bootstrapCache.invalidateVault(newId);
          const trustedVaults = settings.get("trustedVaults");
          if (trustedVaults.includes(oldId)) settings.update({ trustedVaults: trustedVaults.map(id => id === oldId ? newId : id) });
        },
      });
      config.refreshVaults();
      return res.json({ ok: true, id: vault.directory, uuid: vault.id, path: vault.path });
    } catch (error) {
      config.refreshVaults();
      const statuses = { VAULT_ALIAS: 409, VAULT_BUSY: 409, INVALID_VAULT_NAME: 400, VAULT_UNAVAILABLE: 409, VAULT_EXISTS: 409, SESSION_CHANGED: 401, VAULT_STATE_CHANGED: 409 };
      return res.status(statuses[error.code] || 503).json({ error: error.code === "VAULT_EXISTS" ? "Vault already exists" : error.code === "VAULT_BUSY" ? "Disable server plugins for this vault before renaming it" : error.code === "VAULT_ALIAS" ? "Remove legacy symlink aliases to this vault before renaming it" : "Vault rename could not be completed" });
    }
  }

  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault not found" });
  }

  if (
    newName !== vaultId &&
    Object.prototype.hasOwnProperty.call(config.vaults, newName)
  ) {
    return res
      .status(409)
      .json({ error: `A vault with name: ${newName} already exists` });
  }

  const newPath = path.join(config.vaultRoot, newName);

  try {
    await withWatcherStopped(vaultId, vaultPath, () =>
      fs.promises.rename(vaultPath, newPath),
    );

    config.refreshVaults();

    const trustedVaults = settings.get("trustedVaults");

    if (trustedVaults.includes(vaultId)) {
      settings.update({
        trustedVaults: trustedVaults.map((id) =>
          id === vaultId ? newName : id,
        ),
      });
    }

    treeReconcile.cancelVault(vaultId);
    bootstrapCache.invalidateVault(vaultId);
    bootstrapCache.invalidateVault(newName);

    res.json({ ok: true, id: newName, path: newPath });
  } catch (e) {
    if (e.code === "ENOTEMPTY" || e.code === "EEXIST") {
      return res
        .status(409)
        .json({ error: `A vault with name: ${newName} already exists` });
    }

    res.status(500).json(sanitizeError(e));
  }
});

// DELETE /api/vault/remove?vault=<id> - remove a vault from disk
router.delete("/remove", async (req, res) => {
  const vaultId = req.query.vault;
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault not found" });
  }

  try {
    await withWatcherStopped(vaultId, vaultPath, () =>
      fs.promises.rm(vaultPath, { recursive: true, force: true }),
    );

    config.refreshVaults();

    const trustedVaults = settings.get("trustedVaults");

    if (trustedVaults.includes(vaultId)) {
      settings.update({
        trustedVaults: trustedVaults.filter((id) => id !== vaultId),
      });
    }

    treeReconcile.cancelVault(vaultId);
    bootstrapCache.invalidateVault(vaultId);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

module.exports = router;
