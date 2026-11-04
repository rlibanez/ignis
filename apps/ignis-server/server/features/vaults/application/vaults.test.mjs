import {beforeEach,afterEach,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(import.meta.url);
const {openDatabase}=require('../../../platform/persistence/database');
const {createVaultStore}=require('../adapters/vault-store');
const {createVaultAccessService}=require('../adapters/vault-access');
const {createVaultView}=require('../adapters/vault-view');
const {createVaults}=require('./vaults');
let root,db,app,active,owner,admin;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-vault-use-cases-'));
 db=openDatabase(path.join(root,'data'));active=true;
 for(const [id,role]of [['owner','user'],['admin','admin']])db.prepare('INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)').run(id,id,role);
 const session=(id,role)=>({id:'session-'+id,user:{id,role,authVersion:1}});
 owner=session('owner','user');admin=session('admin','admin');
 const sessions={resolve:token=>active ? ({owner,admin}[token]||null) : null};
 app=createVaults({store:createVaultStore(db,root,sessions),sessions,access:createVaultAccessService(db,root,sessions),createView:createVaultView});
});
afterEach(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
it('supports no vaults, creates with explicit ownership and denies admin content without membership',()=>{
 const scope=app.scope('owner');expect(scope.view.list([])).toEqual([]);
 const vault=scope.create('Notes');expect(scope.uuid('Notes')).toBe(vault.id);
 expect(scope.check(vault.id)).toBe(true);expect(app.scope('admin').check(vault.id)).toBe(false);
 expect(()=>app.scope('admin').resolve(vault.id)).toThrow();
 expect(()=>scope.owners()).toThrow();expect(()=>scope.registrationOptions()).toThrow();
 expect(()=>app.scope('invalid')).toThrow();
});
it('pins session identity for every operation, including delayed lifecycle callbacks',()=>{
 const scope=app.scope('owner');const vault=scope.create('Notes');
 owner={...owner,id:'replacement'};
 expect(()=>scope.create('Other')).toThrow();expect(()=>scope.resolve(vault.id)).toThrow();
 expect(()=>scope.rename(vault.id,'Renamed',{})).toThrow();expect(()=>scope.delete(vault.id,{})).toThrow();
 expect(fs.existsSync(path.join(root,'Notes'))).toBe(true);
 expect(fs.existsSync(path.join(root,'Other'))).toBe(false);
});
it('revalidates memberships and never opens a different or unregistered vault',()=>{
 const scope=app.scope('owner'),vault=scope.create('Notes');fs.mkdirSync(path.join(root,'Unregistered'));
 expect(()=>scope.resolveRequest({vault:'Unregistered'},{})).toThrow();
 expect(scope.resolveRequest({vault:vault.id},{vault:'Notes'})).toBe('Notes');
 expect(scope.view.select('missing',{candidates:['Notes'],allowDefault:true})).toBeNull();
 db.prepare('DELETE FROM memberships WHERE vault_id=?').run(vault.id);
 expect(scope.check(vault.id)).toBe(false);expect(scope.view.list([{id:'Notes'}])).toEqual([]);
});
it('does not let an old admin scope register after a session or role change',()=>{
 const scope=app.scope('admin');fs.mkdirSync(path.join(root,'Existing'));
 const identity=scope.registrationOptions().vaults.find(v=>v.directory==='Existing').identity;
 admin={...admin,user:{...admin.user,role:'user',authVersion:2}};
 expect(()=>scope.register('Existing','owner',identity)).toThrow();
 expect(db.prepare('SELECT count(*) n FROM vaults').get().n).toBe(0);
});
it('fresh schemas have no retired private configuration storage',()=>{
 expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='vault_preferences'").get()).toBeUndefined();
});

it('revalidates projected reads by UUID before response even after alias replacement',()=>{
 const scope=app.scope('owner'),vault=scope.create('Notes');
 expect(scope.view.list([{id:'Notes',name:'Notes'}])).toHaveLength(1);
 expect(scope.revalidateView()).toBe(true);
 db.prepare('DELETE FROM vaults WHERE id=?').run(vault.id);
 const adminScope=app.scope('admin');
 const identity=adminScope.registrationOptions().vaults.find(v=>v.directory==='Notes').identity;
 const replacement=adminScope.register('Notes','owner',identity);
 expect(replacement.id).not.toBe(vault.id);
 expect(scope.revalidateView()).toBe(false);
});
