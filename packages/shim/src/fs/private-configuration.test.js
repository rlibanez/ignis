import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrivateConfiguration } from "./private-configuration.js";
let current, request, client;
const response = (data,ok=true) => ({ok,json:async()=>data});
beforeEach(() => {
  globalThis.window = {location:{origin:"http://localhost"}};
  current = {sessionId:"session-a",vault:"stable-uuid"};
  request = vi.fn();
  client = createPrivateConfiguration({...current,currentContext:()=>current,request});
});
afterEach(()=>{delete globalThis.window;});
it("pins the vault/session and saves the revision from a private read",async()=>{
  request.mockResolvedValueOnce(response({content:'{}',revision:2,writable:true})).mockResolvedValueOnce(response({revision:3}));
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"CONFIGURATION_READ_REQUIRED"});
  expect(await client.read(".obsidian/app.json")).toBe("{}");
  await client.write(".obsidian/app.json",'{"spellcheck":true}');
  const options = request.mock.calls[1][1];
  expect(options.headers["x-ignis-context"]).toBe("session-a");
  expect(JSON.parse(options.body)).toEqual({vault:"stable-uuid",path:".obsidian/app.json",content:'{"spellcheck":true}',expectedRevision:2});
});
it("does not retry conflicts or uncertain writes until an explicit fresh read",async()=>{
  request.mockResolvedValueOnce(response({content:'{}',revision:0,writable:true})).mockResolvedValueOnce(response({code:"PREFERENCES_CONFLICT",error:"Conflict"},false));
  await client.read(".obsidian/app.json");
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"PREFERENCES_CONFLICT"});
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"CONFIGURATION_READ_REQUIRED"});
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValueOnce(response({content:'{}',revision:5,writable:true})).mockRejectedValueOnce(new Error("Lost response"));
  await client.read(".obsidian/app.json");
  await expect(client.write(".obsidian/app.json","{}")).rejects.toThrow("Lost response");
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"CONFIGURATION_READ_REQUIRED"});
});
it("rejects responses and writes after a session or vault switch",async()=>{
  request.mockImplementationOnce(async()=>{current={...current,sessionId:"session-b"};return response({content:'{}',revision:0,writable:true});});
  await expect(client.read(".obsidian/app.json")).rejects.toMatchObject({code:"AUTH_CONTEXT_CHANGED"});
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"AUTH_CONTEXT_CHANGED"});
  expect(request).toHaveBeenCalledTimes(1);
});
it("blocks parallel operations on one file and refuses writes to server-owned lists",async()=>{
  let resolve;
  request.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  const pending = client.read(".obsidian/community-plugins.json");
  await expect(client.read(".obsidian/community-plugins.json")).rejects.toMatchObject({code:"CONFIGURATION_BUSY"});
  resolve(response({content:'[]',revision:0,writable:false}));
  await pending;
  await expect(client.write(".obsidian/community-plugins.json","[]")).rejects.toMatchObject({code:"CONFIGURATION_READ_REQUIRED"});
});

