const { transaction } = require("./database");
const { resolveRegisteredVault } = require("./vault-catalog");
const { vaultCapabilityAllowed } = require("./vault-policy");
const denied = Object.freeze({ allowed: false });

// Preparatory service: data routes still enforce administrator-only access.
// Use a fresh decision immediately before an operation, not as a durable grant.
function createVaultAccessService(db, vaultRoot, sessions) {
  function check(token, { reference, capability, path } = {}) {
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
        if (!vaultCapabilityAllowed({ status: user.status, instanceRole: user.role, membership, capability, path })) return denied;
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
  return Object.freeze({ check });
}
module.exports = { createVaultAccessService };
