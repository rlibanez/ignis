const { randomUUID, createHash } = require("node:crypto");
const { transaction } = require("./database");
const { deleteRegisteredVault, purgeRetiredVault } = require("./vault-deletion");
const busy = new WeakMap();
const fail = code => { throw Object.assign(new Error("Account deletion rejected"), { code }); };

function createUserDeletionService(db, root, lifecycle) {
  if (!busy.has(db)) busy.set(db, new Set());
  const running = busy.get(db);
  function authorize(actor, target, isCurrent) {
    if (typeof isCurrent !== "function" || !isCurrent(true) ||
        !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active'").get(actor)) fail("SESSION_CHANGED");
    if (actor === target) fail("SELF_DELETE");
    const user = db.prepare("SELECT id,login,role,status,auth_version FROM users WHERE id=?").get(target);
    if (!user) fail("USER_NOT_FOUND");
    if (user.role === "admin" && user.status === "active" &&
        db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND status='active'").get().n <= 1) fail("LAST_ADMIN");
    return user;
  }
  function owned(target) {
    return db.prepare(`SELECT v.id,v.name,v.directory,v.status,v.policy_version FROM vaults v
      JOIN memberships m ON m.vault_id=v.id WHERE m.user_id=? AND m.role='owner' ORDER BY v.id`).all(target);
  }
  function snapshot(actor, target, isCurrent) {
      const user = authorize(actor, target, isCurrent), vaults = owned(target);
      const job = db.prepare("SELECT * FROM user_deletions WHERE user_id=?").get(target);
      const tasks = job ? JSON.parse(job.vaults) : vaults.map(v => ({ id:v.id, name:v.name }));
      const progress = tasks.map(v => ({ ...v, state: db.prepare("SELECT state FROM vault_deletions WHERE vault_id=?").get(v.id)?.state || (vaults.find(current => current.id === v.id)?.status === "quarantine" ? "quarantine" : "not-started") }));
      const revision = createHash("sha256").update(JSON.stringify({user,vaults,job,progress})).digest("hex");
      return { userId:target, login:user.login, vaults, progress, started:!!job, revision };
  }
  function plan(actor, target, isCurrent) { return transaction(db, () => snapshot(actor,target,isCurrent)); }
  async function remove(actor, input, isCurrent) {
    if (running.has(input.userId)) fail("DELETE_BUSY");
    running.add(input.userId);
    let started = false;
    try {
      const tasks = transaction(db, () => {
        const currentPlan = snapshot(actor, input.userId, isCurrent);
        if (input.confirmLogin !== currentPlan.login || input.revision !== currentPlan.revision) fail("USER_STATE_CHANGED");
        if (typeof input.deleteVaults !== "boolean") fail("INVALID_DELETE");
        if ((currentPlan.vaults.length || currentPlan.started) && !input.deleteVaults) fail("OWNED_VAULTS");
        if (!currentPlan.started) {
          // Freeze the scope of this destructive operation before any asynchronous work.
          const list = currentPlan.vaults.map(v => ({ id:v.id, name:v.name }));
          if (list.length && (!root || !lifecycle)) fail("DELETE_UNAVAILABLE");
          db.prepare("INSERT INTO user_deletions VALUES (?,?,?)").run(input.userId,JSON.stringify(list),Date.now());
          db.prepare("DELETE FROM csrf_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)").run(input.userId);
          db.prepare("UPDATE users SET status='disabled',auth_version=auth_version+1 WHERE id=?").run(input.userId);
          db.prepare("DELETE FROM sessions WHERE user_id=?").run(input.userId);
          db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?)").run(randomUUID(),actor,"begin-delete-user",input.userId,Date.now());
        }
        return JSON.parse(db.prepare("SELECT vaults FROM user_deletions WHERE user_id=?").get(input.userId).vaults);
      });
      started = true;
      lifecycle?.sessionsChanged?.();
      for (const task of tasks) {
        authorize(actor,input.userId,isCurrent);
        const state = db.prepare("SELECT state FROM vault_deletions WHERE vault_id=?").get(task.id)?.state;
        if (state === "purged") continue;
        if (state === "retired") {
          if (!await purgeRetiredVault(db,root,task.id)) fail("DELETE_INCOMPLETE");
          continue;
        }
        if (state) fail("DELETE_INCOMPLETE"); // Never guess how to recover a quarantined vault.
        const result = await deleteRegisteredVault(db,root,actor,task.id,{
          ...lifecycle, deletingUser:input.userId, isCurrent,
        });
        if (result.cleanupPending) fail("DELETE_INCOMPLETE");
      }
      transaction(db, () => {
        authorize(actor,input.userId,isCurrent);
        if (owned(input.userId).length) fail("OWNED_VAULTS");
        // csrf_tokens has no foreign key to sessions.
        db.prepare("DELETE FROM csrf_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)").run(input.userId);
        db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?)").run(randomUUID(),actor,"delete-user",input.userId,Date.now());
        db.prepare("DELETE FROM users WHERE id=?").run(input.userId);
      });
      lifecycle?.sessionsChanged?.();
      return {ok:true};
    } catch (error) {
      if (started) {
        const snapshot = planIfAuthorized();
        return {ok:false, code:"DELETE_INCOMPLETE", reason:["VAULT_BUSY","VAULT_ALIAS","SESSION_CHANGED"].includes(error.code) ? error.code : "REVIEW_REQUIRED", ...snapshot};
      }
      throw error;
    } finally {
      running.delete(input.userId);
      lifecycle?.refresh?.();
    }
    function planIfAuthorized() {
      try { return { progress:plan(actor,input.userId,isCurrent).progress }; }
      catch { return {}; } // Never disclose account/vault data after operator revocation.
    }
  }
  return {plan,remove};
}
module.exports = { createUserDeletionService };
