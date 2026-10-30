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
    ...(req.vaultUUID?.(id) ? { uuid: req.vaultUUID(id) } : {}),
    path: vaultPath,
  }));

  res.json(req.vaultView ? req.vaultView.list(list) : list);
});

function membersRequest(req, res, operation) {
  if (!req.vaultMembers) return res.status(503).json({ error: "Access management unavailable" });
  if ((operation === "list" && (Object.keys(req.query).length !== 1 || typeof req.query.vault !== "string")) ||
      (operation === "update" && (Object.keys(req.query).length || !req.body || Array.isArray(req.body))))
    return res.status(400).json({ error: "Invalid access request" });
  try { res.json(req.vaultMembers(operation, operation === "list" ? req.query.vault : req.body)); }
  catch (error) {
    const errors = {
      VAULT_UNAVAILABLE: [404, "Vault unavailable or you are no longer its owner."],
      INVALID_MEMBERSHIP: [400, "Select a username and a valid permission."],
      MEMBER_UNAVAILABLE: [409, "No active account with that username is available."],
      OWNER_PROTECTED: [409, "The owner cannot be changed here."],
      MEMBERSHIP_CONFLICT: [409, "Access changed in another window. Reload members before trying again."],
    };
    const [status, message] = errors[error.code] || [503, "Unable to manage vault access."];
    res.status(status).json({ error: message });
  }
}
router.get("/members", (req,res) => membersRequest(req,res,"list"));
router.post("/members", (req,res) => membersRequest(req,res,"update"));

router.get("/owners", (req, res) => {
  if (!req.vaultOwners) return res.status(503).json({ error: "Vault owners unavailable" });
  try { res.json({ owners: req.vaultOwners() }); }
  catch { res.status(503).json({ error: "Unable to list vault owners" }); }
});

// Administrative inspection does not create directories, identities or memberships.
router.get("/registration", (req, res) => {
  if (!req.vaultRegistrationOptions) return res.status(503).json({ error: "Vault registration unavailable" });
  try { res.json(req.vaultRegistrationOptions()); }
  catch { res.status(503).json({ error: "Unable to inspect existing vaults" }); }
});

router.post("/register", (req, res) => {
  const body = req.body;
  if (Object.keys(req.query).length || !body || Array.isArray(body) || Object.keys(body).length !== 3 ||
      Object.keys(body).some(key => !["directory", "ownerId", "identity"].includes(key)) ||
      typeof body.directory !== "string" || typeof body.ownerId !== "string" ||
      typeof body.identity !== "string" || !/^[a-f0-9]{64}$/.test(body.identity))
    return res.status(400).json({ error: "Select an existing vault and its owner" });
  if (!req.registerExistingVault) return res.status(503).json({ error: "Vault registration unavailable" });
  try {
    const vault = req.registerExistingVault(body.directory, body.ownerId, body.identity);
    config.refreshVaults();
    bootstrapCache.invalidateVault(vault.name);
    return res.json({ ok: true, id: vault.name, uuid: vault.id });
  } catch (error) {
    const statuses = { INVALID_DIRECTORY: 400, INVALID_ROOT: 409, INVALID_VAULT: 409, VAULT_ALIAS: 409,
      VAULT_RESERVED: 409, OWNER_UNAVAILABLE: 409, SESSION_CHANGED: 401, DIRECTORY_CHANGED: 409 };
    const messages = require("../auth/vault-registration").messages;
    return res.status(statuses[error.code] || 503).json({ error: messages[error.code] || "Vault registration could not be completed" });
  }
});

// GET /api/vault/info?vault=<id> - returns info for a specific vault
router.get("/info", async (req, res) => {
  config.refreshVaults();
  const vaultId = require("../vault/request-selection").selectRequestVault(req, config, { allowDefault: true });
  const vaultPath = vaultId && config.getVaultPathOrRescan(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault unavailable" });
  }

  const info = { ...bootstrapCache.buildVaultInfo(vaultId, vaultPath), uuid: req.vaultUUID?.(vaultId) };
  try { res.json(req.vaultView ? req.vaultView.info(info) : info); }
  catch { res.status(404).json({error:"Vault unavailable"}); }
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

// POST /api/vault/create { name, ownerId? } - create a new vault in VAULT_ROOT
router.post("/create", async (req, res) => {
  const name = req.body?.name;

  if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => !["name", "ownerId"].includes(key)) || !isValidVaultName(name)) {
    return res.status(400).json({ error: "Invalid vault name" });
  }
  if (Object.hasOwn(req.body, "ownerId") && (typeof req.body.ownerId !== "string" || !req.body.ownerId || req.body.ownerId.length > 128))
    return res.status(400).json({ error: "Select a valid vault owner" });

  if (typeof req.createRegisteredVault !== "function")
    return res.status(503).json({ error: "Vault registration unavailable" });
  try {
    const vault = req.createRegisteredVault(name, req.body.ownerId);
    config.refreshVaults();
    bootstrapCache.invalidateVault(name);
    // Keep the directory ID used by the current editor; UUID is its stable identity.
    res.json({ ok: true, id: name, uuid: vault.id, path: vault.path });
  } catch (e) {
    const statuses = { OWNER_UNAVAILABLE: 409, INVALID_VAULT_NAME: 400, INVALID_VAULT_ROOT: 503, VAULT_EXISTS: 409, SESSION_CHANGED: 401, VAULT_STATE_CHANGED: 409 };
    return res.status(statuses[e.code] || 503).json({ error: e.code === "VAULT_EXISTS" ? "Vault already exists" : e.code === "OWNER_UNAVAILABLE" ? "Select an active user as the vault owner" : "Vault creation could not be completed" });
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
  if (req.deleteRegisteredVault) {
    if (Object.keys(req.query).some(key => key !== "vault") || (req.body && Object.keys(req.body).length))
      return res.status(400).json({ error: "Invalid deletion request" });
    try {
      const result = await req.deleteRegisteredVault({
        assertReady: id => {
          if (require("../plugin-system/manager").getDiscoveredPlugins().some(plugin => plugin.enabledVaults.includes(id)))
            throw Object.assign(new Error("Disable server plugins before deleting"), { code: "VAULT_BUSY" });
        },
        quiesce: async (id, vaultPath) => {
          treeReconcile.cancelVault(id);
          await quiesceRegisteredVault(id, vaultPath);
        },
        invalidate: id => {
          treeReconcile.cancelVault(id);
          bootstrapCache.invalidateVault(id);
          const trustedVaults = settings.get("trustedVaults");
          if (trustedVaults.includes(id)) settings.update({ trustedVaults: trustedVaults.filter(value => value !== id) });
        },
      });
      config.refreshVaults();
      return res.json({ ok: true, uuid: result.id, cleanupPending: result.cleanupPending });
    } catch (error) {
      config.refreshVaults();
      const messages = {
        VAULT_ID_REQUIRED: "Reload the vault list before deleting this vault",
        VAULT_BUSY: "Disable server plugins for this vault before deleting it",
        VAULT_ALIAS: "Remove legacy symlink aliases to this vault before deleting it",
      };
      const statuses = { VAULT_ID_REQUIRED: 409, VAULT_BUSY: 409, VAULT_ALIAS: 409, VAULT_UNAVAILABLE: 409, VAULT_STATE_CHANGED: 409, SESSION_CHANGED: 401 };
      return res.status(statuses[error.code] || 503).json({ error: messages[error.code] || "Vault deletion could not be completed" });
    }
  }

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
