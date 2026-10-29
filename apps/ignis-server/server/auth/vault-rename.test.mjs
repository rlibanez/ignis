import { beforeEach, afterEach, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { createRegisteredVault, quarantinePendingVaults, directoryAvailable } = require("./vault-creation");
const { renameRegisteredVault } = require("./vault-rename");
let root, vaultRoot, db, vault;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-rename-"));
  vaultRoot = path.join(root, "vaults"); fs.mkdirSync(vaultRoot);
  db = openDatabase(path.join(root, "data"));
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0),('normal','normal','user',0)");
  vault = createRegisteredVault(db, vaultRoot, "admin", "Notes", { isCurrent: () => true });
  fs.writeFileSync(path.join(vault.path, "keep.md"), "valuable");
  db.prepare("INSERT INTO memberships VALUES (?,'normal','reader')").run(vault.id);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const rename = (name = "Renamed", options = {}) => renameRegisteredVault(db, vaultRoot, "admin", vault.id, name, {
  isCurrent: () => true, quiesce: async () => {}, invalidate: () => {}, ...options,
});
it("preserves UUID, owner, reader and contents across rename and reopen", async () => {
  const before = db.prepare("SELECT * FROM memberships ORDER BY user_id").all();
  const result = await rename();
  expect(result.id).toBe(vault.id);
  expect(fs.readFileSync(path.join(result.path, "keep.md"), "utf8")).toBe("valuable");
  expect(fs.existsSync(vault.path)).toBe(false);
  db.close(); db = openDatabase(path.join(root, "data"));
  expect(db.prepare("SELECT * FROM memberships ORDER BY user_id").all()).toEqual(before);
  expect(db.prepare("SELECT directory,status FROM vaults WHERE id=?").get(vault.id)).toEqual({ directory: "Renamed", status: "active" });
  expect(db.prepare("SELECT count(*) n FROM vault_renames").get().n).toBe(0);
});
it.each(["../escape", ".hidden", "x/y", "con", " trailing ", "x\0", "é".repeat(128)])("rejects invalid target %j without reserving or moving", async name => {
  await expect(rename(name)).rejects.toThrow();
  expect(db.prepare("SELECT status FROM vaults").get().status).toBe("active");
  expect(fs.existsSync(path.join(vault.path, "keep.md"))).toBe(true);
});
it("requires a current administrator even for a no-op", async () => {
  await expect(rename("Notes", { isCurrent: () => false })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  await expect(renameRegisteredVault(db, vaultRoot, "normal", vault.id, "Renamed", { isCurrent: () => true })).rejects.toThrow();
  expect((await rename("Notes")).id).toBe(vault.id);
});
it("rejects existing directories, dangling symlinks and another vault UUID", async () => {
  fs.mkdirSync(path.join(vaultRoot, "Exists"));
  await expect(rename("Exists")).rejects.toMatchObject({ code: "VAULT_EXISTS" });
  fs.symlinkSync(path.join(root, "missing"), path.join(vaultRoot, "Alias"));
  await expect(rename("Alias")).rejects.toMatchObject({ code: "VAULT_EXISTS" });
  const other = createRegisteredVault(db, vaultRoot, "admin", "Other", { isCurrent: () => true });
  await expect(rename(other.id)).rejects.toMatchObject({ code: "VAULT_EXISTS" });
});
it("reserves both names during shutdown, rejecting creation and concurrent rename", async () => {
  await rename("Renamed", { quiesce: async () => {
    expect(directoryAvailable(db, "Notes", vaultRoot)).toBe(false);
    expect(directoryAvailable(db, "Renamed", vaultRoot)).toBe(false);
    const second = openDatabase(path.join(root, "data"));
    try {
      expect(() => createRegisteredVault(second, vaultRoot, "admin", "Renamed", { isCurrent: () => true })).toThrow();
      await expect(renameRegisteredVault(second, vaultRoot, "admin", vault.id, "Other", { isCurrent: () => true })).rejects.toThrow();
    } finally { second.close(); }
  } });
});
it("rejects a replaced source without moving the replacement", async () => {
  await expect(rename("Renamed", { quiesce: async () => {
    fs.renameSync(vault.path, path.join(root, "saved"));
    fs.symlinkSync(path.join(root, "saved"), vault.path);
  } })).rejects.toMatchObject({ code: "VAULT_STATE_CHANGED" });
  expect(fs.readFileSync(path.join(root, "saved", "keep.md"), "utf8")).toBe("valuable");
});
it("quarantines after revocation during shutdown, without moving files", async () => {
  let current = true;
  await expect(rename("Renamed", { isCurrent: () => current, quiesce: async () => { current = false; } })).rejects.toThrow();
  expect(db.prepare("SELECT status FROM vaults").get().status).toBe("quarantine");
  expect(fs.existsSync(path.join(vault.path, "keep.md"))).toBe(true);
});
it("preserves both directories if the destination appears during shutdown", async () => {
  await expect(rename("Renamed", { quiesce: async () => { fs.mkdirSync(path.join(vaultRoot, "Renamed")); } })).rejects.toThrow();
  expect(fs.existsSync(path.join(vault.path, "keep.md"))).toBe(true);
  expect(fs.existsSync(path.join(vaultRoot, "Renamed"))).toBe(true);
});
it("keeps both aliases blocked after final audit failure", async () => {
  db.exec("CREATE TRIGGER fail_rename BEFORE INSERT ON audit_events WHEN NEW.action='rename-vault' BEGIN SELECT RAISE(ABORT, 'failure'); END");
  await expect(rename()).rejects.toThrow();
  expect(db.prepare("SELECT directory,status FROM vaults").get()).toEqual({ directory: "Notes", status: "quarantine" });
  expect(fs.readFileSync(path.join(vaultRoot, "Renamed", "keep.md"), "utf8")).toBe("valuable");
  fs.symlinkSync(path.join(vaultRoot, "Renamed"), path.join(vaultRoot, "Alias"));
  for (const name of ["Notes", "Renamed", "Alias"]) expect(directoryAvailable(db, name, vaultRoot)).toBe(false);
});
it.each(["reserved", "moved"])("recovers conservatively after a real process exit at %s", stage => {
  const script = `const {openDatabase}=require(${JSON.stringify(require.resolve("./database"))});
    const {renameRegisteredVault}=require(${JSON.stringify(require.resolve("./vault-rename"))});
    const db=openDatabase(${JSON.stringify(path.join(root, "data"))});
    renameRegisteredVault(db,${JSON.stringify(vaultRoot)},'admin',${JSON.stringify(vault.id)},'Renamed', {
      isCurrent:()=>true,quiesce:async()=>{if(${JSON.stringify(stage)}==='reserved')process.exit(17)},
      invalidate:()=>process.exit(17)
    }).catch(()=>process.exit(23));`;
  expect(spawnSync(process.execPath, ["-e", script]).status).toBe(17);
  db.close(); db = openDatabase(path.join(root, "data"));
  expect(quarantinePendingVaults(db)).toBe(1);
  expect(quarantinePendingVaults(db)).toBe(0);
  for (const name of ["Notes", "Renamed"]) expect(directoryAvailable(db, name, vaultRoot)).toBe(false);
  expect(fs.readFileSync(path.join(vaultRoot, stage === "moved" ? "Renamed" : "Notes", "keep.md"), "utf8")).toBe("valuable");
});

it("rejects legacy aliases before reserving, preserving the active vault", async () => {
  fs.symlinkSync(vault.path, path.join(vaultRoot, "Alias"));
  await expect(rename()).rejects.toMatchObject({ code: "VAULT_ALIAS" });
  expect(db.prepare("SELECT status FROM vaults").get().status).toBe("active");
  expect(db.prepare("SELECT count(*) n FROM vault_renames").get().n).toBe(0);
});
it.each(["fsync", "invalidate"])("quarantines rather than publishing after %s failure", async stage => {
  const options = stage === "fsync" ? { io: { ...fs, fsyncSync() { throw new Error("disk failure"); } } }
    : { invalidate() { throw new Error("cache failure"); } };
  await expect(rename("Renamed", options)).rejects.toThrow();
  expect(db.prepare("SELECT status FROM vaults").get().status).toBe("quarantine");
  expect(directoryAvailable(db, "Renamed", vaultRoot)).toBe(false);
  expect(fs.readFileSync(path.join(vaultRoot, "Renamed", "keep.md"), "utf8")).toBe("valuable");
});
it("does not reserve a vault whose plugin readiness check fails", async () => {
  await expect(rename("Renamed", { assertReady() { throw new Error("plugin enabled"); } })).rejects.toThrow();
  expect(db.prepare("SELECT status FROM vaults").get().status).toBe("active");
});
