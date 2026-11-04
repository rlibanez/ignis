const fs = require("node:fs");
const nodePath = require("node:path");
const { transaction } = require("../../../platform/persistence/database");
const { resolveRegisteredVault } = require("./vault-catalog.js");
const { vaultCapabilityAllowed } = require("../application/vault-policy.js");
const {sessionContext}=require('../../../../../../packages/contracts/src/session');
const denied = Object.freeze({ allowed: false });

// Data routes use this service for live per-vault decisions.
// Use a fresh decision immediately before an operation, not as a durable grant.
function createVaultAccessService(db, vaultRoot, sessions) {
  // Cache compiled statements, never their rows or authorization results.
  const statements=new Map();
  const statement=sql=>{if(!statements.has(sql))statements.set(sql,db.prepare(sql));return statements.get(sql);};
  const catalogDb={prepare:statement};
  function evaluate(token, reference, operations, projection = false) {
    try {
      return transaction(db, () => {
        const session = sessions.resolve(token, { withinTransaction: true });
        if (!session) return denied;
        const user = statement("SELECT id,role,status,auth_version FROM users WHERE id=?").get(session.user.id);
        if (!user || user.status !== "active" || user.auth_version !== session.user.authVersion) return denied;
        let vault;
        try { vault = resolveRegisteredVault(catalogDb, vaultRoot, reference); }
        catch (error) {
          if (error.code === "VAULT_UNAVAILABLE") return denied;
          throw error;
        }
        const membership = statement("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(vault.id, user.id)?.role;
        if (!Array.isArray(operations) || !operations.length) return denied;
        const principal={status:user.status,instanceRole:user.role,membership};
        if(projection && !vaultCapabilityAllowed({...principal,capability:"content.list",path:""}))return denied;
        // This memo belongs to one synchronous DB snapshot only. Never retain it
        // across awaits, requests or response revalidation (including symlink state).
        const inspected=operations.length>1 ? new Map() : null;
        function permitted(operation) {
          if(!vaultCapabilityAllowed({...principal,capability:operation.capability,path:operation.path}))return false;
          if(!operation.capability.startsWith("content."))return true;
          let currentPath=vault.path;
          for(const segment of operation.path.split("/").filter(Boolean)){
            currentPath=nodePath.join(currentPath,segment);
            let state=inspected?.get(currentPath);
            if(state===undefined){
              try{state=fs.lstatSync(currentPath).isSymbolicLink()?"link":"safe";}
              catch(error){if(error.code==="ENOENT" || error.code==="ENOTDIR")state="missing";else throw error;}
              inspected?.set(currentPath,state);
            }
            if(state==="link")return false;
            if(state==="missing")break;
          }
          return true;
        }
        const permittedOperations=projection ? operations.map(permitted) : null;
        if(!projection && !operations.every(permitted))return denied;
        return Object.freeze({
          allowed: true,
          ...(projection ? {permittedOperations:Object.freeze(permittedOperations)} : {}),
          context:sessionContext(session),
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
  const project=(token,reference,operations)=>evaluate(token,reference,operations,true);
  return Object.freeze({ check, checkMany, project });
}
module.exports = { createVaultAccessService };
