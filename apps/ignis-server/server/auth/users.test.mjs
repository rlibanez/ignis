import { it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createLocalUser, listUsers } = require("./users");
const { verifyPassword } = require("./password");
let db;
const password = "a-long-test-password!123";
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of require("./schema")) db.exec(migration.sql);
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0),('other','other','admin',0),('normal','normal','user',0)");
});
afterEach(() => db.close());

it("creates only a normal local user, hashes the password and audits without granting vault access", async () => {
  const user = await createLocalUser(db, "admin", "New.User", password);
  expect(user.login).toBe("new.user");
  expect(user.role).toBe("user");
  const stored = db.prepare("SELECT password_hash FROM local_credentials WHERE user_id=?").get(user.id);
  expect(stored.password_hash).not.toContain(password);
  expect(await verifyPassword(password, stored.password_hash)).toBe(true);
  expect(db.prepare("SELECT count(*) n FROM memberships WHERE user_id=?").get(user.id).n).toBe(0);
  expect(db.prepare("SELECT actor_id,action,resource_id FROM audit_events").get()).toEqual({
    actor_id: "admin", action: "create-local-user", resource_id: user.id,
  });
  expect(Object.keys(listUsers(db, "admin")[0]).sort()).toEqual(["email", "email_trust", "id", "login", "password_change_required", "role", "status"]);
});

it.each([undefined, "", "missing", "normal"])("rejects unauthorized actor %s", async (actor) => {
  await expect(createLocalUser(db, actor, "new-user", password)).rejects.toThrow();
  expect(() => listUsers(db, actor)).toThrow();
});

it("rejects disabled administrators and revocation during hashing", async () => {
  const pending = createLocalUser(db, "admin", "new-user", password);
  db.exec("UPDATE users SET status='disabled' WHERE id='admin'");
  await expect(pending).rejects.toThrow("Administrator required");
  expect(() => listUsers(db, "admin")).toThrow();
  expect(db.prepare("SELECT count(*) n FROM local_credentials").get().n).toBe(0);
});

it("enforces password policy and normalized uniqueness without partial writes", async () => {
  await expect(createLocalUser(db, null, "new-user", "short")).rejects.toThrow();
  await expect(createLocalUser(db, null, "ADMIN", password)).rejects.toThrow("Login already exists");
  expect(db.prepare("SELECT count(*) n FROM users").get().n).toBe(3);
  expect(db.prepare("SELECT count(*) n FROM audit_events").get().n).toBe(0);
});

it("does not let the CLI bypass first-administrator setup", async () => {
  db.close();
  db = new DatabaseSync(":memory:");
  for (const migration of require("./schema")) db.exec(migration.sql);
  await expect(createLocalUser(db, null, "new-user", password)).rejects.toThrow("first administrator");
  expect(listUsers(db, null)).toEqual([]);
});

it("rolls back account and credentials when audit insertion fails", async () => {
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  await expect(createLocalUser(db, null, "new-user", password)).rejects.toThrow();
  expect(db.prepare("SELECT count(*) n FROM users").get().n).toBe(3);
  expect(db.prepare("SELECT count(*) n FROM local_credentials").get().n).toBe(0);
});

it("rejects a session revoked while password hashing is in flight", async () => {
  let active = true;
  const pending = createLocalUser(db, "admin", "new-user", password, undefined, {
    isCurrent: () => active,
  });
  active = false;
  await expect(pending).rejects.toThrow("Administrator session required");
  expect(db.prepare("SELECT count(*) n FROM users").get().n).toBe(3);
  expect(db.prepare("SELECT count(*) n FROM audit_events").get().n).toBe(0);
});

