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
  expect(Object.keys(listUsers(db, "admin")[0]).sort()).toEqual(["id", "login", "role", "status"]);
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
