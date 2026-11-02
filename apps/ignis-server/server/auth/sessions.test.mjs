import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const { openDatabase, backupDatabase, restoreDatabase } = require("./database");
const { hashPassword, verifyPassword } = require("./password");
const { createSessionService } = require("./sessions");
const PASSWORD = "a synthetic test passphrase";
let encoded, root, db, clock, service;

beforeAll(async () => {
  encoded = await hashPassword(PASSWORD);
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-sessions-"));
  db = openDatabase(root);
  clock = 1000000;
  db.prepare(
    "INSERT INTO users(id,login,role,created_at) VALUES (?, ?, ?, 1)",
  ).run("admin", "admin", "admin");
  for (const id of ["alice", "bob", "external"]) {
    db.prepare(
      "INSERT INTO users(id,login,role,created_at) VALUES (?, ?, 'user', 1)",
    ).run(id, id);
  }
  for (const id of ["admin", "alice", "bob"]) {
    db.prepare("INSERT INTO local_credentials VALUES (?, ?, 1)").run(
      id,
      encoded,
    );
  }
  db.prepare("INSERT INTO oidc_identities VALUES (?, ?, 'external', 1)").run(
    "https://issuer.example",
    "subject",
  );
  service = createSessionService(db, {
    now: () => clock,
    idleMs: 100,
    absoluteMs: 1000,
  });
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const oidc = () =>
  service.issueForVerifiedOidcIdentity({
    issuer: "https://issuer.example",
    subject: "subject",
    authenticatedAt: clock,
  });

describe("password verification", () => {
  it("accepts only the correct password and does not normalize or truncate it", async () => {
    expect(await verifyPassword(PASSWORD, encoded)).toBe(true);
    expect(await verifyPassword(PASSWORD + " ", encoded)).toBe(false);
    expect(await verifyPassword(PASSWORD.toUpperCase(), encoded)).toBe(false);
    const unicode = "á".repeat(15);
    const hash = await hashPassword(unicode);
    expect(await verifyPassword(unicode.normalize("NFD"), hash)).toBe(false);
    expect(await verifyPassword(unicode, hash)).toBe(true);
  });
  it("rejects malformed hashes and never executes arbitrary KDF parameters", async () => {
    for (const invalid of [
      null,
      "",
      encoded.replace("131072", "1073741824"),
      encoded.slice(0, -1),
      "argon2$untrusted",
    ]) {
      expect(await verifyPassword(PASSWORD, invalid)).toBe(false);
    }
  });
  it("bounds inputs before hashing", async () => {
    for (const input of [null, {}, "", "x".repeat(1025), "á".repeat(513)]) {
      expect(await verifyPassword(input, encoded)).toBe(false);
    }
  });
  it("limits concurrent KDF jobs without an unbounded queue and releases capacity", async () => {
    const first = verifyPassword(PASSWORD, encoded);
    const second = verifyPassword(PASSWORD, null);
    await expect(verifyPassword(PASSWORD, encoded)).rejects.toMatchObject({
      code: "AUTH_BUSY",
    });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(await verifyPassword(PASSWORD, encoded)).toBe(true);
  });
});

describe("local authentication", () => {
  it("uses the internal UUID and exposes neither hash nor password in the session", async () => {
    const result = await service.loginLocal("ALICE", PASSWORD);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.session.user).toMatchObject({ id: "alice", role: "user" });
    expect(result.session).toMatchObject({
      method: "local",
      issuer: null,
      subject: null,
      authenticatedAt: clock,
    });
    const row = db.prepare("SELECT * FROM sessions").get();
    expect(row.token_hash).toBe(
      createHash("sha256").update(result.token).digest("hex"),
    );
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(JSON.stringify(result)).not.toContain(encoded);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
  it("returns the same failure for unknown, disabled, external-only and wrong credentials", async () => {
    db.exec("UPDATE users SET status = 'disabled' WHERE id = 'bob'");
    for (const [login, password] of [
      ["missing", PASSWORD],
      ["bob", PASSWORD],
      ["external", PASSWORD],
      ["alice", "wrong"],
      ["../alice", PASSWORD],
    ]) {
      expect(await service.loginLocal(login, password)).toBeNull();
    }
    expect(db.prepare("SELECT count(*) n FROM sessions").get().n).toBe(0);
  });
  it("refuses login if credentials change while password verification is in flight", async () => {
    const pending = service.loginLocal("alice", PASSWORD);
    db.prepare(
      "UPDATE local_credentials SET password_hash = ? WHERE user_id = 'alice'",
    ).run(encoded);
    expect(await pending).toBeNull();
  });
  it("refuses login if user is disabled and reenabled during verification", async () => {
    const pending = service.loginLocal("alice", PASSWORD);
    db.exec(
      "UPDATE users SET status = 'disabled' WHERE id = 'alice'; UPDATE users SET status = 'active' WHERE id = 'alice'",
    );
    expect(await pending).toBeNull();
  });
  it("revoking all sessions invalidates an in-flight local login", async () => {
    const pending = service.loginLocal("alice", PASSWORD);
    service.revokeUser("alice");
    expect(await pending).toBeNull();
  });
});

describe("session lifecycle", () => {
  it("expires at the exact idle boundary; passive lookups do not extend activity", () => {
    const { token } = oidc();
    clock += 99;
    expect(service.resolve(token)).not.toBeNull();
    clock++;
    expect(service.resolve(token)).toBeNull();
    expect(service.resolve(token, { touch: true })).toBeNull();
  });
  it("touch extends inactivity but never absolute lifetime", () => {
    const start = clock;
    const { token } = oidc();
    for (let i = 0; i < 11; i++) {
      clock += 90;
      expect(service.resolve(token, { touch: true }).expiresAt).toBe(
        start + 1000,
      );
    }
    clock += 10;
    expect(service.resolve(token, { touch: true })).toBeNull();
  });
  it("rotates atomically without extending lifetime or accepting the old token/hash", () => {
    const first = oidc();
    clock += 20;
    const next = service.rotate(first.token);
    expect(next.token).not.toBe(first.token);
    expect(next.session.id).not.toBe(first.session.id);
    expect(next.session.expiresAt).toBe(first.session.expiresAt);
    expect(next.session.authenticatedAt).toBe(first.session.authenticatedAt);
    expect(service.resolve(first.token)).toBeNull();
    expect(service.rotate(first.token)).toBeNull();
    expect(service.resolve(next.token)).not.toBeNull();
    const hash = db.prepare("SELECT token_hash FROM sessions").get().token_hash;
    expect(service.resolve(hash)).toBeNull();
  });
  it("logout is idempotent and revoked sessions cannot be revived", () => {
    const { token } = oidc();
    expect(service.revoke(token)).toBe(true);
    expect(service.revoke(token)).toBe(false);
    expect(service.resolve(token)).toBeNull();
    expect(service.rotate(token)).toBeNull();
  });
  it("persists across restart and observes revocation from another connection", () => {
    const { token } = oidc();
    const second = openDatabase(root);
    try {
      const other = createSessionService(second, { now: () => clock });
      expect(other.resolve(token)).not.toBeNull();
      other.revokeUser("external");
      expect(service.resolve(token)).toBeNull();
    } finally {
      second.close();
    }
  });
  it("rejects malformed tokens, unknown tokens and backwards time", () => {
    const { token } = oidc();
    for (const value of [
      undefined,
      {},
      "",
      token + "\r\n",
      "x".repeat(64),
      "a".repeat(64),
      "a".repeat(10000),
    ]) {
      expect(service.resolve(value)).toBeNull();
    }
    clock--;
    expect(service.resolve(token)).toBeNull();
  });
  it("caps sessions without discarding the newest and purges expired sessions", () => {
    service = createSessionService(db, {
      now: () => clock,
      idleMs: 100,
      absoluteMs: 1000,
      maxSessionsPerUser: 2,
    });
    const first = oidc();
    clock++;
    const second = oidc();
    clock++;
    const third = oidc();
    expect(service.resolve(first.token)).toBeNull();
    expect(service.resolve(second.token)).not.toBeNull();
    expect(service.resolve(third.token)).not.toBeNull();
    clock += 100;
    expect(service.purgeExpired()).toBe(2);
  });
  it("rejects invalid policy and fails closed on unavailable storage", () => {
    for (const options of [
      { idleMs: 0 },
      { absoluteMs: -1 },
      { maxSessionsPerUser: 101 },
      { idleMs: Infinity },
    ]) {
      expect(() => createSessionService(db, options)).toThrow();
    }
    const { token } = oidc();
    db.close();
    expect(() => service.resolve(token)).toThrow();
    db = openDatabase(root);
  });
});

describe("identity changes and OIDC adapter boundary", () => {
  it("resolves only exact linked issuer+subject, with explicit authentication time", () => {
    const input = {
      issuer: "https://issuer.example",
      subject: "subject",
      authenticatedAt: clock,
    };
    const result = oidc();
    expect(result.session).toMatchObject({
      method: "oidc",
      issuer: input.issuer,
      subject: input.subject,
    });
    expect(result.session.user.id).toBe("external");
    for (const patch of [
      { issuer: "https://evil.example" },
      { subject: "Subject" },
      { subject: "missing" },
      { authenticatedAt: undefined },
      { authenticatedAt: clock + 1 },
      { authenticatedAt: clock - 1000 },
    ]) {
      expect(
        service.issueForVerifiedOidcIdentity({ ...input, ...patch }),
      ).toBeNull();
    }
  });
  it("does not create accounts or trust external role fields", () => {
    const result = service.issueForVerifiedOidcIdentity({
      issuer: "https://issuer.example",
      subject: "subject",
      authenticatedAt: clock,
      role: "admin",
      userId: "admin",
    });
    expect(result.session.user).toMatchObject({ id: "external", role: "user" });
    expect(db.prepare("SELECT count(*) n FROM users").get().n).toBe(4);
  });
  it("revokes on status/role change, even after restoring the former value", () => {
    for (const [field, value, original] of [
      ["status", "disabled", "active"],
      ["role", "admin", "user"],
    ]) {
      const { token } = oidc();
      db.prepare(`UPDATE users SET ${field} = ? WHERE id = 'external'`).run(
        value,
      );
      expect(service.resolve(token)).toBeNull();
      if (field === "status") expect(oidc()).toBeNull();
      db.prepare(`UPDATE users SET ${field} = ? WHERE id = 'external'`).run(
        original,
      );
      expect(service.resolve(token)).toBeNull();
    }
  });
  it("invalidates sessions for credential changes and identity unlink/relink", async () => {
    const local = await service.loginLocal("alice", PASSWORD);
    db.prepare(
      "UPDATE local_credentials SET password_hash = ? WHERE user_id = 'alice'",
    ).run(encoded);
    expect(service.resolve(local.token)).toBeNull();
    const external = oidc();
    db.exec("DELETE FROM oidc_identities WHERE user_id = 'external'");
    expect(service.resolve(external.token)).toBeNull();
    db.prepare("INSERT INTO oidc_identities VALUES (?, ?, 'external', 1)").run(
      "https://issuer.example",
      "subject",
    );
    expect(service.resolve(external.token)).toBeNull();
  });
  it("supports provider-wide revocation without revoking unrelated users", async () => {
    const external = oidc();
    const local = await service.loginLocal("alice", PASSWORD);
    expect(service.revokeIssuer("https://issuer.example")).toBe(1);
    expect(service.resolve(external.token)).toBeNull();
    expect(service.resolve(local.token)).not.toBeNull();
  });
});

describe("revocation edge cases", () => {
  it("rejects identity-version changes made by another trusted service", () => {
    const { token } = oidc();
    db.exec(
      "UPDATE users SET auth_version = auth_version + 1 WHERE id = 'external'",
    );
    expect(service.resolve(token)).toBeNull();
  });
  it("revokes all methods when a local credential is added to an external account", () => {
    const { token } = oidc();
    db.prepare("INSERT INTO local_credentials VALUES ('external', ?, 1)").run(
      encoded,
    );
    expect(service.resolve(token)).toBeNull();
  });
  it("revokes local sessions when a credential is removed", async () => {
    const { token } = await service.loginLocal("alice", PASSWORD);
    db.exec("DELETE FROM local_credentials WHERE user_id = 'alice'");
    expect(service.resolve(token)).toBeNull();
    expect(await service.loginLocal("alice", PASSWORD)).toBeNull();
  });
  it("revokes deleted users and identities reassigned by trusted administration", () => {
    const { token } = oidc();
    db.exec(
      "UPDATE oidc_identities SET user_id = 'bob' WHERE user_id = 'external'",
    );
    expect(service.resolve(token)).toBeNull();
    const next = oidc();
    expect(next.session.user.id).toBe("bob");
    db.exec("DELETE FROM users WHERE id = 'bob'");
    expect(service.resolve(next.token)).toBeNull();
  });
});

describe("session backup recovery", () => {
  it("restores identities but never restores usable bearer sessions", () => {
    const { token } = oidc();
    const backup = path.join(root, "snapshot.sqlite");
    backupDatabase(db, backup);
    service.revoke(token);
    const destination = path.join(root, "restored");
    restoreDatabase(backup, destination);
    const restored = openDatabase(destination);
    try {
      const recovered = createSessionService(restored, { now: () => clock });
      expect(recovered.resolve(token)).toBeNull();
      expect(restored.prepare("SELECT count(*) n FROM users").get().n).toBe(4);
      expect(
        restored.prepare("SELECT count(*) n FROM oidc_identities").get().n,
      ).toBe(1);
    } finally {
      restored.close();
    }
  });
});

describe('persistent device grants',()=>{
 it('restores an expired lease, rotates secrets and preserves identity and authentication age',()=>{
  const first=oidc(),grant=service.remember(first.token),authTime=first.session.authenticatedAt;
  expect(grant.expiresAt-clock).toBe(90*86400000);
  expect(db.prepare('SELECT token_hash FROM remembered_sessions').get().token_hash).not.toBe(grant.token);
  clock+=2000;service.purgeExpired();expect(service.resolve(first.token)).toBeNull();
  const restored=service.resume(grant.token,first.token);
  expect(restored.token).not.toBe(first.token);expect(restored.remember.token).not.toBe(grant.token);
  expect(restored.session.id).toBe(first.session.id);expect(restored.session.authenticatedAt).toBe(authTime);
  expect(service.resolve(restored.token)?.user.id).toBe('external');
  expect(restored.remember.expiresAt).toBe(clock+90*86400000);
 });
 it('coalesces concurrent renewals, but revokes the family on later replay',()=>{
  const first=oidc(),grant=service.remember(first.token);clock+=2000;
  const a=service.resume(grant.token,first.token),b=service.resume(grant.token,first.token);
  expect(b).toEqual(a);clock+=10001;
  expect(service.resume(grant.token,first.token)).toBeNull();
  expect(service.resume(a.remember.token,a.token)).toBeNull();
 });
 it('survives a service restart without storing raw tokens',()=>{
  const first=oidc(),grant=service.remember(first.token);clock+=2000;
  const restarted=createSessionService(db,{now:()=>clock});
  expect(restarted.resume(grant.token,null)?.session.user.id).toBe('external');
 });
 it('expires at the configured deadline and never revives a normal expired session',()=>{
  const short=createSessionService(db,{now:()=>clock,rememberDays:1});
  const first=short.issueForVerifiedOidcIdentity({issuer:'https://issuer.example',subject:'subject',authenticatedAt:clock});
  const grant=short.remember(first.token);clock+=86400000;
  expect(short.resume(grant.token,null)).toBeNull();expect(short.resolve(first.token)).toBeNull();
 });
 it.each(['logout','all','disable','delete','unlink','password-required'])('revokes persistence on %s',action=>{
  const first=oidc(),grant=service.remember(first.token);
  if(action==='logout')service.revoke(first.token);
  if(action==='all')service.revokeUser('external');
  if(action==='disable')db.prepare("UPDATE users SET status='disabled' WHERE id='external'").run();
  if(action==='delete')db.prepare("DELETE FROM users WHERE id='external'").run();
  if(action==='unlink')db.prepare("DELETE FROM oidc_identities WHERE user_id='external'").run();
  if(action==='password-required')db.prepare("UPDATE users SET password_change_required=1 WHERE id='external'").run();
  expect(service.resume(grant.token,null)).toBeNull();
  expect(db.prepare('SELECT count(*) n FROM remembered_sessions').get().n).toBe(0);
 });
 it('does not replace a valid session belonging to a different account',async()=>{
  const first=oidc(),grant=service.remember(first.token),other=await service.loginLocal('alice',PASSWORD);
  expect(service.resume(grant.token,other.token)).toBeNull();expect(service.resolve(other.token).user.id).toBe('alice');
 });
 it('revokes a device by its persistent cookie after its short lease expires',()=>{
  const first=oidc(),grant=service.remember(first.token);clock+=2000;service.forget(grant.token);
  expect(service.resume(grant.token,null)).toBeNull();
 });
});

it('revokes local persistence on credential changes and forced password reset',async()=>{
 for(const action of ['password','reset']){
  const auth=await service.loginLocal('alice',PASSWORD),grant=service.remember(auth.token);
  if(action==='password')db.prepare('UPDATE local_credentials SET password_hash=? WHERE user_id=?').run(encoded,'alice');
  else db.prepare("UPDATE users SET password_change_required=1 WHERE id='alice'").run();
  expect(service.resume(grant.token,null)).toBeNull();
 }
});
it('never serves a cached renewal after revocation',()=>{
 const first=oidc(),grant=service.remember(first.token);clock+=2000;
 const next=service.resume(grant.token,null);service.revoke(next.token);
 expect(service.resume(grant.token,null)).toBeNull();expect(service.resume(next.remember.token,null)).toBeNull();
});
it('fails closed on a retired credential after restart',()=>{
 const first=oidc(),grant=service.remember(first.token);clock+=2000;
 const next=service.resume(grant.token,null);
 const restarted=createSessionService(db,{now:()=>clock});
 expect(restarted.resume(grant.token,null)).toBeNull();expect(restarted.resume(next.remember.token,null)).toBeNull();
});
it('bounds remembered devices through the existing per-user session limit',()=>{
 const first=oidc(),grant=service.remember(first.token);
 for(let i=0;i<10;i++){clock++;const auth=oidc();service.remember(auth.token);}
 expect(service.resume(grant.token,null)).toBeNull();
 expect(db.prepare('SELECT count(*) n FROM remembered_sessions').get().n).toBe(10);
});

describe("local reauthentication preserves the editor context", () => {
  it("rotates the secret, preserves identity and expiry, and refreshes authentication", async () => {
    const initial = await service.loginLocal("admin", PASSWORD);
    clock += 50;
    const renewed = await service.reauthenticateLocal(initial.token, initial.session.id, PASSWORD);
    expect(renewed.session.id).toBe(initial.session.id);
    expect(renewed.session.user).toEqual(initial.session.user);
    expect(renewed.session.expiresAt).toBe(initial.session.expiresAt);
    expect(renewed.session.authenticatedAt).toBe(clock);
    expect(renewed.token).not.toBe(initial.token);
    expect(service.resolve(initial.token)).toBeNull();
    expect(service.resolve(renewed.token).id).toBe(initial.session.id);
  });
  it("rejects a wrong password and context while allowing own normal-user reauthentication", async () => {
    const initial = await service.loginLocal("admin", PASSWORD);
    expect(await service.reauthenticateLocal(initial.token, initial.session.id, "wrong")).toBeNull();
    expect(await service.reauthenticateLocal(initial.token, "different", PASSWORD)).toBeNull();
    expect(service.resolve(initial.token)).not.toBeNull();
    const normal = await service.loginLocal("alice", PASSWORD);
    const renewed=await service.reauthenticateLocal(normal.token, normal.session.id, PASSWORD);
    expect(renewed.session.user.id).toBe(normal.session.user.id);
    expect(renewed.session.user.role).toBe("user");
    expect(service.resolve(normal.token)).toBeNull();
  });
  it("does not revive a session revoked while password verification is running", async () => {
    const initial = await service.loginLocal("admin", PASSWORD);
    const pending = service.reauthenticateLocal(initial.token, initial.session.id, PASSWORD);
    service.revokeUser("admin");
    expect(await pending).toBeNull();
    expect(service.resolve(initial.token)).toBeNull();
  });
});
