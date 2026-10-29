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
const { createVaultPreferencesService } = require("./vault-preferences");
const password = "synthetic preference test passphrase";
let hash, root, vaultRoot, db, sessions, preferences, vault, alice, bob, admin;
beforeAll(async () => { hash = await hashPassword(password); });
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-preferences-"));
  vaultRoot = path.join(root, "vaults"); fs.mkdirSync(path.join(vaultRoot, "Notes", ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "Notes", ".obsidian", "app.json"), '{"sharedSecret":"must not inherit"}');
  db = openDatabase(path.join(root, "data"));
  for (const id of ["admin", "alice", "bob"]) {
    db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)").run(id,id,id === "admin" ? "admin" : "user");
    db.prepare("INSERT INTO local_credentials VALUES (?,?,0)").run(id,hash);
  }
  vault = registerVault(db, vaultRoot, "Notes", "admin");
  for (const id of ["alice", "bob"]) db.prepare("INSERT INTO memberships VALUES (?,?,'reader')").run(vault.id,id);
  sessions = createSessionService(db);
  alice = (await sessions.loginLocal("alice", password)).token;
  bob = (await sessions.loginLocal("bob", password)).token;
  admin = (await sessions.loginLocal("admin", password)).token;
  preferences = createVaultPreferencesService(db,vaultRoot,sessions);
});
afterEach(() => { db.close(); fs.rmSync(root,{ recursive:true,force:true }); });
const target = () => ({ reference: vault.id, path: ".obsidian/app.json" });
const save = (token, content, revision = 0, extra = {}) => preferences.write(token,{ ...target(), content, expectedRevision: revision, ...extra });
it("isolates each user's settings, including admin, without importing shared files", () => {
  expect(preferences.read(alice,target())).toEqual({content:"{}",revision:0});
  expect(save(alice,'{"fontSize":17}')).toEqual({revision:1});
  expect(preferences.read(bob,{...target(),userId:"alice"})).toEqual({content:"{}",revision:0});
  expect(preferences.read(admin,{...target(),userId:"alice"})).toEqual({content:"{}",revision:0});
  expect(preferences.read(alice,target()).content).toBe('{"fontSize":17}');
  expect(fs.readFileSync(path.join(vaultRoot,"Notes",".obsidian","app.json"),"utf8")).toContain("sharedSecret");
});
it("rejects stale saves without overwriting a newer tab", () => {
  save(alice,'{"value":1}');
  expect(() => save(alice,'{"value":2}')).toThrow(expect.objectContaining({code:"PREFERENCES_CONFLICT"}));
  expect(save(alice,'{"value":3}',1)).toEqual({revision:2});
  expect(preferences.read(alice,target())).toEqual({content:'{"value":3}',revision:2});
});
it("revokes preference access with membership/session and does not grant access to other vaults", () => {
  save(alice,"{}");
  db.prepare("DELETE FROM memberships WHERE user_id='alice'").run();
  expect(() => preferences.read(alice,target())).toThrow();
  expect(() => save(alice,"{}",1)).toThrow();
  sessions.revokeUser("bob");
  expect(() => preferences.read(bob,target())).toThrow();
  fs.mkdirSync(path.join(vaultRoot,"Other"));
  const other = registerVault(db,vaultRoot,"Other","admin");
  expect(() => preferences.read(alice,{...target(),reference:other.id})).toThrow();
});
it("retains preferences across rename and deletes them with their vault identity", () => {
  save(alice,'{"value":1}');
  fs.renameSync(path.join(vaultRoot,"Notes"),path.join(vaultRoot,"Renamed"));
  db.prepare("UPDATE vaults SET directory='Renamed',name='Renamed' WHERE id=?").run(vault.id);
  expect(preferences.read(alice,target()).revision).toBe(1);
  db.prepare("DELETE FROM vaults WHERE id=?").run(vault.id);
  expect(db.prepare("SELECT count(*) n FROM vault_preferences").get().n).toBe(0);
  expect(() => preferences.read(alice,target())).toThrow();
  const replacement = registerVault(db,vaultRoot,"Renamed","admin");
  expect(preferences.read(admin,{...target(),reference:replacement.id})).toEqual({content:"{}",revision:0});
});
it("rejects executable/configuration paths, invalid JSON, dangerous keys and oversized payloads", () => {
  for (const file of [".obsidian/plugins/p/data.json",".obsidian/core-plugins.json",".obsidian/community-plugins.json",".obsidian/../app.json",".OBSIDIAN/app.json",".obsidian/workspace../x.json"])
    expect(() => save(alice,"{}",0,{path:file})).toThrow();
  for (const content of ["[]","null","broken",'{"__proto__":{}}','{"a":{"constructor":{}}}',JSON.stringify({text:"x".repeat(1048576)})])
    expect(() => save(alice,content)).toThrow();
  expect(db.prepare("SELECT count(*) n FROM vault_preferences").get().n).toBe(0);
});
it("enforces per-user quotas and cascades on user deletion", () => {
  for (let i=0;i<40;i++) save(alice,"{}",0,{path:`.obsidian/workspace.w${i}.json`});
  expect(() => save(alice,"{}")).toThrow(expect.objectContaining({code:"PREFERENCES_QUOTA"}));
  expect(save(bob,"{}")).toEqual({revision:1});
  db.prepare("DELETE FROM users WHERE id='alice'").run();
  expect(db.prepare("SELECT count(*) n FROM vault_preferences").get().n).toBe(1);
});
it("migrates a version-9 database and persists preferences after reopening", () => {
  db.exec("DROP TABLE vault_preferences; DELETE FROM schema_migrations WHERE version=10");
  db.close(); db = openDatabase(path.join(root,"data"));
  sessions = createSessionService(db);
  preferences = createVaultPreferencesService(db,vaultRoot,sessions);
  expect(db.prepare("SELECT max(version) v FROM schema_migrations").get().v).toBe(10);
  save(alice,'{"value":42}');
  db.close(); db = openDatabase(path.join(root,"data"));
  preferences = createVaultPreferencesService(db,vaultRoot,createSessionService(db));
  expect(preferences.read(alice,target())).toEqual({content:'{"value":42}',revision:1});
});
it("limits total bytes and nested JSON without affecting another user", () => {
  const content = JSON.stringify({text:"x".repeat(1024*1024-20)});
  for (let i=0;i<4;i++) save(alice,content,0,{path:`.obsidian/workspace.b${i}.json`});
  expect(() => save(alice,content)).toThrow(expect.objectContaining({code:"PREFERENCES_QUOTA"}));
  let deep = {};
  for (let i=0;i<40;i++) deep = { child:deep };
  expect(() => save(bob,JSON.stringify(deep))).toThrow(expect.objectContaining({code:"INVALID_PREFERENCES"}));
  expect(save(bob,'{"value":1}')).toEqual({revision:1});
});
it("projects private configuration without serving shared code, paths or arbitrary stored fields", () => {
  const config = require("./vault-config").createVaultConfigService(db,vaultRoot,sessions);
  save(alice,'{"spellcheck":true,"secret":"private","attachmentFolderPath":"hidden"}');
  expect(JSON.parse(config.read(alice,target()).content)).toEqual({spellcheck:true});
  expect(JSON.parse(config.read(bob,target()).content)).toEqual({});
  const plugins = {reference:vault.id,path:".obsidian/community-plugins.json"};
  expect(config.read(alice,plugins)).toEqual({content:"[]",revision:0,writable:false});
  expect(() => config.write(alice,{...plugins,content:'["evil"]',expectedRevision:0})).toThrow();
  config.write(alice,{...target(),content:'{"spellcheck":false,"token":"discard"}',expectedRevision:1});
  expect(preferences.read(alice,target()).content).toBe('{"spellcheck":false}');
  expect(() => config.write(alice,{...target(),content:'{}',expectedRevision:1})).toThrow(expect.objectContaining({code:"PREFERENCES_CONFLICT"}));
  db.prepare("DELETE FROM memberships WHERE user_id='alice'").run();
  expect(() => config.read(alice,plugins)).toThrow();
});

