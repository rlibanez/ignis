import { it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { permitSubtree, filterTree } = require("./resource-policy");
const { vaultCapabilityAllowed } = require("../auth/vault-policy");
let root, req;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-subtree-"));
  req = { _vaultId: "id", authorizeVaultFile: (id, capability, file) => vaultCapabilityAllowed({
    status: "active", instanceRole: "user", membership: "editor", capability, path: file,
  }) };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("filters metadata without mutating shared entries", () => {
  const tree = { "note.md": { type: "file" }, ".obsidian": { type: "directory" }, ".obsidian/app.json": { type: "file" }, "Folder": { type: "directory" } };
  expect(Object.keys(filterTree(req, root, tree))).toEqual(["note.md", ".obsidian", ".obsidian/app.json", "Folder"]);
  expect(Object.keys(tree)).toHaveLength(4);
});
it("rejects a mixed subtree as a whole and checks the destination too", async () => {
  const source = path.join(root, "Folder");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "note.md"), "keep");
  expect(await permitSubtree(req, root, source, "content.write", path.join(root, "Other"))).toBe(true);
  expect(await permitSubtree(req, root, source, "content.write", path.join(root, ".git"))).toBe(false);
  fs.mkdirSync(path.join(source, ".obsidian"));
  expect(await permitSubtree(req, root, source, "content.write")).toBe(false);
  expect(fs.readFileSync(path.join(source, "note.md"), "utf8")).toBe("keep");
});
it("rejects symlinks inside recursive mutations", async () => {
  const source = path.join(root, "Folder"); fs.mkdirSync(source);
  fs.symlinkSync(root, path.join(source, "alias"));
  expect(await permitSubtree(req, root, source, "content.write")).toBe(false);
});
