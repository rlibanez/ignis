import { it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { issuePasswordReset, completePasswordReset } = require("./password-reset");
const { hashPassword, verifyPassword } = require("./password");
const { createSessionService } = require("./sessions");
const policy = require("./password-policy").readPasswordPolicy();
const oldPassword = "previous-password!123";
const newPassword = "replacement-password!123";
let db, time, sessions, originalHash;
const options = { isCurrent: () => true, now: () => time };
beforeEach(async () => {
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const migration of require("./schema")) db.exec(migration.sql);
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0),('target','target','user',0)");
  originalHash = await hashPassword(oldPassword, policy);
  db.prepare("INSERT INTO local_credentials VALUES ('target',?,0)").run(originalHash);
  db.exec("INSERT INTO oidc_identities VALUES ('https://provider.example','subject','target',0)");
  time = Date.now();
  sessions = createSessionService(db, { now: () => time });
});
afterEach(() => db.close());
const issue = () => issuePasswordReset(db, "admin", "target", options);
const complete = secret => completePasswordReset(db, secret, newPassword, policy, options);
it("uses 32 random base64url characters, stores only a hash, revokes all sessions and blocks local/OIDC access until completion", async () => {
  const local = await sessions.loginLocal("target", oldPassword);
  const oidc = sessions.issueForVerifiedOidcIdentity({ issuer: "https://provider.example", subject: "subject", authenticatedAt: time });
  const reset = issue();
  expect(reset.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(reset.expiresAt).toBe(time + 3600000);
  expect(JSON.stringify(db.prepare("SELECT * FROM password_resets").all())).not.toContain(reset.secret);
  expect(JSON.stringify(db.prepare("SELECT * FROM audit_events").all())).not.toContain(reset.secret);
  expect(sessions.resolve(local.token)).toBeNull(); expect(sessions.resolve(oidc.token)).toBeNull();
  expect(await sessions.loginLocal("target", oldPassword)).toBeNull();
  expect(await sessions.loginLocal("target", reset.secret)).toBeNull();
  expect(sessions.issueForVerifiedOidcIdentity({ issuer: "https://provider.example", subject: "subject", authenticatedAt: time })).toBeNull();
  await complete(reset.secret);
  expect(db.prepare("SELECT count(*) n FROM sessions").get().n).toBe(0);
  expect(await sessions.loginLocal("target", oldPassword)).toBeNull();
  expect(await sessions.loginLocal("target", newPassword)).not.toBeNull();
  expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(1);
  await expect(complete(reset.secret)).rejects.toMatchObject({ code: "INVALID_RESET" });
});
it("expires exactly at one hour without reactivating the old password and replaces previous secrets", async () => {
  const first = issue(); time = first.expiresAt;
  await expect(complete(first.secret)).rejects.toMatchObject({ code: "INVALID_RESET" });
  expect(await sessions.loginLocal("target", oldPassword)).toBeNull();
  const second = issue(); expect(second.secret).not.toBe(first.secret);
  await expect(complete(first.secret)).rejects.toThrow();
  await complete(second.secret);
});
it("requires an active administrator and a current session; refuses missing, disabled and passwordless targets", () => {
  for (const actor of [undefined, "target", "missing"])
    expect(() => issuePasswordReset(db, actor, "target", options)).toThrow();
  expect(() => issuePasswordReset(db, "admin", "target", { isCurrent: () => false })).toThrow();
  expect(() => issuePasswordReset(db, "admin", "admin", options)).toThrow();
  expect(() => issuePasswordReset(db, "admin", "missing", options)).toThrow();
  db.exec("UPDATE users SET status='disabled' WHERE id='target'"); expect(issue).toThrow();
  db.exec("UPDATE users SET status='active', role='admin' WHERE id='target'; UPDATE users SET status='disabled' WHERE id='admin'"); expect(issue).toThrow();
});
it("does not consume the secret on password-policy failure and rejects malformed or unknown secrets", async () => {
  const { secret } = issue();
  await expect(completePasswordReset(db, secret, "short", policy, options)).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
  for (const value of [null, "", secret + "a", "!".repeat(32), "a".repeat(32)]) await expect(complete(value)).rejects.toMatchObject({ code: "INVALID_RESET" });
  await complete(secret);
});
it("allows only one concurrent redemption", async () => {
  const { secret } = issue();
  const result = await Promise.allSettled([complete(secret), complete(secret)]);
  expect(result.filter(x => x.status === "fulfilled")).toHaveLength(1);
  expect(result.filter(x => x.status === "rejected")).toHaveLength(1);
  expect(db.prepare("SELECT count(*) n FROM audit_events WHERE action='complete-password-reset'").get().n).toBe(1);
});
it.each(["expiry", "replacement", "disable", "version"])("rechecks %s after hashing", async change => {
  const { secret } = issue();
  const pending = complete(secret);
  if (change === "expiry") time += 3600000;
  if (change === "replacement") issue();
  if (change === "disable") db.exec("UPDATE users SET status='disabled' WHERE id='target'");
  if (change === "version") db.exec("UPDATE users SET auth_version=auth_version+1 WHERE id='target'");
  await expect(pending).rejects.toMatchObject({ code: "INVALID_RESET" });
  expect(db.prepare("SELECT password_hash FROM local_credentials WHERE user_id='target'").get().password_hash).toBe(originalHash);
});
it("rolls back issuance and completion if auditing fails", async () => {
  db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  expect(issue).toThrow(); expect(db.prepare("SELECT count(*) n FROM password_resets").get().n).toBe(0);
  expect(await sessions.loginLocal("target", oldPassword)).not.toBeNull();
  db.exec("DROP TRIGGER audit_fail"); const { secret } = issue();
  db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  await expect(complete(secret)).rejects.toThrow();
  expect(await verifyPassword(oldPassword, db.prepare("SELECT password_hash FROM local_credentials WHERE user_id='target'").get().password_hash)).toBe(true);
  expect(db.prepare("SELECT count(*) n FROM password_resets").get().n).toBe(1);
  db.exec("DROP TRIGGER audit_fail"); await complete(secret);
});
it("supports privileged CLI regeneration after an administrator loses its secret", async () => {
  db.prepare("INSERT INTO local_credentials VALUES ('admin',?,0)").run(originalHash);
  const first = issuePasswordReset(db, "admin", "admin", options);
  const second = issuePasswordReset(db, null, "admin", { now: () => time });
  await expect(complete(first.secret)).rejects.toThrow();
  await complete(second.secret);
  expect(await sessions.loginLocal("admin", newPassword)).not.toBeNull();
});

it("persists the reset requirement across database reopen and consumes a persisted secret", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { openDatabase } = require("./database");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-reset-restart-"));
  let disk;
  try {
    disk = openDatabase(root);
    disk.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0)");
    disk.prepare("INSERT INTO local_credentials VALUES ('admin',?,0)").run(originalHash);
    const { secret } = issuePasswordReset(disk, null, "admin", { now: () => time });
    disk.close(); disk = openDatabase(root);
    const reopenedSessions = createSessionService(disk, { now: () => time });
    expect(await reopenedSessions.loginLocal("admin", oldPassword)).toBeNull();
    await completePasswordReset(disk, secret, newPassword, policy, options);
    expect(await reopenedSessions.loginLocal("admin", newPassword)).not.toBeNull();
  } finally { disk?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

const { beginPasswordReset, readPasswordResetGrant, completePasswordResetGrant } = require("./password-reset");
it("binds temporary login to username, consumes it once and grants only password reset", async () => {
  const { secret } = issue();
  expect(beginPasswordReset(db, "admin", secret, options)).toBeNull();
  const grant = beginPasswordReset(db, "target", secret, options);
  expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
  expect(grant.expiresAt).toBe(time + 3600000);
  expect(beginPasswordReset(db, "target", secret, options)).toBeNull();
  expect(sessions.resolve(grant.token)).toBeNull();
  const state = readPasswordResetGrant(db, grant.token, options);
  expect(state.login).toBe("target");
  await expect(complete(secret)).rejects.toThrow();
  await expect(completePasswordResetGrant(db, grant.token, "wrong", newPassword, policy, options)).rejects.toThrow();
  await completePasswordResetGrant(db, grant.token, state.context, newPassword, policy, options);
  expect(readPasswordResetGrant(db, grant.token, options)).toBeNull();
  await expect(completePasswordResetGrant(db, grant.token, state.context, newPassword, policy, options)).rejects.toThrow();
});
it("invalidates restricted grants on replacement and at the original expiry without extending lifetime", () => {
  const first = issue(); time += 3500000;
  const grant = beginPasswordReset(db, "target", first.secret, options);
  expect(grant.expiresAt).toBe(first.expiresAt);
  time = first.expiresAt;
  expect(readPasswordResetGrant(db, grant.token, options)).toBeNull();
  const next = issue(); const nextGrant = beginPasswordReset(db, "target", next.secret, options);
  issue(); expect(readPasswordResetGrant(db, nextGrant.token, options)).toBeNull();
});
it("rolls back exchange on audit failure and rejects simultaneous grant redemption", async () => {
  const { secret } = issue();
  db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  expect(() => beginPasswordReset(db, "target", secret, options)).toThrow();
  db.exec("DROP TRIGGER audit_fail");
  const grant = beginPasswordReset(db, "target", secret, options);
  const state = readPasswordResetGrant(db, grant.token, options);
  const results = await Promise.allSettled([1,2].map(() => completePasswordResetGrant(db, grant.token, state.context, newPassword, policy, options)));
  expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
});
