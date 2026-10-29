const fs = require("node:fs");
const nodePath = require("node:path");
const { transaction } = require("./database");
const { resolveRegisteredVault } = require("./vault-catalog");
const { vaultCapabilityAllowed } = require("./vault-policy");
const denied = Object.freeze({ allowed: false });

// Preparatory service: data routes still enforce administrator-only access.
// Use a fresh decision immediately before an operation, not as a durable grant.
function createVaultAccessService(db, vaultRoot, sessions) {
  function evaluate(token, reference, operations) {
    try {
      return transaction(db, () => {
        const session = sessions.resolve(token, { withinTransaction: true });
        if (!session) return denied;
        const user = db.prepare("SELECT id,role,status,auth_version FROM users WHERE id=?").get(session.user.id);
        if (!user || user.status !== "active" || user.auth_version !== session.user.authVersion) return denied;
        let vault;
        try { vault = resolveRegisteredVault(db, vaultRoot, reference); }
        catch (error) {
          if (error.code === "VAULT_UNAVAILABLE") return denied;
          throw error;
        }
        const membership = db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(vault.id, user.id)?.role;
        if (!Array.isArray(operations) || !operations.length || !operations.every(({ capability, path }) =>
          vaultCapabilityAllowed({ status: user.status, instanceRole: user.role, membership, capability, path }))) return denied;
        // A lexical content path must not alias protected configuration through
        // an in-vault symlink. The outer FS guard also rejects escaping targets.
        for (const operation of operations) {
          if (!operation.capability.startsWith("content.")) continue;
          let currentPath = vault.path;
          for (const segment of operation.path.split("/").filter(Boolean)) {
            currentPath = nodePath.join(currentPath, segment);
            try { if (fs.lstatSync(currentPath).isSymbolicLink()) return denied; }
            catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") break; throw error; }
          }
        }
        return Object.freeze({
          allowed: true,
          sessionId: session.id,
          userId: user.id,
          vaultId: vault.id,
          directory: vault.directory,
          rootPath: vault.path,
          membership: membership || null,
          administrator: user.role === "admin",
          policyVersion: vault.policy_version,
        });
      });
    } catch {
      throw Object.assign(new Error("Authorization unavailable"), { code: "AUTHORIZATION_UNAVAILABLE" });
    }
  }
  const check = (token, { reference, capability, path } = {}) => evaluate(token, reference, [{ capability, path }]);
  const checkMany = (token, reference, operations) => evaluate(token, reference, operations);
  return Object.freeze({ check, checkMany });
}
module.exports = { createVaultAccessService };
