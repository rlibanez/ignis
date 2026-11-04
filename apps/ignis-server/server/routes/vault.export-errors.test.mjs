import {it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
it('keeps the completed download and server alive when the export disposer rejects',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-export-http-'));
 process.env.DATA_ROOT=path.join(root,'data');process.env.VAULT_ROOT=path.join(root,'vaults');
 const express=require('express'),router=require('./vault');
 const {protectRouter}=require('../transport/http/protect-router');
 const logging=require('@ignis/server-core/src/logger'),log=vi.spyOn(logging,'emit').mockImplementation(()=>{});
 const file=path.join(root,'synthetic.zip');fs.writeFileSync(file,'synthetic archive');
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{
  req.exportVault=async()=>({file,name:'vault.zip',validate(){},dispose:async()=>{throw Object.assign(Error('private filesystem path'),{code:'EIO'});}});
  next();
 });
 app.use('/api/vault',protectRouter(router));
 app.get('/health',(req,res)=>res.json({ok:true}));
 app.use((error,req,res,next)=>{if(res.headersSent)res.destroy();else res.status(500).end();});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/vault/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vault:'own',configuration:false})});
  expect(response.status).toBe(200);expect(await response.text()).toBe('synthetic archive');
  await expect.poll(()=>log.mock.calls.some(([,event])=>event==='server.vault.export_cleanup_failed')).toBe(true);
  expect(log).toHaveBeenCalledWith('warn','server.vault.export_cleanup_failed',{errorCode:'EIO'});
  expect(await(await fetch(base+'/health')).json()).toEqual({ok:true});
 }finally{log.mockRestore();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
