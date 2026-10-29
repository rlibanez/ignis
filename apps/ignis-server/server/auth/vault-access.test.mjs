import { beforeAll, beforeEach, afterEach, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { registerVault } = require("./store");
const { hashPassword } = require("./password");
const { createSessionService } = require("./sessions");
const { createVaultAccessService } = require("./vault-access");
const password = "synthetic access test passphrase";
let hash, root, vaultRoot, db, sessions, access, a, b, alice, admin, clock;
beforeAll(async () => { hash = await hashPassword(password); });
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-access-"));
  vaultRoot = path.join(root, "vaults");
  fs.mkdirSync(vaultRoot);
  for (const name of ["A", "B", "Legacy"]) fs.mkdirSync(path.join(vaultRoot, name));
  db = openDatabase(path.join(root, "data"));
  for (const [id, role] of [["admin", "admin"], ["alice", "user"], ["bob", "user"]]) {
    db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)").run(id, id, role);
    db.prepare("INSERT INTO local_credentials VALUES (?,?,0)").run(id, hash);
  }
  a = registerVault(db, vaultRoot, "A", "admin");
  b = registerVault(db, vaultRoot, "B", "bob");
  db.prepare("INSERT INTO memberships VALUES (?, 'alice', 'reader')").run(a.id);
  clock = 1000000;
  sessions = createSessionService(db, { now: () => clock, idleMs: 1000, absoluteMs: 10000 });
  alice = (await sessions.loginLocal("alice", password)).token;
  admin = (await sessions.loginLocal("admin", password)).token;
  access = createVaultAccessService(db, vaultRoot, sessions);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const read = reference => ({ reference, capability: "content.read", path: "note.md" });
it("derives membership from the database, isolates vaults and ignores injected roles", () => {
  const decision = access.check(alice, { ...read(a.id), instanceRole: "admin", membership: "owner", userId: "bob" });
  expect(decision).toMatchObject({ allowed: true, userId: "alice", vaultId: a.id, membership: "reader", administrator: false });
  expect(Object.isFrozen(decision)).toBe(true);
  expect(access.check(alice, read("A"))).toEqual(decision);
  expect(access.check(alice, read(b.id))).toEqual({ allowed: false });
  expect(access.check(alice, { ...read(a.id), capability: "content.write", membership: "owner" })).toEqual({ allowed: false });
});
it("observes role changes and revocation on the next decision without a cache", () => {
  const operation = { ...read(a.id), capability: "content.write" };
  expect(access.check(alice, operation).allowed).toBe(false);
  db.prepare("UPDATE memberships SET role='editor' WHERE user_id='alice'").run();
  expect(access.check(alice, operation).allowed).toBe(true);
  db.prepare("DELETE FROM memberships WHERE user_id='alice'").run();
  expect(access.check(alice, read(a.id))).toEqual({ allowed: false });
});
it("requires a live session and observes disablement and expiry", () => {
  expect(access.check("invalid", read(a.id))).toEqual({ allowed: false });
  db.prepare("UPDATE users SET status='disabled' WHERE id='alice'").run();
  expect(access.check(alice, read(a.id))).toEqual({ allowed: false });
  clock += 1001;
  expect(access.check(admin, read(a.id))).toEqual({ allowed: false });
});
it("marks administrative bypass but cannot bypass invalid paths or unavailable vaults", () => {
  expect(access.check(admin, read(b.id))).toMatchObject({ allowed: true, administrator: true, membership: null });
  for (const reference of ["missing", "Legacy"]) expect(access.check(admin, read(reference))).toEqual({ allowed: false });
  for (const target of ["../note.md", ".ignis-trash/note.md", ""])
    expect(access.check(admin, { ...read(a.id), path: target })).toEqual({ allowed: false });
  db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(a.id);
  expect(access.check(admin, read(a.id))).toEqual({ allowed: false });
});
it("does not give vault owners access to shared configuration or Sync", () => {
  db.prepare("UPDATE memberships SET role='owner' WHERE user_id='alice'").run();
  expect(access.check(alice, { reference: a.id, capability: "members.manage" }).allowed).toBe(true);
  expect(access.check(alice, { reference: a.id, capability: "sync.manage" })).toEqual({ allowed: false });
  expect(access.check(alice, { ...read(a.id), path: ".obsidian/plugins/example/data.json" })).toEqual({ allowed: false });
});
it("keeps identity across rename and never transfers grants to a replacement", () => {
  fs.renameSync(path.join(vaultRoot, "A"), path.join(vaultRoot, "Renamed"));
  db.prepare("UPDATE vaults SET directory='Renamed',name='Renamed' WHERE id=?").run(a.id);
  expect(access.check(alice, read(a.id))).toMatchObject({ allowed: true, directory: "Renamed", vaultId: a.id });
  db.prepare("DELETE FROM vaults WHERE id=?").run(a.id);
  const replacement = registerVault(db, vaultRoot, "Renamed", "admin");
  expect(access.check(alice, read(a.id))).toEqual({ allowed: false });
  expect(access.check(alice, read(replacement.id))).toEqual({ allowed: false });
  expect(access.check(alice, read("Renamed"))).toEqual({ allowed: false });
});
it("fails closed on storage failures without disclosing database errors", () => {
  const failing = createVaultAccessService({ exec() { throw new Error("private storage path"); } }, vaultRoot, sessions);
  expect(() => failing.check(alice, read(a.id))).toThrow("Authorization unavailable");
});