function synchronousClient(replies) {
  const calls = [];
  const createXHR = () => {
    const call = {headers:{}};
    calls.push(call);
    return {
      open(method,url,async) { Object.assign(call,{method,url,async}); },
      setRequestHeader(name,value) { call.headers[name]=value; },
      send(body) {
        call.body = body;
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        reply.action?.();
        this.status = reply.status ?? 200;
        this.responseText = reply.raw ?? JSON.stringify(reply.data);
      },
    };
  };
  return {calls,client:createPrivateConfiguration({...current,currentContext:()=>current,request,createXHR})};
}
const settings = revision => ({content:'{}',revision,writable:true});
it("shares revisions across synchronous and asynchronous operations",async()=>{
  const {client,calls} = synchronousClient([{data:settings(4)},{data:{revision:6}}]);
  expect(client.readSync(".obsidian/app.json")).toBe('{}');
  request.mockResolvedValueOnce(response({revision:5}));
  await client.write(".obsidian/app.json","{}");
  expect(JSON.parse(request.mock.calls[0][1].body).expectedRevision).toBe(4);
  client.writeSync(".obsidian/app.json","{}");
  expect(JSON.parse(calls[1].body)).toEqual({vault:"stable-uuid",path:".obsidian/app.json",content:"{}",expectedRevision:5});
  expect(calls[0].async).toBe(false);
  expect(calls[0].headers["x-ignis-context"]).toBe("session-a");
  expect(new URL(calls[0].url).searchParams.get("vault")).toBe("stable-uuid");
});
it("blocks sync operations while an async write is outstanding",async()=>{
  const {client,calls} = synchronousClient([{data:settings(0)}]);
  client.readSync(".obsidian/app.json");
  let finish;
  request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending = client.write(".obsidian/app.json","{}");
  expect(()=>client.readSync(".obsidian/app.json")).toThrow(expect.objectContaining({code:"CONFIGURATION_BUSY"}));
  expect(()=>client.writeSync(".obsidian/app.json","{}")).toThrow(expect.objectContaining({code:"CONFIGURATION_BUSY"}));
  expect(calls).toHaveLength(1);
  finish(response({revision:1}));
  await pending;
});
it.each([
  {status:409,data:{code:"PREFERENCES_CONFLICT",error:"Conflict"}},
  {status:0,data:{revision:1}},
  {raw:"not json"},
  {data:{revision:40}},
  new Error("Lost connection"),
])("does not retry synchronous writes after a conflict or uncertain response: %j",async failure=>{
  const {client,calls} = synchronousClient([{data:settings(0)},failure]);
  client.readSync(".obsidian/app.json");
  expect(()=>client.writeSync(".obsidian/app.json","{}")).toThrow();
  expect(()=>client.writeSync(".obsidian/app.json","{}")).toThrow(expect.objectContaining({code:"CONFIGURATION_READ_REQUIRED"}));
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"CONFIGURATION_READ_REQUIRED"});
  expect(calls).toHaveLength(2);
  expect(request).not.toHaveBeenCalled();
});
it("invalidates a previously readable revision after a failed refresh",async()=>{
  const {client} = synchronousClient([{data:settings(0)},{raw:"broken"}]);
  client.readSync(".obsidian/app.json");
  expect(()=>client.readSync(".obsidian/app.json")).toThrow();
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"CONFIGURATION_READ_REQUIRED"});
  request.mockResolvedValueOnce(response(settings(3))).mockRejectedValueOnce(new Error("offline"));
  await client.read(".obsidian/app.json");
  await expect(client.read(".obsidian/app.json")).rejects.toThrow("offline");
  expect(()=>client.writeSync(".obsidian/app.json","{}")).toThrow(expect.objectContaining({code:"CONFIGURATION_READ_REQUIRED"}));
});
it("discards a synchronous response if the context changes during the request",()=>{
  const {client,calls} = synchronousClient([{data:settings(0),action:()=>{current={...current,vault:"other-uuid"};}}]);
  expect(()=>client.readSync(".obsidian/app.json")).toThrow(expect.objectContaining({code:"AUTH_CONTEXT_CHANGED"}));
  expect(()=>client.writeSync(".obsidian/app.json","{}")).toThrow(expect.objectContaining({code:"AUTH_CONTEXT_CHANGED"}));
  expect(calls).toHaveLength(1);
});
it("rejects sync writes for server-owned files and exhausted revisions",()=>{
  const {client} = synchronousClient([{data:{content:"[]",revision:0,writable:false}},{data:settings(Number.MAX_SAFE_INTEGER)}]);
  client.readSync(".obsidian/community-plugins.json");
  expect(()=>client.writeSync(".obsidian/community-plugins.json","[]")).toThrow();
  client.readSync(".obsidian/app.json");
  expect(()=>client.writeSync(".obsidian/app.json","{}")).toThrow();
});

it("metadata inspection does not adopt a newer revision or clear a write conflict",async()=>{
  const {client,calls} = synchronousClient([{data:settings(1)},{data:settings(8)},{status:409,data:{code:"PREFERENCES_CONFLICT"}},{data:settings(9)}]);
  client.readSync(".obsidian/app.json");
  expect(client.inspectSync(".obsidian/app.json").revision).toBe(8);
  expect(()=>client.writeSync(".obsidian/app.json","{}")).toThrow();
  expect(JSON.parse(calls[2].body).expectedRevision).toBe(1);
  client.inspectSync(".obsidian/app.json");
  request.mockResolvedValueOnce(response(settings(10)));
  await client.inspect(".obsidian/app.json");
  await expect(client.write(".obsidian/app.json","{}")).rejects.toMatchObject({code:"CONFIGURATION_READ_REQUIRED"});
});
