import {it,expect,beforeEach,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {openDatabase}=require('../../../platform/persistence/database');
const {registerExistingVault}=require('../../../auth/fixtures/vault.cjs');
const {createContentRuntime}=require('./runtime');
const hash=text=>createHash('sha256').update(text).digest('hex');
let root,db,vault,filename,io,service,session;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-content-publication-'));fs.mkdirSync(path.join(root,'owner/Notes'),{recursive:true});
 filename=path.join(root,'owner/Notes/note.md');fs.writeFileSync(filename,'original');
 db=openDatabase(path.join(root,'data'));db.prepare("INSERT INTO users(id,login,role,created_at) VALUES ('owner','owner','user',0)").run();
 vault=registerExistingVault(db,root,'Notes','owner');io={...fs};
 session={id:'s',user:{id:'owner',role:'user',authVersion:1}};
 service=createContentRuntime({db,root,sessions:{resolve:()=>session},io});
});
afterEach(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
const write=(text='changed',expected=hash('original'))=>service.writeOriginal('token',vault.id,'note.md',Buffer.from(text),expected);
it('rechecks the version after staging and does not overwrite a concurrent publication',async()=>{
 let first=true;io.fsyncSync=fd=>{fs.fsyncSync(fd);if(first){first=false;fs.writeFileSync(filename,'concurrent');}};
 await expect(write()).rejects.toMatchObject({code:'CONTENT_CONFLICT',outcome:'conflict'});
 expect(fs.readFileSync(filename,'utf8')).toBe('concurrent');expect(fs.readdirSync(path.dirname(filename))).toEqual(['note.md']);
});
it('rechecks membership after staging immediately before publication',async()=>{
 let first=true;io.fsyncSync=fd=>{fs.fsyncSync(fd);if(first){first=false;db.prepare("DELETE FROM memberships WHERE user_id='owner'").run();}};
 await expect(write()).rejects.toMatchObject({code:'SHARE_UNAVAILABLE',outcome:'denied'});
 expect(fs.readFileSync(filename,'utf8')).toBe('original');
});
it('does not reuse authorization after the session changes while preparing bytes',async()=>{
 let first=true;io.fsyncSync=fd=>{fs.fsyncSync(fd);if(first){first=false;session={...session,id:'replacement'};}};
 await expect(write()).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});expect(fs.readFileSync(filename,'utf8')).toBe('original');
});
it.each(['ENOSPC','EACCES'])('preserves originals on %s before publication',async code=>{
 io.writeSync=()=>{throw Object.assign(new Error('Synthetic disk failure'),{code});};
 await expect(write()).rejects.toMatchObject({code});expect(fs.readFileSync(filename,'utf8')).toBe('original');
 expect(fs.readdirSync(path.dirname(filename))).toEqual(['note.md']);
});
it('reports uncertain, never failed, when directory sync fails after rename',async()=>{
 let count=0;io.fsyncSync=fd=>{if(++count===2)throw Object.assign(new Error('Synthetic sync failure'),{code:'EIO'});fs.fsyncSync(fd);};
 await expect(write()).rejects.toMatchObject({code:'CONTENT_WRITE_UNCERTAIN',outcome:'uncertain'});
 expect(fs.readFileSync(filename,'utf8')).toBe('changed');
});
it('commits full bytes and preserves compare-and-swap/create-only semantics',async()=>{
 expect(await write()).toMatchObject({outcome:'committed',etag:hash('changed')});
 await expect(write('stale')).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 await expect(write('create',null)).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 expect(await service.writeOriginal('token',vault.id,'note.md',Buffer.from('plugin'))).toMatchObject({outcome:'committed'});
});

it.each(['append','copy'])('does not partially modify an original when %s staging runs out of space',async mode=>{
 fs.writeFileSync(path.join(root,'owner/Notes/source.md'),'source');
 io.writeSync=()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});};
 const operation=mode==='append'?service.appendOriginal('token',vault.id,'note.md',Buffer.from('tail')):service.copyOriginal('token',vault.id,'source.md','note.md');
 await expect(operation).rejects.toMatchObject({code:'ENOSPC',outcome:'failed'});
 expect(fs.readFileSync(filename,'utf8')).toBe('original');
 expect(fs.readdirSync(path.dirname(filename)).sort()).toEqual(['note.md','source.md']);
});
it('atomically appends, creates missing files and copies complete source bytes',async()=>{
 expect(await service.appendOriginal('token',vault.id,'note.md',Buffer.from(' tail'))).toMatchObject({etag:hash('original tail'),outcome:'committed'});
 expect(await service.copyOriginal('token',vault.id,'note.md','copy.md')).toMatchObject({etag:hash('original tail')});
 expect(await service.appendOriginal('token',vault.id,'new.md',Buffer.from('new'))).toMatchObject({etag:hash('new')});
 expect(fs.readFileSync(path.join(root,'owner/Notes/copy.md'),'utf8')).toBe('original tail');
});
it('does not publish a copy if its source changes during staging',async()=>{
 fs.writeFileSync(path.join(root,'owner/Notes/source.md'),'source');let first=true;
 io.fsyncSync=fd=>{fs.fsyncSync(fd);if(first){first=false;fs.writeFileSync(path.join(root,'owner/Notes/source.md'),'changed');}};
 await expect(service.copyOriginal('token',vault.id,'source.md','note.md')).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 expect(fs.readFileSync(filename,'utf8')).toBe('original');
});
