import { it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { changePassword } = require("./change-password");
const { hashPassword, verifyPassword } = require("./password");
const { readPasswordPolicy } = require("./password-policy");
const policy = readPasswordPolicy({});
const old = "old-test-password", next = "new-test-password";
let db;
beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  for (const migration of require("./schema")) db.exec(migration.sql);
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('u','user','user',0)");
  db.prepare("INSERT INTO local_credentials VALUES ('u',?,0)").run(await hashPassword(old));
});
afterEach(() => db.close());
const credential = () => db.prepare("SELECT password_hash FROM local_credentials WHERE user_id='u'").get().password_hash;
it("updates the hash, revokes sessions and preserves OIDC identity", async () => {
  db.exec("INSERT INTO oidc_identities VALUES ('https://idp.example','sub','u',0)");
  const sessions = require("./sessions").createSessionService(db);
  const local = await sessions.loginLocal("user", old);
  const oidc = sessions.issueForVerifiedOidcIdentity({ issuer: "https://idp.example", subject: "sub", authenticatedAt: Date.now() });
  await changePassword(db, "u", old, next, policy, { isCurrent: () => true });
  expect(sessions.resolve(local.token)).toBeNull();
  expect(sessions.resolve(oidc.token)).toBeNull();
  expect(await verifyPassword(next, credential())).toBe(true);
  expect(await verifyPassword(old, credential())).toBe(false);
  expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(1);
  expect(db.prepare("SELECT action FROM audit_events").get().action).toBe("change-password");
});
it("rejects wrong current passwords, policy violations and unchanged passwords", async () => {
  const before = credential();
  for (const [current, replacement, code] of [["wrong", next, "INVALID_PASSWORD"], [old, "short", "PASSWORD_POLICY"], [old, old, "PASSWORD_UNCHANGED"]])
    await expect(changePassword(db, "u", current, replacement, policy, { isCurrent: () => true })).rejects.toMatchObject({ code });
  expect(credential()).toBe(before);
});
it("rejects a session revoked during hashing", async () => {
  const before = credential();
  await expect(changePassword(db, "u", old, next, policy, { isCurrent: (inside) => !inside })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(credential()).toBe(before);
});
it("rejects a credential version changed while verification is in flight", async () => {
  const before = credential();
  const pending = changePassword(db, "u", old, next, policy, { isCurrent: () => true });
  db.exec("UPDATE users SET auth_version=auth_version+1 WHERE id='u'");
  await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(credential()).toBe(before);
});
it("rolls back the password update when auditing fails", async () => {
  const before = credential();
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'failed'); END");
  await expect(changePassword(db, "u", old, next, policy, { isCurrent: () => true })).rejects.toThrow();
  expect(credential()).toBe(before);
});
it("does not create credentials for an OIDC-only account", async () => {
  db.exec("DELETE FROM local_credentials WHERE user_id='u'");
  await expect(changePassword(db, "u", old, next, policy, { isCurrent: () => true })).rejects.toMatchObject({ code: "INVALID_PASSWORD" });
  expect(db.prepare("SELECT count(*) n FROM local_credentials").get().n).toBe(0);
});

const { setOwnLocalPassword } = require('./change-password');
async function externalAccount() {
  db.exec("DELETE FROM local_credentials WHERE user_id='u'; INSERT INTO oidc_identities VALUES ('https://idp.example','sub','u',0)");
  return {user:{id:'u'},method:'oidc',issuer:'https://idp.example',subject:'sub',authenticatedAt:1000000};
}
it('sets the first own password and retains the exact provider identity',async()=>{
 const session=await externalAccount();
 await setOwnLocalPassword(db,'u',next,policy,{resolveSession:()=>session,now:()=>1000001});
 expect(await verifyPassword(next,credential())).toBe(true);
 expect(db.prepare("SELECT subject FROM oidc_identities WHERE user_id='u'").get().subject).toBe('sub');
 await expect(setOwnLocalPassword(db,'u',old,policy,{resolveSession:()=>session,now:()=>1000001})).rejects.toMatchObject({code:'LOCAL_PASSWORD_EXISTS'});
});
it('rejects stale, future, local, mismatched and revoked authentication',async()=>{
 const session=await externalAccount();
 for(const bad of [null,{...session,method:'local'},{...session,subject:'another'},{...session,user:{id:'other'}},{...session,authenticatedAt:700000},{...session,authenticatedAt:1000001}])
  await expect(setOwnLocalPassword(db,'u',next,policy,{resolveSession:()=>bad,now:()=>1000000})).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
 expect(db.prepare('SELECT count(*) n FROM local_credentials').get().n).toBe(0);
});
it('rechecks revocation and credential creation after hashing',async()=>{
 const session=await externalAccount();
 await expect(setOwnLocalPassword(db,'u',next,policy,{resolveSession:inside=>inside?null:session,now:()=>1000000})).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
 const results=await Promise.allSettled([next,old].map(password=>setOwnLocalPassword(db,'u',password,policy,{resolveSession:()=>session,now:()=>1000000})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
});
it('rejects invalid policy and rolls back failed audit for own password setup',async()=>{
 const session=await externalAccount(),options={resolveSession:()=>session,now:()=>1000000};
 await expect(setOwnLocalPassword(db,'u','short',policy,options)).rejects.toMatchObject({code:'PASSWORD_POLICY'});
 db.exec("CREATE TRIGGER fail_own_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'failed'); END");
 await expect(setOwnLocalPassword(db,'u',next,policy,options)).rejects.toThrow();
 expect(db.prepare('SELECT count(*) n FROM local_credentials').get().n).toBe(0);
});
