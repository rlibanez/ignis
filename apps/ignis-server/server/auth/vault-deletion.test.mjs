import { beforeEach, afterEach, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { createRegisteredVault, quarantinePendingVaults, directoryAvailable } = require("./vault-creation");
const { deleteRegisteredVault, purgeRetiredVault, purgeRetiredVaults } = require("./vault-deletion");
let root, vaultRoot, db, vault;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-delete-"));
  vaultRoot = path.join(root, "vaults"); fs.mkdirSync(vaultRoot);
  db = openDatabase(path.join(root, "data"));
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0),('normal','normal','user',0)");
  vault = createRegisteredVault(db, vaultRoot, "admin", "Notes", { isCurrent: () => true });
  fs.writeFileSync(path.join(vault.path, "keep.md"), "valuable");
  db.prepare("INSERT INTO memberships VALUES (?,'normal','reader')").run(vault.id);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const remove = (options = {}) => deleteRegisteredVault(db, vaultRoot, "admin", vault.id, {
  isCurrent: () => true, quiesce: async () => {}, invalidate: () => {}, ...options,
});
const record = () => db.prepare("SELECT * FROM vault_deletions WHERE vault_id=?").get(vault.id);
const trashPath = () => path.join(vaultRoot, ".ignis-trash", record().trash_name);
const failPurge = { ...fs, promises: { ...fs.promises, async rm() { throw new Error("busy"); } } };

