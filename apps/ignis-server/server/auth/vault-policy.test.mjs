import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { classifyVaultPath, vaultCapabilityAllowed: allowed } = require("./vault-policy");
const principal = { status: "active", instanceRole: "user" };

it.each(["reader", "editor", "owner"])("allows ordinary reads for %s without granting administrative capabilities", membership => {
  const context = { ...principal, membership };
  expect(allowed({ ...context, capability: "content.read", path: "Notes/Hello.md" })).toBe(true);
  expect(allowed({ ...context, capability: "content.write", path: "Images/photo.png" })).toBe(membership !== "reader");
  for (const capability of ["users.manage", "instance.configure", "audit.read", "vault.create", "plugins.manage", "sync.manage"])
    expect(allowed({ ...context, capability })).toBe(false);
  for (const capability of ["members.manage", "ownership.transfer", "vault.rename", "vault.delete", "vault.refresh"])
    expect(allowed({ ...context, capability })).toBe(membership === "owner");
});
it.each([".obsidian/plugins/example/main.js", ".obsidian/plugins/example/data.json", ".obsidian/community-plugins.json", ".obsidian/snippets/style.css", ".obsidian/themes/theme.css", ".obsidian/unknown.json", ".OBSIDIAN/plugins/main.js", "Nested/.obsidian/app.json", ".git/config", ".env"])("protects configuration %s even from vault owners", path => {
  expect(classifyVaultPath(path)).toBe("configuration");
  for (const capability of ["content.read", "content.write"]) {
    expect(allowed({ ...principal, membership: "owner", capability, path })).toBe(false);
    expect(allowed({ ...principal, instanceRole: "admin", capability, path })).toBe(true);
  }
});
it.each(["app.json", "appearance.json", "workspace.json", "workspace-mobile.json", "workspace.work.json", "hotkeys.json", "graph.json", "workspaces.json"])("does not expose shared %s as personal preferences", file => {
  const path = ".obsidian/" + file;
  expect(classifyVaultPath(path)).toBe("personal-candidate");
  expect(allowed({ ...principal, membership: "owner", capability: "content.read", path })).toBe(false);
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
