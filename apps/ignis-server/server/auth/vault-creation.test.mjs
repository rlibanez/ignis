import { beforeEach, afterEach, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { createRegisteredVault, quarantinePendingVaults, directoryAvailable } = require("./vault-creation");
let root, vaultRoot, db;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-create-vault-"));
  vaultRoot = path.join(root, "vaults"); fs.mkdirSync(vaultRoot);
  db = openDatabase(path.join(root, "data"));
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0),('normal','normal','user',0)");
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const create = (name = "Notes", options = {}) => createRegisteredVault(db, vaultRoot, "admin", name, { isCurrent: () => true, ...options });
it("creates one stable identity and owner, preserves registration on reopen and rejects duplicates", () => {
  const vault = create();
  expect(vault.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(fs.statSync(path.join(vault.path, ".obsidian")).isDirectory()).toBe(true);
  expect(db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id='admin'").get(vault.id).role).toBe("owner");
  expect(db.prepare("SELECT status FROM vaults WHERE id=?").get(vault.id).status).toBe("active");
  expect(() => create()).toThrow();
  db.close(); db = openDatabase(path.join(root, "data"));
  expect(db.prepare("SELECT id FROM vaults WHERE directory='Notes'").get().id).toBe(vault.id);
  expect(db.prepare("SELECT action FROM audit_events ORDER BY rowid").all().map(x => x.action)).toEqual(["begin-create-vault", "create-vault"]);
});
it.each(["", ".hidden", "../escape", "a/b", "a\\b", "con", " Notes", "Notes.", "N\0", "é".repeat(128)])("rejects invalid name %j before touching disk", name => {
  expect(() => create(name)).toThrow(); expect(fs.readdirSync(vaultRoot)).toEqual([]);
});
it("rejects missing authorization and forged ownership", () => {
  expect(() => createRegisteredVault(db, vaultRoot, "normal", "Notes", { isCurrent: () => true, ownerId:"admin" })).toThrow();
  expect(() => createRegisteredVault(db, vaultRoot, "admin", "Notes")).toThrow();
  expect(() => create("Notes", { isCurrent: () => false })).toThrow();
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it("never overwrites an existing directory or symlink", () => {
  fs.mkdirSync(path.join(vaultRoot, "Notes")); fs.writeFileSync(path.join(vaultRoot, "Notes", "keep"), "valuable");
  expect(() => create()).toThrow();
  fs.symlinkSync(path.join(vaultRoot, "Notes"), path.join(vaultRoot, "Alias"));
  expect(() => create("Alias")).toThrow();
  expect(fs.readFileSync(path.join(vaultRoot, "Notes", "keep"), "utf8")).toBe("valuable");
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it("removes only its empty directory on preparation failure", () => {
  const io = { ...fs, mkdirSync(location, options) {
    if (location.endsWith(".obsidian")) throw new Error("synthetic mkdir failure");
    return fs.mkdirSync(location, options);
  } };
  expect(() => create("Notes", { io })).toThrow();
  expect(fs.existsSync(path.join(vaultRoot, "Notes"))).toBe(false);
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it("revocation during preparation cannot activate a vault", () => {
  let current = true;
  const io = { ...fs, mkdirSync(location, options) { fs.mkdirSync(location, options); if (location.endsWith(".obsidian")) current = false; } };
  expect(() => create("Notes", { io, isCurrent: () => current })).toThrow();
  expect(fs.readdirSync(vaultRoot)).toEqual([]);
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it("quarantines unexpected content instead of recursively deleting it", () => {
  const io = { ...fs, mkdirSync(location, options) {
    fs.mkdirSync(location, options);
    if (location.endsWith(".obsidian")) { fs.writeFileSync(path.join(location, "keep"), "valuable"); throw new Error("failure"); }
  } };
  expect(() => create("Notes", { io })).toThrow();
  expect(db.prepare("SELECT status FROM vaults").get().status).toBe("quarantine");
  expect(directoryAvailable(db, "Notes")).toBe(false);
  expect(fs.readFileSync(path.join(vaultRoot, "Notes", ".obsidian", "keep"), "utf8")).toBe("valuable");
});
it("retains pending state if audit storage fails and recovers idempotently without deleting files", () => {
  db.exec("CREATE TRIGGER fail_final_audit BEFORE INSERT ON audit_events WHEN NEW.action='create-vault' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  expect(() => create()).toThrow();
  expect(db.prepare("SELECT count(*) n FROM vaults WHERE status='active'").get().n).toBe(0);
  db.exec("INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('interrupted','Interrupted','Interrupted','pending',0)");
  fs.mkdirSync(path.join(vaultRoot, "Interrupted")); fs.writeFileSync(path.join(vaultRoot, "Interrupted", "keep"), "saved");
  db.close(); db = openDatabase(path.join(root, "data"));
  expect(quarantinePendingVaults(db)).toBe(1); expect(quarantinePendingVaults(db)).toBe(0);
  expect(directoryAvailable(db, "Interrupted")).toBe(false);
  expect(fs.readFileSync(path.join(vaultRoot, "Interrupted", "keep"), "utf8")).toBe("saved");
});
it("serializes competing reservations across database connections", () => {
  const other = openDatabase(path.join(root, "data"));
  try {
    const io = { ...fs, mkdirSync(location, options) {
      if (location === path.join(vaultRoot, "Notes")) expect(() => createRegisteredVault(other, vaultRoot, "admin", "Notes", { isCurrent: () => true })).toThrow();
      return fs.mkdirSync(location, options);
    } };
    create("Notes", { io });
    expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(1);
  } finally { other.close(); }
});

it.each(["before-folder", "after-folder", "prepared"])("recovers a process interrupted at %s without publishing the vault", phase => {
  const { spawnSync } = require("node:child_process");
  const script = `
    const fs = require('node:fs');
    const { openDatabase } = require(process.argv[1]);
    const { createRegisteredVault } = require(process.argv[2]);
    const db = openDatabase(process.argv[3]);
    const root = process.argv[4], phase = process.argv[5];
    const io = { ...fs, mkdirSync(location, options) {
      const nested = location.endsWith('.obsidian');
      if (!nested && phase === 'before-folder') process.exit(17);
      fs.mkdirSync(location, options);
      if ((!nested && phase === 'after-folder') || (nested && phase === 'prepared')) process.exit(17);
    }};
    createRegisteredVault(db, root, 'admin', 'Interrupted', { isCurrent: () => true, io });
  `;
  const result = spawnSync(process.execPath, ["-e", script, require.resolve("./database"), require.resolve("./vault-creation"), path.join(root, "data"), vaultRoot, phase], { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(17);
  expect(directoryAvailable(db, "Interrupted")).toBe(false);
  expect(quarantinePendingVaults(db)).toBe(1);
  expect(db.prepare("SELECT status FROM vaults WHERE directory='Interrupted'").get().status).toBe("quarantine");
  expect(fs.existsSync(path.join(vaultRoot, "Interrupted"))).toBe(phase !== "before-folder");
});

it("assigns the creating administrator as owner and audit actor", () => {
  const vault = create("Owned");
  expect(db.prepare("SELECT user_id,role FROM memberships WHERE vault_id=?").all(vault.id)).toEqual([{ user_id: "admin", role: "owner" }]);
  expect(db.prepare("SELECT actor_id FROM audit_events WHERE action='create-vault'").get().actor_id).toBe("admin");
});
it.each([null, "", "missing", [], {}])("rejects invalid or unavailable owner %j before touching disk", ownerId => {
  expect(() => create("Owned", { ownerId })).toThrow();
  expect(fs.readdirSync(vaultRoot)).toEqual([]);
  expect(db.prepare("SELECT count(*) n FROM vaults").get().n).toBe(0);
});
it('lets a normal user create only their own stable registered vault',()=>{
 const v=createRegisteredVault(db,vaultRoot,'normal','Personal',{isCurrent:()=>true});
 expect(db.prepare('SELECT user_id,role FROM memberships WHERE vault_id=?').all(v.id)).toEqual([{user_id:'normal',role:'owner'}]);
 expect(db.prepare("SELECT actor_id FROM audit_events WHERE action='create-vault'").get().actor_id).toBe('normal');
 expect(fs.statSync(path.join(vaultRoot,'Personal','.obsidian')).isDirectory()).toBe(true);
 expect(()=>createRegisteredVault(db,vaultRoot,'normal','Personal',{isCurrent:()=>true})).toThrow();
});
it('revalidates normal user status and ownership before activation',()=>{
 const io={...fs,mkdirSync(location,options){fs.mkdirSync(location,options);if(location===path.join(vaultRoot,'Personal'))db.prepare("UPDATE users SET status='disabled' WHERE id='normal'").run();}};
 expect(()=>createRegisteredVault(db,vaultRoot,'normal','Personal',{isCurrent:()=>true,io})).toThrow();
 expect(fs.existsSync(path.join(vaultRoot,'Personal'))).toBe(false);expect(db.prepare('SELECT count(*) n FROM vaults').get().n).toBe(0);
});
it.each(['admin','normal'])('rejects assigning another owner even for %s',actor=>{
 expect(()=>createRegisteredVault(db,vaultRoot,actor,'Foreign',{isCurrent:()=>true,ownerId:actor==='admin'?'normal':'admin'})).toThrow();
 expect(fs.readdirSync(vaultRoot)).toEqual([]);expect(db.prepare('SELECT count(*) n FROM vaults').get().n).toBe(0);
});
