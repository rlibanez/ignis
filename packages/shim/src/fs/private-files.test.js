import { it, expect, vi, afterEach } from "vitest";
import { createPrivateFiles } from "./private-files.js";
import { createFdOps } from "./fd.js";
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
    inspect:vi.fn(async()=>({content:'{"text":"á"}',writable:true})),
    inspectSync:vi.fn(()=>({content:'{"text":"á"}',writable:true})),
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

it("derives private metadata without trusting shared metadata and without reading for edit",async()=>{
  const {configuration,sync,async,metadata} = setup();
  metadata.set(file,{type:"directory",size:999999,mtime:123,ctime:123});
  for (const stat of [sync.statSync(file),await async.stat(file),sync.lstatSync(file),await async.lstat(file)]) {
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(new TextEncoder().encode('{"text":"á"}').length);
    expect(stat.mtimeMs).toBe(0);
  }
  expect(sync.existsSync(file)).toBe(true);
  expect(sync.statSync(".obsidian").isDirectory()).toBe(true);
  expect(sync.existsSync(".obsidian/plugins/secret.json")).toBe(false);
  expect(configuration.read).not.toHaveBeenCalled();
  expect(configuration.readSync).not.toHaveBeenCalled();
});
it("lists only projected configuration without exposing shared plugin names",async()=>{
  const {sync,async,metadata} = setup();
  metadata.set(".obsidian/plugins/secret/main.js",{type:"file"});
  const expected = ["app.json","appearance.json","core-plugins.json","community-plugins.json"];
  expect(sync.readdirSync(".obsidian")).toEqual(expected);
  expect(await async.readdir(".obsidian")).toEqual(expected);
  expect(()=>sync.readdirSync(file)).toThrow(expect.objectContaining({code:"ENOTDIR"}));
  await expect(async.readdir(".obsidian/plugins")).rejects.toThrow();
});
it("checks private access modes and propagates revoked access for metadata",async()=>{
  const {configuration,sync,async} = setup();
  sync.accessSync(file,2);
  await async.access(file,4);
  configuration.inspectSync.mockReturnValue({content:'[]',writable:false});
  expect(()=>sync.accessSync(".obsidian/core-plugins.json",2)).toThrow(expect.objectContaining({code:"EACCES"}));
  await expect(async.access(file,1)).rejects.toMatchObject({code:"EACCES"});
  const error = Object.assign(new Error("Revoked"),{code:"AUTH_CONTEXT_CHANGED"});
  configuration.inspectSync.mockImplementation(()=>{throw error;});
  configuration.inspect.mockRejectedValue(error);
  expect(()=>sync.existsSync(file)).toThrow(error);
  await expect(async.readdir(".obsidian")).rejects.toBe(error);
});

const alternativeOperations = [
  ["appendFile",[file,"extra"]], ["unlink",[file]],
  ["mkdir",[".obsidian/new"]], ["rmdir",[".obsidian"]],
  ["rm",[".obsidian",{recursive:true}]],
  ["rename",[file,"note.md"]], ["rename",["note.md",file]],
  ["copyFile",[file,"note.md"]], ["copyFile",["note.md",file]],
  ["utimes",[file,0,0]], ["lutimes",[file,0,0]], ["chmod",[file,0o600]],
  ["rm",["/",{recursive:true}]], ["rename",["/","other"]],
];
it.each(alternativeOperations)("rejects %s before touching shared state (%j)",async(method,args)=>{
  const {sync,async,content,metadata,transport} = setup();
  const initial = {...metadata.get(file)};
  const error = {code:"UNSUPPORTED_CONFIGURATION_OPERATION"};
  expect(()=>sync[method+"Sync"](...args)).toThrow(expect.objectContaining(error));
  await expect(async[method](...args)).rejects.toMatchObject(error);
  expect(content.get(file)).toBe("shared private data must not escape");
  expect(metadata.get(file)).toEqual(initial);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
});
it("rejects descriptor opens before buffers or shared cache reads, including callbacks",async()=>{
  const {async,adapter,metadata,content,transport} = setup();
  const fd = createFdOps(metadata,content,transport,adapter);
  expect(()=>fd.openSync(file,"r")).toThrow(expect.objectContaining({code:"UNSUPPORTED_CONFIGURATION_OPERATION"}));
  await expect(async.open(file,"r")).rejects.toMatchObject({code:"UNSUPPORTED_CONFIGURATION_OPERATION"});
  const result = await new Promise(resolve=>fd.open(file,"r",(error,descriptor)=>resolve({error,descriptor})));
  expect(result.error.code).toBe("UNSUPPORTED_CONFIGURATION_OPERATION");
  expect(result.descriptor).toBeUndefined();
  expect(transport.readFileSync).not.toHaveBeenCalled();
});
it("rejects mutation aliases that resolve into or out of private configuration",async()=>{
  const {sync,async} = setup();
  registerPathResolver(p=>p==="alias.md",()=>file);
  registerPathResolver(p=>p===file,()=>"note.md");
  expect(()=>sync.unlinkSync("alias.md")).toThrow();
  await expect(async.rename(file,"note.md")).rejects.toThrow();
});
it("projects a separate tree without shared configuration metadata or plugin names",()=>{
  const {adapter} = setup();
  const original = {"note.md":{type:"file",size:20},".obsidian/plugins/secret/main.js":{type:"file",size:100},".OBSIDIAN/app.json":{type:"file",size:900}};
  const snapshot = Object.fromEntries(["app.json","appearance.json","core-plugins.json","community-plugins.json"].map(name=>[".obsidian/"+name,{content:'{}',writable:false}]));
  const projected = adapter.projectTree(original,snapshot);
  expect(Object.keys(projected)).toHaveLength(6);
  expect(projected[".obsidian/app.json"].size).toBe(2);
  expect(projected).not.toHaveProperty(".obsidian/plugins/secret/main.js");
  projected["note.md"].size=3;
  expect(original["note.md"].size).toBe(20);
  expect(()=>adapter.projectTree(original,{})).toThrow();
});
it("adds the private directory to root listings without duplicates or shared casing",async()=>{
  const {metadata,sync,async} = setup();
  metadata.set(".OBSIDIAN/shared.json",{type:"file"});
  expect(sync.readdirSync("/").filter(name=>name.toLowerCase()===".obsidian")).toEqual([".obsidian"]);
  expect((await async.readdir("/")).filter(name=>name.toLowerCase()===".obsidian")).toEqual([".obsidian"]);
  metadata.delete(file);
  metadata.delete(".OBSIDIAN/shared.json");
  expect(sync.readdirSync("/")).toContain(".obsidian");
});
it("treats creation of the existing private config directory as an authorized no-op",async()=>{
  const {configuration,sync,async,transport,metadata} = setup();
  sync.mkdirSync(".obsidian");
  await async.mkdir(".obsidian",{recursive:true});
  expect(configuration.inspectSync).toHaveBeenCalledTimes(2);
  expect(metadata.has(".obsidian")).toBe(false);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
  configuration.inspectSync.mockImplementation(()=>{throw new Error("Revoked");});
  expect(()=>sync.mkdirSync(".obsidian")).toThrow("Revoked");
});