it("creates isolated bootstrap snapshots with no shared configuration or cross-request references", () => {
  const service = require("./vault-config").createVaultConfigService(db,vaultRoot,sessions);
  save(alice,'{"spellcheck":true,"secret":"hidden"}');
  const first = service.snapshot(alice,vault.id);
  expect(Object.keys(first)).toHaveLength(5);
  expect(first[".obsidian/app.json"].content).toBe('{"spellcheck":true}');
  first[".obsidian/app.json"].content = "tampered";
  expect(service.snapshot(alice,vault.id)[".obsidian/app.json"].content).toBe('{"spellcheck":true}');
  expect(service.snapshot(bob,vault.id)[".obsidian/app.json"].content).toBe('{}');
  sessions.revokeUser("alice");
  expect(() => service.snapshot(alice,vault.id)).toThrow();
});
it("explicitly disables bundled default-on plugins outside the reviewed minimal set",()=>{
  const config = require("./vault-config").createVaultConfigService(db,vaultRoot,sessions);
  const value = JSON.parse(config.read(alice,{reference:vault.id,path:".obsidian/core-plugins.json"}).content);
  expect(Object.entries(value).filter(([,enabled])=>enabled).map(([id])=>id).sort()).toEqual(["file-explorer","global-search","switcher"]);
  for (const id of ["canvas","bases","bookmarks","daily-notes","templates","file-recovery","sync","publish","webviewer"])
    expect(value[id]).toBe(false);
});
it("persists projected workspace per user and rejects stale layout saves",()=>{
 const config=require("./vault-config").createVaultConfigService(db,vaultRoot,sessions);
 const target={reference:vault.id,path:".obsidian/workspace.json"};
 expect(config.read(alice,target).revision).toBe(0);
 const content=JSON.stringify({main:{id:"note",type:"leaf",state:{type:"markdown",state:{file:"Welcome.md",html:"discard"}}},active:"note"});
 config.write(alice,{...target,content,expectedRevision:0});
 expect(config.read(alice,target).content).not.toContain("discard");
 expect(config.read(bob,target).content).toBe("{}");
 expect(()=>config.write(alice,{...target,content,expectedRevision:0})).toThrow(expect.objectContaining({code:"PREFERENCES_CONFLICT"}));
});
