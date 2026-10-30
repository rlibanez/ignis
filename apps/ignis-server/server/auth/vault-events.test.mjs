import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { projectVaultEvent } = require("./vault-events");
const { vaultCapabilityAllowed } = require("./vault-policy");
const policy = {
  canRead: path => vaultCapabilityAllowed({ status: "active", instanceRole: "user", membership: "reader", capability: "content.read", path }),
  canAdmin: () => false,
};
it("projects only permitted paths and known metadata fields", () => {
  expect(projectVaultEvent({ type: "modified", path: "note.md", secret: "hidden", stat: { type: "file", size: 3, mtime: 4, internalPath: "/secret", ctime: -1 } }, policy))
    .toEqual({ type: "modified", path: "note.md", stat: { type: "file", size: 3, mtime: 4 } });
  for (const path of [".ignis-trash/note.md", "../secret", "/note.md"])
    expect(projectVaultEvent({ type: "modified", path }, policy)).toBeNull();
});
it("never reveals a hidden side of a rename", () => {
  expect(projectVaultEvent({ type: "rename", path: "note.md", toPath: ".git/secret.json" }, policy)).toEqual({ type: "deleted", path: "note.md" });
  expect(projectVaultEvent({ type: "rename", path: ".git/secret.json", toPath: "note.md" }, policy)).toEqual({ type: "created", path: "note.md" });
  expect(projectVaultEvent({ type: "rename", path: ".git/a", toPath: ".git/b" }, policy)).toBeNull();
  expect(projectVaultEvent({ type: "rename", path: "a.md", toPath: "b.md" }, policy)).toEqual({ type: "rename", path: "a.md", toPath: "b.md" });
});
it.each([
  { channel: "metadata", type: "revision", etag: "global" },
  { channel: "metadata", type: "replaced", etag: "global" },
  { channel: "plugin:headless-sync", type: "sync-log", secret: "credential" },
  { channel: "plugin:headless-sync", type: "sync-status" },
  { type: "virtual-plugin-enable" }, { type: "virtual-plugin-disable" },
])("reserves global or executable messages for administrators: %j", message => {
  expect(projectVaultEvent(message, policy)).toBeNull();
  expect(projectVaultEvent(message, { ...policy, canAdmin: () => true })).not.toBeNull();
});
it.each([null, [], {}, { type: "unknown" }, { type: "modified", path: [] }, { channel: "unknown", type: "revision" }])("rejects unknown/malformed messages %j", message => {
  expect(projectVaultEvent(message, policy)).toBeNull();
});

it("delivers community plugin updates to authorized readers",()=>{
 expect(projectVaultEvent({type:"modified",path:".obsidian/plugins/x/main.js"},policy)).toEqual({type:"modified",path:".obsidian/plugins/x/main.js"});
});
