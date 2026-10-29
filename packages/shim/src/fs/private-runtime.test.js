import { it, expect, vi } from "vitest";
import { createPrivateRuntime } from "./private-runtime.js";
import { createFsSync } from "./sync.js";
import { createFsPromises } from "./promises.js";
import { createFdOps } from "./fd.js";
import { MetadataCache } from "./metadata-cache.js";
import { ContentCache } from "./content-cache.js";
const context = ()=>({vault:"uuid",sessionId:"session"});
const snapshot = Object.fromEntries(["app.json","appearance.json","core-plugins.json","community-plugins.json"].map(name=>[".obsidian/"+name,{content:"{}",writable:true}]));
const boot = ()=>({configurationMode:"private",vault:{uuid:"uuid"},tree:{".obsidian/secret.json":{type:"file"}},privateConfiguration:snapshot});
it("activates the same gateway in factories created before bootstrap",async()=>{
  const config = {readSync:vi.fn(()=>"private"),read:vi.fn(async()=>"private")};
  const make = vi.fn(()=>config);
  const runtime = createPrivateRuntime(context,make);
  const metadata = new MetadataCache();
  const cache = new ContentCache();
  cache.set(".obsidian/app.json","shared");
  const sync = createFsSync(metadata,cache,{},runtime.gateway);
  const async = createFsPromises(metadata,cache,{},runtime.gateway);
  const fd = createFdOps(metadata,cache,{},runtime.gateway);
  const tree = runtime.configure(boot());
  expect(tree).not.toHaveProperty(".obsidian/secret.json");
  expect(sync.readFileSync(".obsidian/app.json","utf8")).toBe("private");
  expect(await async.readFile(".obsidian/app.json","utf8")).toBe("private");
  expect(()=>fd.openSync(".obsidian/app.json","r")).toThrow();
  expect(runtime.gateway.allowsSharedPrefetch(".obsidian/app.json")).toBe(false);
  expect(make).toHaveBeenCalledWith({...context(),currentContext:context});
  expect(()=>runtime.configure(boot())).toThrow();
});
it.each([undefined,"shared"])("preserves shared behavior for mode %s",mode=>{
  const make=vi.fn();
  const runtime=createPrivateRuntime(context,make);
  const data={...boot(),configurationMode:mode};
  expect(runtime.configure(data)).toBe(data.tree);
  expect(runtime.gateway.select(".obsidian/app.json",".obsidian/app.json")).toBeNull();
  expect(make).not.toHaveBeenCalled();
});
it.each([
  data=>({...data,configurationMode:"unknown"}),
  data=>({...data,vault:{uuid:"other"}}),
  data=>({...data,privateConfiguration:{}}),
])("fails closed on malformed bootstrap without shared fallback",alter=>{
  const runtime=createPrivateRuntime(context,()=>({}));
  expect(()=>runtime.configure(alter(boot()))).toThrow();
  expect(()=>runtime.gateway.select(".obsidian/app.json",".obsidian/app.json")).toThrow();
  expect(()=>runtime.configure(boot())).toThrow();
});
it("rejects private activation without an authenticated session",()=>{
  const runtime=createPrivateRuntime(()=>({vault:"uuid",sessionId:null}));
  expect(()=>runtime.configure(boot())).toThrow();
});
