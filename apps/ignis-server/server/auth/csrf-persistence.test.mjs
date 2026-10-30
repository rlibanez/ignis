import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(import.meta.url),{openDatabase}=require('./database'),{createCsrf}=require('./csrf');
it('persists only hashes and retains expiry, browser/session binding, capacity and consumption after reopen',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-csrf-restart-'));let db=openDatabase(root),now=1000;
 const config={publicOrigin:'http://localhost:8080',allowHttpLoopback:true};
 try{
  let service=createCsrf(config,{db,now:()=>now,capacity:1}),cookie;
  const token=service.issue({headers:{}},{append:(_,value)=>cookie=value.split(';')[0]},{id:'one'});
  const req={headers:{cookie,'x-ignis-csrf':token}};
  expect(service.valid(req,{id:'one'})).toBe(true);expect(service.issue({headers:{}},{append(){}},{id:'two'})).toBe(null);
  const row=db.prepare('SELECT * FROM csrf_tokens').get();expect(row.token_hash).not.toBe(token);expect(row.browser_hash.length).toBe(32);
  db.close();db=openDatabase(root);service=createCsrf(config,{db,now:()=>now,capacity:1});
  expect(service.valid(req,{id:'one'})).toBe(true);expect(service.valid(req,{id:'two'})).toBe(false);
  expect(service.valid({headers:{...req.headers,cookie:cookie.replace(/=.*/,'='+ 'a'.repeat(64))}},{id:'one'})).toBe(false);
  service.consume(req);db.close();db=openDatabase(root);service=createCsrf(config,{db,now:()=>now,capacity:1});expect(service.valid(req,{id:'one'})).toBe(false);
  const expired=service.issue({headers:{}},{append:(_,value)=>cookie=value.split(';')[0]},{id:'one'});now+=600001;
  expect(service.valid({headers:{cookie,'x-ignis-csrf':expired}},{id:'one'})).toBe(false);
  expect(service.issue({headers:{}},{append(){}},{id:'one'})).toMatch(/^[a-f0-9]{64}$/);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
