import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { classifyVaultPath, vaultCapabilityAllowed: allowed } = require("../features/vaults/application/vault-policy.js");
const principal = { status: "active", instanceRole: "user" };

it.each(["reader", "editor", "owner"])("allows ordinary reads for %s without granting administrative capabilities", membership => {
  const context = { ...principal, membership };
  expect(allowed({ ...context, capability: "content.read", path: "Notes/Hello.md" })).toBe(true);
  expect(allowed({ ...context, capability: "content.write", path: "Images/photo.png" })).toBe(membership !== "reader");
  for (const capability of ["users.manage", "instance.configure", "audit.read", "plugins.manage", "sync.manage"])
    expect(allowed({ ...context, capability })).toBe(false);
  for (const capability of ["members.manage", "ownership.transfer", "vault.rename", "vault.delete", "vault.refresh"])
    expect(allowed({ ...context, capability })).toBe(membership === "owner");
});
it.each(["Nested/.obsidian/app.json", ".git/config", ".env"])("protects configuration %s even from vault owners", path => {
  expect(classifyVaultPath(path)).toBe("configuration");
  for (const capability of ["content.read", "content.write"]) {
    expect(allowed({ ...principal, membership: "owner", capability, path })).toBe(false);
    expect(allowed({ ...principal, instanceRole: "admin", membership: "owner", capability, path })).toBe(false);
  }
});
it.each(["app.json", "appearance.json", "workspace.json", "workspace-mobile.json", "workspace.work.json", "hotkeys.json", "graph.json", "workspaces.json"])("allows members to read shared %s configuration", file => {
  const path = ".obsidian/" + file;
  expect(classifyVaultPath(path)).toBe(file === "appearance.json" ? "configuration" : "personal-candidate");
  expect(allowed({ ...principal, membership: "owner", capability: "content.read", path })).toBe(true);
});
it.each([null, undefined, {}, [], "../note.md", "A/../note.md", "/note.md", "A//note.md", "A/./note.md", "A\\note.md", "note.md\0", "A/", ".obsidian /app.json", "A./note.md"])("rejects noncanonical input %j even for an administrator", path => {
  expect(classifyVaultPath(path)).toBe("invalid");
  expect(allowed({ ...principal, instanceRole: "admin", capability: "content.read", path })).toBe(false);
});
it("fails closed for unknown roles, capabilities, inactive accounts and root-wide operations", () => {
  for (const status of [undefined, "disabled", "pending"])
    expect(allowed({ status, instanceRole: "admin", capability: "sync.manage" })).toBe(false);
  for (const membership of [undefined, "admin", "unknown"])
    expect(allowed({ ...principal, membership, capability: "content.read", path: "note.md" })).toBe(false);
  expect(allowed({ ...principal, instanceRole: "unknown", membership: "owner", capability: "vault.delete" })).toBe(false);
  expect(allowed({ ...principal, instanceRole: "admin", capability: "unknown" })).toBe(false);
  for (const path of ["", ".ignis-trash/data", "A/.IGNIS-private/file"])
    expect(allowed({ ...principal, instanceRole: "admin", capability: "content.write", path })).toBe(false);
  expect(allowed()).toBe(false);
});

it.each(["reader","editor","owner"])("enforces %s permissions on community plugins and their configuration",membership=>{
 for(const path of [".obsidian", ".obsidian/plugins/example/main.js", ".obsidian/plugins/example/data.json", ".obsidian/community-plugins.json", ".obsidian/themes/example/theme.css", ".OBSIDIANTEST"]){
  expect(allowed({...principal,membership,capability:"content.read",path})).toBe(
    classifyVaultPath(path) !== "community-plugin" || membership === "owner",
  );
  expect(allowed({...principal,membership,capability:"content.write",path})).toBe(path === ".OBSIDIANTEST" && membership!=="reader");
  expect(allowed({...principal,capability:"content.read",path})).toBe(false);
 }
});

it.each([undefined, "reader", "editor", "owner"])("admin data access requires explicit %s membership", membership => {
 const context={status:"active",instanceRole:"admin",membership};
 for(const path of ["note.md", ".obsidian/plugins/demo/main.js"]){
  const plugin = classifyVaultPath(path) === "community-plugin";
  expect(allowed({...context,capability:"content.read",path})).toBe(plugin ? membership === "owner" : !!membership);
  expect(allowed({...context,capability:"content.write",path})).toBe(plugin ? membership === "owner" : ["editor","owner"].includes(membership));
 }
 expect(allowed({...context,capability:"content.list",path:""})).toBe(!!membership);
 for(const capability of ["vault.rename","vault.delete","vault.refresh","members.manage","ownership.transfer"])
  expect(allowed({...context,capability})).toBe(membership==="owner");
 expect(allowed({...context,capability:"users.manage"})).toBe(true);
});

it("allows active accounts to create without existing membership",()=>{
 expect(allowed({...principal,capability:"vault.create"})).toBe(true);
 expect(allowed({...principal,status:"disabled",capability:"vault.create"})).toBe(false);
});

it('allows the vault trash only with explicit membership and protects hidden nested state',()=>{
 for(const membership of [undefined,'reader','editor','owner'])for(const path of ['.trash','.trash/note.md','.trash/Folder/note.md']){
  expect(allowed({...principal,membership,path,capability:'content.read'})).toBe(!!membership);
  expect(allowed({...principal,membership,path,capability:'content.write'})).toBe(['editor','owner'].includes(membership));
 }
 for(const path of ['.trash/.env','.trash/.ignis-secret','Nested/.trash/note.md','.trash/../secret'])expect(allowed({...principal,membership:'owner',path,capability:'content.write'})).toBe(false);
});

it.each(['reader','editor','owner'])('requires admin plus writable membership to change active code (%s)',membership=>{
 for(const path of ['.obsidian/plugins/demo/main.js','.obsidian/plugins/demo/data.json','.obsidian/plugins/demo/manifest.json',
  '.obsidian/themes/demo/theme.css','.obsidian/snippets/custom.css','.obsidian/community-plugins.json',
  '.obsidian/core-plugins.json','.obsidian/appearance.json','.obsidian/unknown.json','.obsidian/unknown.bin']){
  expect(allowed({...principal,membership,path,capability:'content.write'})).toBe(false);
  const plugin = classifyVaultPath(path) === "community-plugin";
  expect(allowed({...principal,membership,path,capability:"content.write",communityPluginsAllowed:true})).toBe(plugin && membership==="owner");
  expect(allowed({...principal,instanceRole:"admin",membership,path,capability:"content.write"})).toBe(plugin ? membership==="owner" : membership!=="reader");
  expect(allowed({...principal,instanceRole:'admin',path,capability:'content.write'})).toBe(false);
 }
 for(const path of ['.obsidian/app.json','.obsidian/workspace.json','.obsidian/hotkeys.json','.obsidian/graph.json'])
  expect(allowed({...principal,membership,path,capability:'content.write'})).toBe(membership!=='reader');
});
it.each(["My Work","Work.v2","Desk - 2","Work_2"])("allows reviewed workspace state for %s without opening other config paths",name=>{
 const input={status:"active",instanceRole:"user",membership:"owner",capability:"content.write"};
 expect(classifyVaultPath(`.obsidian/workspace.${name}.json`)).toBe("personal-candidate");
 expect(allowed({...input,path:`.obsidian/workspace.${name}.json`})).toBe(true);
 for(const path of [".obsidian/workspace.../plugins/x/main.js",".obsidian/workspace../app.json",".obsidian/plugins/x/data.json"])
  expect(allowed({...input,path})).toBe(false);
});
