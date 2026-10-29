import { beforeEach, afterEach, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { registrationOptions, registerExistingVault, inspectDirectory } = require("./vault-registration");
const { registerVault } = require("./store");
let root, vaultRoot, db;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-register-"));
  vaultRoot = path.join(root, "vaults"); fs.mkdirSync(vaultRoot);
  fs.mkdirSync(path.join(vaultRoot, "Notes"));
  fs.writeFileSync(path.join(vaultRoot, "Notes", "note.md"), "original");
  db = openDatabase(path.join(root, "data"));
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0),('normal','normal','user',0),('disabled','disabled','user',0)");
  db.exec("UPDATE users SET status='disabled' WHERE id='disabled'");
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const options = () => ({ actorId: "admin", isCurrent: () => true, expectedIdentity: inspectDirectory(vaultRoot, "Notes").identity });
const register = (overrides = {}) => registerExistingVault(db, vaultRoot, "Notes", "normal", { ...options(), ...overrides });

it("inspects without registering, excludes hidden content and disabled owners", () => {
  fs.mkdirSync(path.join(vaultRoot, ".ignis-trash"));
  const result = registrationOptions(db, vaultRoot);
  expect(result.vaults).toEqual([{ directory: "Notes", identity: options().expectedIdentity, eligible: true }]);
  expect(result.owners).toEqual([{ id: "admin", login: "admin" }, { id: "normal", login: "normal" }]);
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it("registers a stable identity and explicit normal-user owner without modifying files or creating .obsidian", () => {
  const location = path.join(vaultRoot, "Notes");
  const before = fs.statSync(location);
  const vault = register();
  expect(vault.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(fs.readdirSync(location)).toEqual(["note.md"]);
  expect(fs.readFileSync(path.join(location, "note.md"), "utf8")).toBe("original");
  const after = fs.statSync(location);
  expect([after.ino, after.mtimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.mode]);
  expect(db.prepare("SELECT user_id,role FROM memberships WHERE vault_id=?").all(vault.id)).toEqual([{ user_id: "normal", role: "owner" }]);
  expect(db.prepare("SELECT actor_id,action FROM audit_events").get()).toEqual({ actor_id: "admin", action: "register-vault" });
  db.close(); db = openDatabase(path.join(root, "data"));
  expect(db.prepare("SELECT id FROM vaults WHERE directory='Notes'").get().id).toBe(vault.id);
  expect(registrationOptions(db, vaultRoot).vaults).toEqual([]);
});
it.each(["", "../Notes", "a/b", ".hidden", ".ignis-trash", "N\0", "con", "trailing."])("rejects invalid directory %j", directory => {
  expect(() => registerExistingVault(db, vaultRoot, directory, "normal")).toThrow();
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it("requires active administrator/session and an explicit valid snapshot for HTTP calls", () => {
  for (const overrides of [{ actorId: "normal" }, { isCurrent: undefined }, { isCurrent: () => false }, { expectedIdentity: undefined }, { expectedIdentity: "wrong" }]) {
    expect(() => register(overrides)).toThrow();
  }
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it("rejects a disabled or missing owner, including one disabled after inspection", () => {
  const snapshot = options();
  db.exec("UPDATE users SET status='disabled' WHERE id='normal'");
  for (const id of ["normal", "disabled", "missing", null]) {
    expect(() => registerExistingVault(db, vaultRoot, "Notes", id, snapshot)).toThrow(/active/);
  }
});
it("rejects a replaced directory but allows ordinary note edits after inspection", () => {
  const selected = options();
  fs.renameSync(path.join(vaultRoot, "Notes"), path.join(root, "saved"));
  fs.mkdirSync(path.join(vaultRoot, "Notes"));
  expect(() => registerExistingVault(db, vaultRoot, "Notes", "normal", selected)).toThrow(/changed/);
  const updated = options();
  fs.writeFileSync(path.join(vaultRoot, "Notes", "new.md"), "new");
  expect(registerExistingVault(db, vaultRoot, "Notes", "normal", updated).id).toBeTruthy();
  expect(fs.readFileSync(path.join(root, "saved", "note.md"), "utf8")).toBe("original");
});
it("rejects a linked root, linked vault and overlapping aliases", () => {
  fs.symlinkSync(vaultRoot, path.join(root, "linked-root"));
  expect(() => registrationOptions(db, path.join(root, "linked-root"))).toThrow();
  expect(() => registerExistingVault(db, path.join(root, "linked-root"), "Notes", "normal")).toThrow();
  fs.symlinkSync(path.join(vaultRoot, "Notes"), path.join(vaultRoot, "Alias"));
  expect(() => register()).toThrow();
  expect(() => registerExistingVault(db, vaultRoot, "Alias", "normal")).toThrow(/real directory/);
  expect(registrationOptions(db, vaultRoot).vaults.every(vault => !vault.eligible)).toBe(true);
});
it("preserves original ownership on duplicate registration and keeps CLI behavior explicit", () => {
  const vault = registerVault(db, vaultRoot, "Notes", "normal");
  expect(() => registerVault(db, vaultRoot, "Notes", "admin")).toThrow();
  expect(db.prepare("SELECT user_id FROM memberships WHERE vault_id=?").get(vault.id).user_id).toBe("normal");
  expect(db.prepare("SELECT actor_id,action FROM audit_events").get()).toEqual({ actor_id: null, action: "register-vault-local" });
});
it("rejects directories reserved by a pending rename and retired identities", () => {
  db.exec("INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('pending','Old','Old','pending',0)");
  db.exec("INSERT INTO vault_renames VALUES ('pending','Old','Notes',0)");
  expect(() => register()).toThrow();
  db.exec("DELETE FROM vault_renames");
  db.exec("INSERT INTO vault_deletions VALUES ('Notes','Old','trash','1','1','purged',0)");
  expect(() => register()).toThrow();
});
it("rolls back identity and owner when audit fails", () => {
  db.exec("CREATE TRIGGER fail_register BEFORE INSERT ON audit_events WHEN NEW.action='register-vault' BEGIN SELECT RAISE(ABORT, 'failure'); END");
  expect(() => register()).toThrow();
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM memberships").get().n).toBe(0);
  expect(fs.readFileSync(path.join(vaultRoot, "Notes", "note.md"), "utf8")).toBe("original");
});
it("registers an automatically created My Vault only with an explicitly selected owner", () => {
  const configId = require.resolve("../config");
  const old = { VAULT_ROOT: process.env.VAULT_ROOT, DATA_ROOT: process.env.DATA_ROOT, AUTO_CREATE_DEFAULT: process.env.AUTO_CREATE_DEFAULT };
  fs.rmSync(path.join(vaultRoot, "Notes"), { recursive: true });
  try {
    process.env.VAULT_ROOT = vaultRoot; process.env.DATA_ROOT = path.join(root, "data"); process.env.AUTO_CREATE_DEFAULT = "true";
    delete require.cache[configId]; require("../config");
    expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
    expect(registrationOptions(db, vaultRoot).vaults[0].directory).toBe("My Vault");
    const vault = registerVault(db, vaultRoot, "My Vault", "normal");
    expect(db.prepare("SELECT user_id FROM memberships WHERE vault_id=?").get(vault.id).user_id).toBe("normal");
  } finally {
    delete require.cache[configId];
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
it("two concurrent processes cannot register different owners for the same directory", async () => {
  const run = owner => new Promise((resolve, reject) => {
    const script = `const {openDatabase}=require(${JSON.stringify(require.resolve("./database"))});
      const {registerExistingVault}=require(${JSON.stringify(require.resolve("./vault-registration"))});
      const db=openDatabase(${JSON.stringify(path.join(root, "data"))});
      try {registerExistingVault(db,${JSON.stringify(vaultRoot)},'Notes',${JSON.stringify(owner)});process.exit(0)}catch{process.exit(3)}`;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    child.on("error", reject); child.on("exit", resolve);
  });
  expect((await Promise.all([run("admin"), run("normal")])).sort()).toEqual([0, 3]);
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(1);
  expect(db.prepare("SELECT count(*) n FROM memberships").get().n).toBe(1);
});
it("process exit inside registration leaves no partial identity or owner", () => {
  const script = `const {openDatabase}=require(${JSON.stringify(require.resolve("./database"))});
    const {registerExistingVault}=require(${JSON.stringify(require.resolve("./vault-registration"))});
    const db=openDatabase(${JSON.stringify(path.join(root, "data"))});
    db.function('crash',()=>process.exit(17));
    db.exec("CREATE TEMP TRIGGER crash_register BEFORE INSERT ON audit_events BEGIN SELECT crash(); END");
    registerExistingVault(db,${JSON.stringify(vaultRoot)},'Notes','normal');`;
  expect(spawnSync(process.execPath, ["-e", script]).status).toBe(17);
  db.close(); db = openDatabase(path.join(root, "data"));
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM memberships").get().n).toBe(0);
  expect(fs.readFileSync(path.join(vaultRoot, "Notes", "note.md"), "utf8")).toBe("original");
});