it("retires the identity, removes memberships and purges only that vault", async () => {
  const other = createRegisteredVault(db, vaultRoot, "admin", "Other", { isCurrent: () => true });
  expect(await remove()).toMatchObject({ id: vault.id, cleanupPending: false });
  expect(db.prepare("SELECT 1 FROM vaults WHERE id=?").get(vault.id)).toBeUndefined();
  expect(db.prepare("SELECT count(*) n FROM memberships WHERE vault_id=?").get(vault.id).n).toBe(0);
  expect(record().state).toBe("purged");
  expect(fs.existsSync(vault.path)).toBe(false);
  expect(fs.existsSync(trashPath())).toBe(false);
  expect(fs.existsSync(other.path)).toBe(true);
  expect((await purgeRetiredVault(db, vaultRoot, vault.id))).toBe(false);
});
it("allows the old name with a new UUID and no inherited reader, never reuses the retired UUID", async () => {
  await remove();
  const replacement = createRegisteredVault(db, vaultRoot, "admin", "Notes", { isCurrent: () => true });
  expect(replacement.id).not.toBe(vault.id);
  expect(db.prepare("SELECT user_id,role FROM memberships WHERE vault_id=?").all(replacement.id)).toEqual([{ user_id: "admin", role: "owner" }]);
  await expect(remove()).rejects.toThrow();
  expect(fs.existsSync(replacement.path)).toBe(true);
  expect(() => createRegisteredVault(db, vaultRoot, "admin", vault.id, { isCurrent: () => true })).toThrow();
});
it("requires the stable UUID, a current administrator and lifecycle callbacks", async () => {
  await expect(deleteRegisteredVault(db, vaultRoot, "admin", "Notes", { isCurrent: () => true })).rejects.toMatchObject({ code: "VAULT_ID_REQUIRED" });
  await expect(deleteRegisteredVault(db, vaultRoot, "normal", vault.id, { isCurrent: () => true })).rejects.toThrow();
  await expect(remove({ isCurrent: () => false })).rejects.toThrow();
  await expect(remove({ quiesce: undefined })).rejects.toThrow();
  expect(fs.existsSync(path.join(vault.path, "keep.md"))).toBe(true);
  expect(record()).toBeUndefined();
});
it("rejects symlink aliases and plugin activity without reserving", async () => {
  await expect(remove({ assertReady() { throw new Error("plugin busy"); } })).rejects.toThrow();
  fs.symlinkSync(vault.path, path.join(vaultRoot, "Alias"));
  await expect(remove()).rejects.toMatchObject({ code: "VAULT_ALIAS" });
  expect(record()).toBeUndefined();
});
it("hides pending deletion and rejects concurrent creation or deletion", async () => {
  await remove({ quiesce: async () => {
    expect(directoryAvailable(db, "Notes", vaultRoot)).toBe(false);
    const second = openDatabase(path.join(root, "data"));
    try {
      expect(() => createRegisteredVault(second, vaultRoot, "admin", "Notes", { isCurrent: () => true })).toThrow();
      await expect(deleteRegisteredVault(second, vaultRoot, "admin", vault.id, { isCurrent: () => true })).rejects.toThrow();
    } finally { second.close(); }
  } });
});
it("revocation during shutdown leaves files untouched and quarantined", async () => {
  let current = true;
  await expect(remove({ isCurrent: () => current, quiesce: async () => { current = false; } })).rejects.toThrow();
  expect(fs.readFileSync(path.join(vault.path, "keep.md"), "utf8")).toBe("valuable");
  expect(record().state).toBe("pending");
  expect(await purgeRetiredVault(db, vaultRoot, vault.id)).toBe(false);
});
it("rejects source replacement after waiting", async () => {
  await expect(remove({ quiesce: async () => {
    fs.renameSync(vault.path, path.join(root, "saved"));
    fs.mkdirSync(vault.path);
  } })).rejects.toThrow();
  expect(fs.existsSync(vault.path)).toBe(true);
  expect(fs.readFileSync(path.join(root, "saved", "keep.md"), "utf8")).toBe("valuable");
});
it("never follows a symlink for the internal staging directory", async () => {
  fs.mkdirSync(path.join(root, "outside"));
  fs.symlinkSync(path.join(root, "outside"), path.join(vaultRoot, ".ignis-trash"));
  await expect(remove()).rejects.toThrow();
  expect(fs.readdirSync(path.join(root, "outside"))).toEqual([]);
  expect(fs.existsSync(path.join(vault.path, "keep.md"))).toBe(true);
});
it.each(["fsync", "invalidate", "audit"])("preserves staged contents on %s failure before retirement", async stage => {
  if (stage === "audit") db.exec("CREATE TRIGGER fail_delete BEFORE INSERT ON audit_events WHEN NEW.action='delete-vault' BEGIN SELECT RAISE(ABORT, 'failure'); END");
  const options = stage === "fsync" ? { io: { ...fs, fsyncSync() { throw new Error("disk failure"); } } }
    : stage === "invalidate" ? { invalidate() { throw new Error("cache failure"); } } : {};
  await expect(remove(options)).rejects.toThrow();
  expect(record().state).toBe("pending");
  expect(db.prepare("SELECT status FROM vaults WHERE id=?").get(vault.id).status).toBe("quarantine");
  expect(fs.readFileSync(path.join(trashPath(), "keep.md"), "utf8")).toBe("valuable");
  expect(await purgeRetiredVault(db, vaultRoot, vault.id)).toBe(false);
});
it("keeps failed cleanup hidden and retries only the retired directory on reopen", async () => {
  expect((await remove({ io: failPurge })).cleanupPending).toBe(true);
  expect(record().state).toBe("retired");
  fs.symlinkSync(trashPath(), path.join(vaultRoot, "Alias"));
  fs.symlinkSync(vaultRoot, path.join(vaultRoot, "RootAlias"));
  for (const name of [".ignis-trash", "Alias", "RootAlias"]) expect(directoryAvailable(db, name, vaultRoot)).toBe(false);
  const replacement = createRegisteredVault(db, vaultRoot, "admin", "Notes", { isCurrent: () => true });
  db.close(); db = openDatabase(path.join(root, "data"));
  await purgeRetiredVaults(db, vaultRoot);
  expect(record().state).toBe("purged");
  expect(fs.existsSync(replacement.path)).toBe(true);
});
it.each(["directory", "symlink"])("never purges a replacement %s", async kind => {
  await remove({ io: failPurge });
  const target = trashPath();
  fs.renameSync(target, path.join(root, "saved"));
  if (kind === "directory") fs.mkdirSync(target);
  else fs.symlinkSync(path.join(root, "saved"), target);
  expect(await purgeRetiredVault(db, vaultRoot, vault.id)).toBe(false);
  expect(fs.lstatSync(target)).toBeDefined();
  expect(fs.readFileSync(path.join(root, "saved", "keep.md"), "utf8")).toBe("valuable");
});
it("does not follow symlinks contained inside the vault during purge", async () => {
  const outside = path.join(root, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "external");
  fs.symlinkSync(outside, path.join(vault.path, "link"));
  await remove();
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("external");
});
it.each(["reserved", "moved", "retired", "removed"])("recovers after a real process exit at %s", async stage => {
  const script = `const fs=require('node:fs');
    const {openDatabase}=require(${JSON.stringify(require.resolve("./database"))});
    const {deleteRegisteredVault}=require(${JSON.stringify(require.resolve("./vault-deletion"))});
    const db=openDatabase(${JSON.stringify(path.join(root, "data"))});
    const stage=${JSON.stringify(stage)};
    deleteRegisteredVault(db,${JSON.stringify(vaultRoot)},'admin',${JSON.stringify(vault.id)}, {
      isCurrent:()=>true,quiesce:async()=>{if(stage==='reserved')process.exit(17)},
      invalidate:()=>{if(stage==='moved')process.exit(17)},
      io:{...fs,promises:{...fs.promises,async rm(target,options){if(stage==='retired')process.exit(17);await fs.promises.rm(target,options);process.exit(17)}}}
    }).catch(()=>process.exit(23));`;
  expect(spawnSync(process.execPath, ["-e", script]).status).toBe(17);
  db.close(); db = openDatabase(path.join(root, "data"));
  quarantinePendingVaults(db);
  await purgeRetiredVaults(db, vaultRoot);
  if (["reserved", "moved"].includes(stage)) {
    expect(record().state).toBe("pending");
    expect(directoryAvailable(db, "Notes", vaultRoot)).toBe(false);
    expect(fs.readFileSync(path.join(stage === "reserved" ? vault.path : trashPath(), "keep.md"), "utf8")).toBe("valuable");
  } else {
    expect(record().state).toBe("purged");
    expect(fs.existsSync(trashPath())).toBe(false);
  }
});
