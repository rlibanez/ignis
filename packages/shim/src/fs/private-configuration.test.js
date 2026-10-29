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
