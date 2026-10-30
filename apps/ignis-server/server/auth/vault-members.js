const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");
const { resolveRegisteredVault } = require("./vault-catalog");
const { normalizeLogin } = require("./store");
const fail = code => { throw Object.assign(new Error("Vault access management failed"), { code }); };

function createVaultMembersService(db, root, sessions) {
  function authorize(token, reference) {
    const session = sessions.resolve(token, { withinTransaction: true });
    if (!session) fail("VAULT_UNAVAILABLE");
    let vault;
    try { vault = resolveRegisteredVault(db, root, reference); } catch { fail("VAULT_UNAVAILABLE"); }
    // Mutations pin the UUID: an old form cannot grant access to a replacement directory.
    if (reference !== vault.id) fail("VAULT_UNAVAILABLE");
    const member = db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(vault.id, session.user.id);
    if (member?.role !== "owner") fail("VAULT_UNAVAILABLE");
    return { vault, session };
  }
  function snapshot(vault) {
    return {
      vault: vault.id,
      revision: db.prepare("SELECT policy_version FROM vaults WHERE id=?").get(vault.id).policy_version,
      members: db.prepare(`SELECT u.id,u.login,u.status,m.role FROM memberships m
        JOIN users u ON u.id=m.user_id WHERE m.vault_id=? ORDER BY u.login,u.id`).all(vault.id),
    };
  }
  function list(token, reference) {
    return transaction(db, () => snapshot(authorize(token, reference).vault));
  }
  function update(token, input) {
    return transaction(db, () => {
      const { vault, session } = authorize(token, input?.vault);
      if (!input || Object.keys(input).sort().join(",") !== "expectedRole,login,revision,role,vault" ||
          ![null,"reader","editor"].includes(input.role) || ![null,"reader","editor"].includes(input.expectedRole) ||
          !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision >= Number.MAX_SAFE_INTEGER)
        fail("INVALID_MEMBERSHIP");
      let login;
      try { login = normalizeLogin(input.login); } catch { fail("INVALID_MEMBERSHIP"); }
      const target = db.prepare("SELECT id,status FROM users WHERE login=?").get(login);
      if (!target || (input.role !== null && target.status !== "active")) fail("MEMBER_UNAVAILABLE");
      const previous = db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(vault.id,target.id)?.role ?? null;
      if (previous === "owner" || target.id === session.user.id) fail("OWNER_PROTECTED");
      const version = db.prepare("SELECT policy_version FROM vaults WHERE id=?").get(vault.id).policy_version;
      if (version !== input.revision || previous !== input.expectedRole) fail("MEMBERSHIP_CONFLICT");
      if (previous !== input.role) {
        if (input.role === null) db.prepare("DELETE FROM memberships WHERE vault_id=? AND user_id=?").run(vault.id,target.id);
        else db.prepare(`INSERT INTO memberships VALUES (?,?,?) ON CONFLICT(vault_id,user_id) DO UPDATE SET role=excluded.role`).run(vault.id,target.id,input.role);
        db.prepare("UPDATE vaults SET policy_version=policy_version+1 WHERE id=?").run(vault.id);
        db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?)").run(randomUUID(),session.user.id,"update-vault-member",JSON.stringify({vaultId:vault.id,userId:target.id,from:previous,to:input.role}),Date.now());
      }
      return snapshot(vault);
    });
  }
  function transfer(token, input) {
    return transaction(db, () => {
      const { vault, session } = authorize(token, input?.vault);
      if (!input || Object.keys(input).sort().join(",") !== "confirm,expectedRole,revision,userId,vault" ||
          input.confirm !== true || typeof input.userId !== "string" ||
          !["reader", "editor"].includes(input.expectedRole) ||
          !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision >= Number.MAX_SAFE_INTEGER)
        fail("INVALID_TRANSFER");
      const target = db.prepare(`SELECT u.id,u.status,m.role FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.vault_id=? AND u.id=?`).get(vault.id,input.userId);
      if (!target || target.status !== "active" || target.id === session.user.id || target.role === "owner")
        fail("TRANSFER_TARGET_UNAVAILABLE");
      if (target.role !== input.expectedRole || vault.policy_version !== input.revision ||
          db.prepare("SELECT count(*) n FROM memberships WHERE vault_id=? AND role='owner'").get(vault.id).n !== 1)
        fail("MEMBERSHIP_CONFLICT");
      db.prepare("UPDATE memberships SET role='editor' WHERE vault_id=? AND user_id=?").run(vault.id,session.user.id);
      db.prepare("UPDATE memberships SET role='owner' WHERE vault_id=? AND user_id=?").run(vault.id,target.id);
      db.prepare("UPDATE vaults SET policy_version=policy_version+1 WHERE id=?").run(vault.id);
      db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?)").run(randomUUID(),session.user.id,"transfer-vault-ownership",
        JSON.stringify({vaultId:vault.id,from:session.user.id,to:target.id,formerOwnerRole:"editor"}),Date.now());
      return { ok:true, vault:vault.id, ownerId:target.id, membership:"editor" };
    });
  }
  return { list, update, transfer };
}
module.exports = { createVaultMembersService };
