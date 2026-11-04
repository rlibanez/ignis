import { it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const require=createRequire(import.meta.url);
const dns=require("node:dns"),https=require("node:https");
const {publicLookup,memberTarget,memberRelay}=require("./member-network");
const {relayOnce}=require("./relay");
afterEach(()=>vi.restoreAllMocks());
it("allows public plugin downloads and APIs while rejecting local endpoints and credentials in URLs",()=>{
 for(const target of ["https://github.com/a","https://api.example.com/items"])
  expect(memberTarget(new URL(target),"any",[])).toBe(true);
 for(const target of ["https://127.0.0.1/","https://192.168.2.2/","https://[::1]/","https://[::ffff:127.0.0.1]/","http://github.com/","https://a:b@github.com/","https://github.com:8443/"])
  expect(memberTarget(new URL(target),"any",[])).toBe(false);
 expect(memberTarget(new URL("https://github.com/"),"allowlist",["api.example.com"])).toBe(false);
});
it("pins public DNS answers independently of administrator LAN exceptions",async()=>{
 for(const addresses of [["127.0.0.1"],["::ffff:127.0.0.1"],["192.168.2.9"],["1.1.1.1","10.0.0.1"]]){
  vi.spyOn(dns,"lookup").mockImplementation((_host,_options,cb)=>cb(null,addresses.map(address=>({address,family:address.includes(":")?6:4}))));
  await expect(new Promise((resolve,reject)=>publicLookup("github.com",{},(err,a)=>err?reject(err):resolve(a)))).rejects.toThrow();vi.restoreAllMocks();
 }
});
it("rechecks the configured allowlist after redirects through the real relay",async()=>{
 const request=vi.spyOn(https,"request").mockImplementation((_url,options,callback)=>{
  expect(options.lookup).toBe(publicLookup);
  const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=302;res.headers={location:"https://other.example/"};callback(res);res.end();};return req;
 });
 await expect(memberRelay({url:"https://github.com/a",method:"GET",headers:{}},relayOnce,"allowlist",["github.com"])).rejects.toThrow();
 expect(request).toHaveBeenCalledTimes(1);
});
it("bounds concurrency and preserves plugin-supplied API requests without adding server credentials",async()=>{
 const releases=[];const args={url:"https://api.example.com/a",method:"POST",body:"payload",headers:{Authorization:"user-supplied"}};
 const relay=vi.fn(input=>{expect(input).toMatchObject({...args,maxBytes:10485760,timeoutMs:15000});return new Promise(resolve=>releases.push(resolve));});
 const pending=Array.from({length:8},()=>memberRelay(args,relay,"any",[]));
 await expect(memberRelay(args,relay,"any",[])).rejects.toThrow("capacity");
 releases.forEach(release=>release({}));await Promise.all(pending);
 await expect(memberRelay(args,async()=>({ok:true}),"any",[])).resolves.toEqual({ok:true});
});
