import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from "node:zlib";
const require = createRequire(import.meta.url);

it("projects shared configuration without leaking other vaults or server code through compressed caches", async () => {
  const config = require("../config");
  const cache = require("../cache");
  const savedConfig = { refreshVaults: config.refreshVaults, getVaultPathOrRescan: config.getVaultPathOrRescan, getVaultPath: config.getVaultPath };
  const savedCache = { getOrBuild: cache.getOrBuild, getOrCompress: cache.getOrCompress };
  const shared = { response: { tree: {}, vault: {id:"Notes",path:"/vaults/Notes"}, vaultList:[{id:"Notes"},{id:"Other"}],plugins:["shared-plugin"],virtualPlugins:["shared-code"],etag:"shared-etag" }, compressed: {gz:Buffer.from("shared cached bytes")} };
  const original = structuredClone(shared);
  Object.assign(config,{ refreshVaults() {}, getVaultPathOrRescan:()=>"/vaults/Notes", getVaultPath:()=>"/vaults/Notes" });
  Object.assign(cache,{
    getOrBuild:async()=>shared,
    getOrCompress:async entry=> {
      expect(entry).not.toBe(shared);
      expect(entry.compressed).toEqual({});
      const data = Buffer.from(JSON.stringify(entry.response));
      return {gz:gzipSync(data),br:brotliCompressSync(data)};
    },
  });
  const modulePath = require.resolve("./bootstrap");
  delete require.cache[modulePath];
  try {
    const router = require("./bootstrap");
    const handler = router.stack[0].route.stack[0].handle;
    for (const encoding of ["", "gzip", "br"]) {
      for (const user of ["alice","bob","admin"]) {
        let result;
        const headers = {};
        const req = {query:{vault:"Notes"},headers:{"accept-encoding":encoding},vaultUUID:()=>"uuid",privateVaultConfiguration:()=>({owner:user})};
        req.vaultView = require("../auth/vault-view").createVaultView({
          administrator:user === "admin", authorize:id=>id === "Notes", uuid:()=>"uuid",
        });
        const res = {setHeader:(key,value)=>{headers[key]=value;},status:()=>res,json:value=>{result=value;},end:bytes=>{result=JSON.parse((encoding==="br"?brotliDecompressSync(bytes):gunzipSync(bytes)).toString());}};
        await handler(req,res);
        expect(result.privateConfiguration).toBeUndefined();
        if (user === "admin") {
          expect(result.vaultList).toHaveLength(1);
          expect(result.plugins).toEqual(["shared-plugin"]);
        } else {
          expect(result.vaultList).toEqual([{id:"Notes",uuid:"uuid"}]);
          expect(result.vault.path).toBe("/");
          expect(result.configurationMode).toBe("shared");
          expect(JSON.stringify(result)).not.toMatch(/Other|shared-plugin|shared-code|shared-etag|\/vaults/);
        }
        expect(headers["Cache-Control"]).toBe("no-store");
        expect(shared.response).toEqual(original.response);
        expect(shared.compressed.gz).toEqual(Buffer.from("shared cached bytes"));
      }
    }
  } finally {
    Object.assign(config,savedConfig);
    Object.assign(cache,savedCache);
    delete require.cache[modulePath];
  }
});
