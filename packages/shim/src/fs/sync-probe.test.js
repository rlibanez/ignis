import { afterEach, expect, it, vi } from "vitest";
import { createFsSync } from "./sync.js";
import { MetadataCache } from "./metadata-cache.js";
import { ContentCache } from "./content-cache.js";
import { initWriteCoalescer, enqueue, _reset } from "./write-coalescer.js";
import { _reset as resetDurability } from "./write-durability.js";

afterEach(() => { _reset(); resetDurability(); });

it.each([false, true])("removes the Obsidian filesystem probe after queued writes (existing: %s)", async (existing) => {
  const remote = new Map(existing ? [[".OBSIDIANTEST", ""]] : []);
  const operations = [];
  let finishWrite;
  const transport = {
    writeFile: vi.fn(async (path, data) => {
      operations.push("write");
      await new Promise(resolve => { finishWrite = resolve; });
      remote.set(path, data);
      return { mtime: 123, size: 0 };
    }),
    unlink: vi.fn(async path => {
      operations.push("unlink");
      if (!remote.delete(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
  };
  const metadata = new MetadataCache();
  if (existing) metadata.set(".OBSIDIANTEST", { type: "file", size: 0 });
  initWriteCoalescer(transport);
  const fs = createFsSync(metadata, new ContentCache(), transport);
  if (fs.existsSync(".OBSIDIANTEST")) fs.unlinkSync(".OBSIDIANTEST");
  fs.writeFileSync(".OBSIDIANTEST", "", "utf8");
  fs.unlinkSync(".OBSIDIANTEST");
  expect(fs.existsSync(".OBSIDIANTEST")).toBe(false);
  await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
  finishWrite();
  await enqueue(".OBSIDIANTEST", () => {});
  expect(remote.has(".OBSIDIANTEST")).toBe(false);
  expect(fs.existsSync(".OBSIDIANTEST")).toBe(false);
  expect(operations).toEqual(existing ? ["unlink", "write", "unlink"] : ["write", "unlink"]);
});