const { changeUserStatus } = require("./users");
it("changes status atomically, revokes sessions and retains credentials and OIDC bindings", async () => {
  const user = await createLocalUser(db, "admin", "target", password);
  db.prepare("INSERT INTO oidc_identities VALUES ('https://provider.example','subject',?,0)").run(user.id);
  const sessions = require("./sessions").createSessionService(db);
  const local = await sessions.loginLocal("target", password);
  const external = sessions.issueForVerifiedOidcIdentity({
    issuer: "https://provider.example", subject: "subject", authenticatedAt: Date.now(),
  });
  changeUserStatus(db, "admin", user.id, "disabled", "active");
  expect(sessions.resolve(local.token)).toBeNull();
  expect(sessions.resolve(external.token)).toBeNull();
  expect(await sessions.loginLocal("target", password)).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM oidc_identities WHERE user_id=?").get(user.id).n).toBe(1);
  changeUserStatus(db, "admin", user.id, "active", "disabled");
  expect(sessions.resolve(local.token)).toBeNull();
  expect(await sessions.loginLocal("target", password)).not.toBeNull();
  expect(db.prepare("SELECT action FROM audit_events WHERE action IN ('disable-user','enable-user') ORDER BY rowid").all().map(x => x.action)).toEqual(["disable-user", "enable-user"]);
});
it("rejects unauthorized, stale, self-disabling and last-admin status changes", () => {
  expect(() => changeUserStatus(db, "normal", "other", "disabled", "active")).toThrow();
  expect(() => changeUserStatus(db, undefined, "normal", "disabled", "active")).toThrow();
  expect(() => changeUserStatus(db, "admin", "normal", "disabled", "active", { isCurrent: () => false })).toThrow();
  expect(() => changeUserStatus(db, "admin", "admin", "disabled", "active")).toThrow();
  changeUserStatus(db, "admin", "other", "disabled", "active");
  expect(() => changeUserStatus(db, null, "admin", "disabled", "active")).toThrow();
  expect(() => changeUserStatus(db, "other", "normal", "disabled", "active")).toThrow();
});
it("rejects stale status snapshots and rolls back on audit failure", () => {
  expect(() => changeUserStatus(db, "admin", "normal", "active", "disabled")).toThrow();
  expect(() => changeUserStatus(db, "admin", "missing", "active", "disabled")).toThrow();
  const before = db.prepare("SELECT auth_version FROM users WHERE id='normal'").get().auth_version;
  db.exec("CREATE TRIGGER fail_status_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  expect(() => changeUserStatus(db, "admin", "normal", "disabled", "active")).toThrow();
  expect(db.prepare("SELECT status,auth_version FROM users WHERE id='normal'").get()).toEqual({ status: "active", auth_version: before });
});

const { revokeUserSessions } = require("./users");
it("revokes all local and OIDC sessions without changing account status or credentials", async () => {
  const user = await createLocalUser(db, "admin", "revoke-target", password);
  db.prepare("INSERT INTO oidc_identities VALUES ('https://provider.example','revoke-sub',?,0)").run(user.id);
  const sessions = require("./sessions").createSessionService(db);
  const local = await sessions.loginLocal(user.login, password);
  const oidc = sessions.issueForVerifiedOidcIdentity({
    issuer: "https://provider.example", subject: "revoke-sub", authenticatedAt: Date.now(),
  });
  expect(revokeUserSessions(db, "admin", user.id).revokedSessions).toBe(2);
  expect(sessions.resolve(local.token)).toBeNull();
  expect(sessions.resolve(oidc.token)).toBeNull();
  expect(db.prepare("SELECT status FROM users WHERE id=?").get(user.id).status).toBe("active");
  expect(await sessions.loginLocal(user.login, password)).not.toBeNull();
});
it("allows last-admin self-revocation and audits even when no sessions exist", () => {
  db.exec("UPDATE users SET status='disabled' WHERE id='other'");
  const before = db.prepare("SELECT auth_version FROM users WHERE id='admin'").get().auth_version;
  expect(revokeUserSessions(db, "admin", "admin").revokedSessions).toBe(0);
  expect(db.prepare("SELECT role,status,auth_version FROM users WHERE id='admin'").get()).toEqual({
    role: "admin", status: "active", auth_version: before + 1,
  });
  expect(db.prepare("SELECT actor_id,action,resource_id FROM audit_events").get()).toEqual({
    actor_id: "admin", action: "revoke-user-sessions", resource_id: "admin",
  });
});
it("rejects unauthorized revocation and rolls back if auditing fails", () => {
  expect(() => revokeUserSessions(db, "normal", "admin")).toThrow();
  expect(() => revokeUserSessions(db, undefined, "admin")).toThrow();
  expect(() => revokeUserSessions(db, "admin", "normal", { isCurrent: () => false })).toThrow();
  expect(() => revokeUserSessions(db, "admin", "missing")).toThrow();
  const before = db.prepare("SELECT auth_version FROM users WHERE id='normal'").get().auth_version;
  db.exec("CREATE TRIGGER fail_revocation_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  expect(() => revokeUserSessions(db, "admin", "normal")).toThrow();
  expect(db.prepare("SELECT auth_version FROM users WHERE id='normal'").get().auth_version).toBe(before);
});

const { unlinkUserOidc } = require("./users");
it("unlinks only the configured issuer, revokes sessions and retains local access", async () => {
  const user = await createLocalUser(db, "admin", "unlink-target", password);
  for (const issuer of ["https://current.example", "https://other.example"])
    db.prepare("INSERT INTO oidc_identities VALUES (?, 'subject', ?, 0)").run(issuer, user.id);
  const sessions = require("./sessions").createSessionService(db);
  const local = await sessions.loginLocal(user.login, password);
  const external = sessions.issueForVerifiedOidcIdentity({
    issuer: "https://current.example", subject: "subject", authenticatedAt: Date.now(),
  });
  expect(unlinkUserOidc(db, "admin", user.id, "https://current.example")).toEqual({ unlinked: true });
  expect(sessions.resolve(local.token)).toBeNull();
  expect(sessions.resolve(external.token)).toBeNull();
  expect(db.prepare("SELECT issuer FROM oidc_identities WHERE user_id=?").all(user.id)).toEqual([{ issuer: "https://other.example" }]);
  expect(await sessions.loginLocal(user.login, password)).not.toBeNull();
  expect(db.prepare("SELECT action FROM audit_events WHERE action='unlink-oidc-user'").get().action).toBe("unlink-oidc-user");
});
it("rejects removing the only login method and unauthorized or stale actors", () => {
  db.exec("INSERT INTO oidc_identities VALUES ('https://current.example','subject','normal',0)");
  expect(() => unlinkUserOidc(db, "admin", "normal", "https://current.example")).toThrow();
  expect(() => unlinkUserOidc(db, "normal", "normal", "https://current.example")).toThrow();
  expect(() => unlinkUserOidc(db, undefined, "normal", "https://current.example")).toThrow();
  expect(() => unlinkUserOidc(db, "admin", "normal", "https://current.example", { isCurrent: () => false })).toThrow();
  expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(1);
});
it("rolls back unlink and session revocation if the audit write fails", async () => {
  const user = await createLocalUser(db, "admin", "rollback-target", password);
  db.prepare("INSERT INTO oidc_identities VALUES ('https://current.example','subject',?,0)").run(user.id);
  const sessions = require("./sessions").createSessionService(db);
  const local = await sessions.loginLocal(user.login, password);
  db.exec("CREATE TRIGGER fail_unlink_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  expect(() => unlinkUserOidc(db, "admin", user.id, "https://current.example")).toThrow();
  expect(sessions.resolve(local.token)).not.toBeNull();
  expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(1);
});

it("creates optional emails atomically with explicit admin confirmation", async () => {
  const user = await createLocalUser(db, "admin", "email-user", password, undefined, { email: "Test@Example.com", emailVerified: true });
  expect(db.prepare("SELECT email,email_trust FROM users WHERE id=?").get(user.id)).toEqual({ email: "test@example.com", email_trust: "admin_confirmed" });
  await expect(createLocalUser(db, "admin", "duplicate-email", password, undefined, { email: "test@example.com" })).rejects.toThrow();
  expect(db.prepare("SELECT 1 FROM users WHERE login='duplicate-email'").get()).toBeUndefined();
  await expect(createLocalUser(db, "admin", "empty-email", password, undefined, { emailVerified: true })).rejects.toThrow();
});
it("resets email trust on change, rejects stale edits and rolls back status on duplicate email", async () => {
  const user = await createLocalUser(db, "admin", "edit-email", password, undefined, { email: "old@example.com", emailVerified: true });
  const options = { emailUpdate: { email: "new@example.com", emailVerified: false, expectedEmail: "old@example.com", expectedEmailTrust: "admin_confirmed" } };
  const sessions = require("./sessions").createSessionService(db);
  const session = await sessions.loginLocal(user.login, password);
  changeUserStatus(db, "admin", user.id, "active", "active", options);
  expect(sessions.resolve(session.token)).toBeNull();
  expect(db.prepare("SELECT email_trust FROM users WHERE id=?").get(user.id).email_trust).toBe("unverified");
  expect(() => changeUserStatus(db, "admin", user.id, "disabled", "active", options)).toThrow();
  db.exec("UPDATE users SET email='taken@example.com' WHERE id='normal'");
  expect(() => changeUserStatus(db, "admin", user.id, "disabled", "active", { emailUpdate: { email: "taken@example.com", emailVerified: true, expectedEmail: "new@example.com", expectedEmailTrust: "unverified" } })).toThrow();
  expect(db.prepare("SELECT status FROM users WHERE id=?").get(user.id).status).toBe("active");
});

const { setInitialLocalPassword } = require("./users");
const setupPolicy = require("./password-policy").readPasswordPolicy();
const currentAdmin = { isCurrent: () => true };
function oidcOnly() {
  db.exec("INSERT INTO oidc_identities VALUES ('https://provider.example','initial-sub','normal',0)");
  const sessions = require("./sessions").createSessionService(db);
  const session = sessions.issueForVerifiedOidcIdentity({ issuer: "https://provider.example", subject: "initial-sub", authenticatedAt: Date.now() });
  return { sessions, session };
}
it("sets a first password, revokes sessions, preserves OIDC and allows subsequent unlink and local login", async () => {
  const { sessions, session } = oidcOnly();
  await setInitialLocalPassword(db, "admin", "normal", password, setupPolicy, currentAdmin);
  expect(sessions.resolve(session.token)).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(1);
  expect(db.prepare("SELECT actor_id,action,resource_id FROM audit_events").get()).toEqual({ actor_id: "admin", action: "set-initial-local-password", resource_id: "normal" });
  require("./users").unlinkUserOidc(db, "admin", "normal", "https://provider.example");
  expect(await sessions.loginLocal("normal", password)).not.toBeNull();
  await expect(setInitialLocalPassword(db, "admin", "normal", password, setupPolicy, currentAdmin)).rejects.toMatchObject({ code: "LOCAL_PASSWORD_EXISTS" });
});
it("rejects unauthorized, stale, missing-link and weak-password setup", async () => {
  await expect(setInitialLocalPassword(db, "admin", "normal", password, setupPolicy, currentAdmin)).rejects.toMatchObject({ code: "OIDC_NOT_LINKED" });
  oidcOnly();
  for (const actor of [null, undefined, "normal", "missing"])
    await expect(setInitialLocalPassword(db, actor, "normal", password, setupPolicy, currentAdmin)).rejects.toThrow();
  await expect(setInitialLocalPassword(db, "admin", "normal", password, setupPolicy)).rejects.toThrow();
  await expect(setInitialLocalPassword(db, "admin", "normal", "short", setupPolicy, currentAdmin)).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
  await expect(setInitialLocalPassword(db, "admin", "normal", password, setupPolicy, { isCurrent: inside => !inside })).rejects.toThrow();
  expect(db.prepare("SELECT count(*) n FROM local_credentials").get().n).toBe(0);
});
it("rejects a target changed during hashing and rolls back credential/session changes on audit failure", async () => {
  const { sessions, session } = oidcOnly();
  const pending = setInitialLocalPassword(db, "admin", "normal", password, setupPolicy, currentAdmin);
  db.exec("UPDATE users SET auth_version=auth_version+1 WHERE id='normal'");
  await expect(pending).rejects.toMatchObject({ code: "USER_STATE_CHANGED" });
  const before = db.prepare("SELECT auth_version FROM users WHERE id='normal'").get();
  const sessionCount = db.prepare("SELECT count(*) n FROM sessions").get().n;
  db.exec("CREATE TRIGGER fail_initial_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  await expect(setInitialLocalPassword(db, "admin", "normal", password, setupPolicy, currentAdmin)).rejects.toThrow();
  expect(db.prepare("SELECT count(*) n FROM local_credentials").get().n).toBe(0);
  expect(db.prepare("SELECT auth_version FROM users WHERE id='normal'").get()).toEqual(before);
  expect(db.prepare("SELECT count(*) n FROM sessions").get().n).toBe(sessionCount);
  expect(sessions.resolve(session.token)).toBeNull();
});
it("does not overwrite a password when two setup requests race", async () => {
  oidcOnly();
  const outcomes = await Promise.allSettled([password, password + "other"].map(value => setInitialLocalPassword(db, "admin", "normal", value, setupPolicy, currentAdmin)));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(db.prepare("SELECT count(*) n FROM audit_events").get().n).toBe(1);
});

it("requires explicit promotion confirmation and revokes sessions on promotion and demotion", async () => {
  const user = await createLocalUser(db, "admin", "role-target", password);
  const sessions = require("./sessions").createSessionService(db);
  const original = await sessions.loginLocal(user.login, password);
  const roleUpdate = { role: "admin", expectedRole: "user", confirmAdmin: false };
  expect(() => changeUserStatus(db, "admin", user.id, "active", "active", { roleUpdate })).toThrow();
  roleUpdate.confirmAdmin = true;
  expect(changeUserStatus(db, "admin", user.id, "active", "active", { roleUpdate }).role).toBe("admin");
  expect(sessions.resolve(original.token)).toBeNull();
  const promoted = await sessions.loginLocal(user.login, password);
  expect(promoted.session.user.role).toBe("admin");
  roleUpdate.role = "user"; roleUpdate.expectedRole = "admin"; roleUpdate.confirmAdmin = false;
  changeUserStatus(db, "admin", user.id, "active", "active", { roleUpdate });
  expect(sessions.resolve(promoted.token)).toBeNull();
  expect((await sessions.loginLocal(user.login, password)).session.user.role).toBe("user");
  expect(db.prepare("SELECT action FROM audit_events WHERE resource_id=? ORDER BY rowid").all(user.id).map(row => row.action)).toEqual(["create-local-user", "promote-user-admin", "demote-user-admin"]);
});
it("rejects unauthorized role edits, stale snapshots, malformed roles and self-demotion", () => {
  const roleUpdate = { role: "admin", expectedRole: "user", confirmAdmin: true };
  expect(() => changeUserStatus(db, "normal", "normal", "active", "active", { roleUpdate })).toThrow();
  expect(() => changeUserStatus(db, "admin", "normal", "active", "active", { roleUpdate, isCurrent: () => false })).toThrow();
  expect(() => changeUserStatus(db, "admin", "normal", "active", "active", { roleUpdate: { ...roleUpdate, role: "owner" } })).toThrow();
  expect(() => changeUserStatus(db, "admin", "normal", "active", "active", { roleUpdate: { ...roleUpdate, expectedRole: "admin" } })).toThrow();
  expect(() => changeUserStatus(db, "admin", "admin", "active", "active", { roleUpdate: { role: "user", expectedRole: "admin", confirmAdmin: false } })).toThrow();
});
it("protects the last administrator and rolls back combined email/status/role edits", () => {
  const demotion = { role: "user", expectedRole: "admin", confirmAdmin: false };
  changeUserStatus(db, "admin", "other", "active", "active", { roleUpdate: demotion });
  expect(() => changeUserStatus(db, null, "admin", "active", "active", { roleUpdate: demotion })).toThrow();
  expect(() => db.exec("UPDATE users SET role='user' WHERE id='admin'")).toThrow();
  const roleUpdate = { role: "admin", expectedRole: "user", confirmAdmin: true };
  const emailUpdate = { email: "invalid", emailVerified: false, expectedEmail: null, expectedEmailTrust: "unverified" };
  expect(() => changeUserStatus(db, "admin", "normal", "disabled", "active", { roleUpdate, emailUpdate })).toThrow();
  expect(db.prepare("SELECT role,status FROM users WHERE id='normal'").get()).toEqual({ role: "user", status: "active" });
  db.exec("CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  expect(() => changeUserStatus(db, "admin", "normal", "active", "active", { roleUpdate })).toThrow();
  expect(db.prepare("SELECT role FROM users WHERE id='normal'").get().role).toBe("user");
});
