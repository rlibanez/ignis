import { beforeEach, afterEach, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { registerVault } = require("./store");
const { resolveRegisteredVault, listRegisteredVaults } = require("./vault-catalog");
const { selectVaultReference } = require("./vault-selection");
let root, vaultRoot, db, registered;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-catalog-"));
  vaultRoot = path.join(root, "vaults"); fs.mkdirSync(vaultRoot);
  fs.mkdirSync(path.join(vaultRoot, "Notes"));
  db = openDatabase(path.join(root, "data"));
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0)");
  registered = registerVault(db, vaultRoot, "Notes", "admin");
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
it("resolves UUID and directory alias to one stable registered identity after reopening", () => {
  const byId = resolveRegisteredVault(db, vaultRoot, registered.id);
  expect(resolveRegisteredVault(db, vaultRoot, "Notes")).toEqual(byId);
  expect(Object.isFrozen(byId)).toBe(true);
  db.close(); db = openDatabase(path.join(root, "data"));
  expect(resolveRegisteredVault(db, vaultRoot, "Notes").id).toBe(registered.id);
  expect(listRegisteredVaults(db)).toEqual([{ id: registered.id, name: "Notes", directory: "Notes", status: "active" }]);
});
it("does not discover or authorize unregistered directories", () => {
  fs.mkdirSync(path.join(vaultRoot, "Private"));
  expect(() => resolveRegisteredVault(db, vaultRoot, "Private")).toThrow();
  expect(listRegisteredVaults(db)).toHaveLength(1);
  expect(db.prepare("SELECT count(*) n FROM memberships").get().n).toBe(1);
});
it.each(["pending", "quarantine"])("rejects %s vaults even through their aliases", status => {
  db.prepare("UPDATE vaults SET status=?").run(status);
  for (const reference of [registered.id, "Notes"]) expect(() => resolveRegisteredVault(db, vaultRoot, reference)).toThrow();
});
it("rejects missing paths, symlinks and corrupt directory traversal entries", () => {
  fs.rmdirSync(path.join(vaultRoot, "Notes"));
  expect(() => resolveRegisteredVault(db, vaultRoot, registered.id)).toThrow();
  fs.mkdirSync(path.join(root, "outside")); fs.symlinkSync(path.join(root, "outside"), path.join(vaultRoot, "Notes"));
  expect(() => resolveRegisteredVault(db, vaultRoot, registered.id)).toThrow();
  db.prepare("UPDATE vaults SET directory='../outside'").run();
  expect(() => resolveRegisteredVault(db, vaultRoot, registered.id)).toThrow();
});
it("rejects root symlinks and ID/alias collisions, including preexisting inconsistent records", () => {
  const alias = path.join(root, "linked-root"); fs.symlinkSync(vaultRoot, alias);
  expect(() => resolveRegisteredVault(db, alias, registered.id)).toThrow();
  fs.mkdirSync(path.join(vaultRoot, registered.id));
  expect(() => registerVault(db, vaultRoot, registered.id, "admin")).toThrow("registered or reserved");
  db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('other','Other',?,'active',0)").run(registered.id);
  expect(() => resolveRegisteredVault(db, vaultRoot, registered.id)).toThrow();
});
it("selects no default unless explicitly requested and accepts equivalent UUID/alias references", () => {
  expect(selectVaultReference({}, {})).toBeNull();
  expect(selectVaultReference({}, {}, { defaultVault: "Notes" })).toBe("Notes");
  const resolveIdentity = reference => resolveRegisteredVault(db, vaultRoot, reference).id;
  expect(selectVaultReference({ vault: "Notes" }, { vault: registered.id }, { resolveIdentity })).toBe(registered.id);
  expect(() => selectVaultReference({ vault: "Notes" }, { vault: "Other" })).toThrow();
});
it.each(["", null, [], ["Notes", "Notes"], {}, 7, "../Notes", "Notes/child", "Notes\\child", "Notes\0", ".", ".."])("rejects invalid selector %j instead of falling back to a default", value => {
  expect(() => selectVaultReference({ vault: value }, {}, { defaultVault: "Notes" })).toThrow();
  expect(() => selectVaultReference({}, { vault: value })).toThrow();
});

it("normalizes HTTP UUID/alias selectors without changing legacy names or choosing a default", () => {
  const { resolveVaultRequest } = require("./vault-request");
  expect(resolveVaultRequest(db, vaultRoot, { vault: registered.id }, { vault: "Notes" })).toBe("Notes");
  expect(resolveVaultRequest(db, vaultRoot, { vault: "Legacy" }, null)).toBe("Legacy");
  expect(resolveVaultRequest(db, vaultRoot, {}, {})).toBeNull();
  expect(() => resolveVaultRequest(db, vaultRoot, { vault: registered.id }, { vault: "Legacy" })).toThrow();
  db.prepare("UPDATE vaults SET status='quarantine'").run();
  expect(() => resolveVaultRequest(db, vaultRoot, { vault: registered.id }, null)).toThrow();
  expect(() => resolveVaultRequest(db, vaultRoot, { vault: "Notes" }, null)).toThrow();
});
