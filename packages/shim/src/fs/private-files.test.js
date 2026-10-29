import { it, expect, vi, afterEach } from "vitest";
import { createPrivateFiles } from "./private-files.js";
import { createFsSync } from "./sync.js";
import { createFsPromises } from "./promises.js";
import { MetadataCache } from "./metadata-cache.js";
import { ContentCache } from "./content-cache.js";
import { registerPathResolver, _reset } from "./transforms.js";
import { setVirtualFile, removeVirtualFile } from "./virtual-files.js";
const file = ".obsidian/app.json";
afterEach(()=>{_reset();removeVirtualFile(file);});
function setup() {
  const configuration = {
    read:vi.fn(async()=>'{"spellcheck":true}'),
    readSync:vi.fn(()=>'{"spellcheck":true}'),
    write:vi.fn(async()=>({revision:1})),
    writeSync:vi.fn(()=>({revision:1})),
  };
  const metadata = new MetadataCache();
  const content = new ContentCache();
  metadata.set(file,{type:"file",size:99,mtime:1,ctime:1});
  content.set(file,"shared private data must not escape");
  const transport = {readFile:vi.fn(),writeFile:vi.fn(),readFileSync:vi.fn(),writeFileSync:vi.fn()};
  const adapter = createPrivateFiles(configuration);
  return {configuration,metadata,content,transport,adapter,sync:createFsSync(metadata,content,transport,adapter),async:createFsPromises(metadata,content,transport,adapter)};
}
it("intercepts both reads before shared content, metadata and virtual source overrides",async()=>{
  const {configuration,metadata,transport,sync,async} = setup();
  setVirtualFile(file,"shared virtual content");
  expect(sync.readFileSync(file,"utf8")).toBe('{"spellcheck":true}');
  expect(await async.readFile(file,{encoding:"utf-8"})).toBe('{"spellcheck":true}');
  metadata.delete(file);
  expect(new TextDecoder().decode(sync.readFileSync(file))).toBe('{"spellcheck":true}');
  expect(new TextDecoder().decode(await async.readFile(file))).toBe('{"spellcheck":true}');
  expect(configuration.read).toHaveBeenCalledTimes(2);
  expect(transport.readFile).not.toHaveBeenCalled();
  expect(transport.readFileSync).not.toHaveBeenCalled();
});
it("saves privately without optimistic shared cache updates or disk transport",async()=>{
  const {configuration,content,metadata,transport,sync,async} = setup();
  const initial = {...metadata.get(file)};
  sync.writeFileSync(file,new TextEncoder().encode('{}'));
  await async.writeFile(file,'{}',"utf8");
  expect(configuration.writeSync).toHaveBeenCalledWith(file,'{}');
  expect(configuration.write).toHaveBeenCalledWith(file,'{}');
  expect(content.get(file)).toBe("shared private data must not escape");
  expect(metadata.get(file)).toEqual(initial);
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(transport.writeFileSync).not.toHaveBeenCalled();
});
it("propagates write conflicts instead of acknowledging or queueing retries",async()=>{
  const {configuration,content,sync,async} = setup();
  const error = Object.assign(new Error("Conflict"),{code:"PREFERENCES_CONFLICT"});
  configuration.write.mockRejectedValue(error);
  configuration.writeSync.mockImplementation(()=>{throw error;});
  expect(()=>sync.writeFileSync(file,"{}")).toThrow(error);
  await expect(async.writeFile(file,"{}")).rejects.toBe(error);
  expect(content.get(file)).toBe("shared private data must not escape");
});
it("denies unreviewed configuration and redirected aliases without shared fallback",async()=>{
  const {configuration,sync,async,adapter} = setup();
  for (const path of [".obsidian/plugins/x/main.js",".OBSIDIAN/app.json",".obsidian/../note.md","nested/.obsidian/app.json"]) {
    expect(()=>sync.readFileSync(path,"utf8")).toThrow();
    await expect(async.writeFile(path,"{}")).rejects.toThrow();
  }
  registerPathResolver(p=>p===file,()=>"other.json");
  expect(()=>sync.readFileSync(file,"utf8")).toThrow();
  expect(()=>adapter.select("note.md",file)).toThrow();
  expect(configuration.readSync).not.toHaveBeenCalled();
  expect(configuration.write).not.toHaveBeenCalled();
});
it("rejects unsupported encodings and malformed UTF-8 before saving",async()=>{
  const {configuration,sync,async} = setup();
  expect(()=>sync.readFileSync(file,"base64")).toThrow();
  await expect(async.writeFile(file,new Uint8Array([0xff]))).rejects.toThrow();
  expect(configuration.readSync).not.toHaveBeenCalled();
  expect(configuration.write).not.toHaveBeenCalled();
});
it("preserves ordinary content reads when the adapter is present",async()=>{
  const {content,metadata,sync,async} = setup();
  metadata.set("note.md",{type:"file",size:4,mtime:1,ctime:1});
  content.set("note.md","note");
  expect(sync.readFileSync("note.md","utf8")).toBe("note");
  expect(await async.readFile("note.md","utf8")).toBe("note");
});
