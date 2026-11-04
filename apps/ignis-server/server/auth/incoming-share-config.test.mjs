import {it, expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const {readIncomingShareConfig, configureIncomingShareAsset} = require('./incoming-share-config');
const source = fs.readFileSync(new URL('./web/share-store.js', import.meta.url), 'utf8');
function runtime(config) {
  const assets = new Map([['/auth/share-store.js', {type:'text/javascript', content:Buffer.from(source)}]]);
  configureIncomingShareAsset(assets, config);
  const context = {}; vm.runInNewContext(assets.get('/auth/share-store.js').content, context);
  return context.IgnisIncoming;
}
it('validates startup limits and supports disabling automatic expiry', () => {
  expect(readIncomingShareConfig({})).toEqual({maxMiB:32, maxFiles:100, ttlMinutes:60});
  expect(readIncomingShareConfig({IGNIS_SHARE_MAX_MIB:'1024', IGNIS_SHARE_MAX_FILES:'1000', IGNIS_SHARE_TTL_MINUTES:'0'})).toEqual({maxMiB:1024, maxFiles:1000, ttlMinutes:0});
  for (const [key, values] of Object.entries({IGNIS_SHARE_MAX_MIB:['0','1025','1.5','32MB',''], IGNIS_SHARE_MAX_FILES:['0','1001','-1'], IGNIS_SHARE_TTL_MINUTES:['-1','525601','Infinity','60.5']}))
    for (const value of values) expect(() => readIncomingShareConfig({[key]:value})).toThrow(key);
});
it('publishes identical limits to window and worker code, including zero expiry', () => {
  const store = runtime(readIncomingShareConfig({IGNIS_SHARE_MAX_MIB:'64', IGNIS_SHARE_MAX_FILES:'5', IGNIS_SHARE_TTL_MINUTES:'0'}));
  expect(store.MAX_BYTES).toBe(64*1024*1024); expect(store.MAX_FILES).toBe(5); expect(store.TTL).toBe(0);
  expect(store.expired({createdAt:0, expiresAt:null}, Date.now())).toBe(false);
  expect(store.expired({createdAt:0}, Date.now())).toBe(true); // Legacy records used a one-hour deadline.
});
it('preserves per-share deadlines across configuration changes', () => {
  const store = runtime(readIncomingShareConfig({IGNIS_SHARE_TTL_MINUTES:'10'}));
  expect(store.expired({createdAt:0, expiresAt:1000}, 999)).toBe(false);
  expect(store.expired({createdAt:0, expiresAt:1000}, 1000)).toBe(true);
  expect(store.expired({createdAt:0, expiresAt:null}, Date.now())).toBe(false);
  expect(store.expired({createdAt:0}, 3600000)).toBe(true);
});
it('permits a full GiB without allocating a GiB-sized test buffer', () => {
  const config = readIncomingShareConfig({IGNIS_SHARE_MAX_MIB:'1024'});
  const store = runtime(config); expect(store.MAX_BYTES).toBe(1073741824);
});
it('parses binary uploads with content preconditions and enforces size even without Content-Length', async () => {
  const express = require('express');
  const {incomingBinaryParser} = require('./incoming-share-config');
  const {Readable} = require('node:stream');
  const app = express();
  app.use(incomingBinaryParser(readIncomingShareConfig({IGNIS_SHARE_MAX_MIB:'1'})));
  app.use(express.json());
  app.post('/api/fs/writeFile', (req,res) => res.json({path:req.body.path, version:req.body.expectedHash,
    binary:Buffer.isBuffer(req.body.content), bytes:[...req.body.content]}));
  const server = await new Promise(resolve => {const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  const base = `http://127.0.0.1:${server.address().port}/api/fs/writeFile?path=received.bin&vault=team`;
  try {
    const headers = {'Content-Type':'application/octet-stream', 'X-Ignis-Content-Version':'new'};
    const response = await fetch(base,{method:'POST',headers,body:Buffer.from([0,255,128,10])});
    expect(await response.json()).toEqual({path:'received.bin',version:null,binary:true,bytes:[0,255,128,10]});
    const hash = 'a'.repeat(64);
    expect((await (await fetch(base,{method:'POST',headers:{...headers,'X-Ignis-Content-Version':hash},body:Buffer.alloc(0)})).json()).version).toBe(hash);
    expect((await fetch(base,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:'x'})).status).toBe(400);
    expect((await fetch(base.replace('received.bin','.obsidian/config'),{method:'POST',headers,body:'x'})).status).toBe(400);
    const stream = Readable.from([Buffer.alloc(1024*1024),Buffer.from('x')]);
    expect((await fetch(base,{method:'POST',headers,body:stream,duplex:'half'})).status).toBe(413);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
