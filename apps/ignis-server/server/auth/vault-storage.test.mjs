import {beforeEach,afterEach,it,expect} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {openDatabase}=require('../platform/persistence/database');
const {createRegisteredVault}=require('../features/vaults/adapters/vault-creation');
const {resolveRegisteredVault}=require('../features/vaults/adapters/vault-catalog');
const {renameRegisteredVault}=require('../features/vaults/adapters/vault-rename');
const {deleteRegisteredVault}=require('../features/vaults/adapters/vault-deletion');
const {createVaultMembersService}=require('../features/vaults/adapters/vault-members');
const {createVaultAccessService}=require('../features/vaults/adapters/vault-access');
const {createVaultImport}=require('../features/vaults/adapters/vault-import');
const {validDirectory}=require('../features/vaults/application/vault-name');
let temp,root,db,sessions,importer,access,active;
const lifecycle={quiesce:async()=>{},invalidate:()=>{}};
const create=(user,name='Personal')=>createRegisteredVault(db,root,user,name,{isCurrent:()=>true});
beforeEach(()=>{
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-user-vaults-'));root=path.join(temp,'vaults');fs.mkdirSync(root);db=openDatabase(path.join(temp,'data'));
 for(const id of ['alice','bob','admin'])db.prepare('INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)').run(id,id,id==='admin'?'admin':'user');
 active=true;sessions={resolve:token=>active&&['alice','bob','admin'].includes(token)?{id:'session-'+token,user:{id:token,role:token==='admin'?'admin':'user',authVersion:1}}:null};
 importer=createVaultImport({db,root,dataRoot:path.join(temp,'data'),sessions});access=createVaultAccessService(db,root,sessions);
});
afterEach(()=>{importer.close();db.close();fs.rmSync(temp,{recursive:true,force:true});});
const read=reference=>({reference,capability:'content.read',path:'Note.md'});
it('allows the same readable name in separate user directories, with distinct stable UUIDs and isolated permissions',()=>{
 const a=create('alice'),b=create('bob');
 expect(a.path).toBe(path.join(root,'alice/Personal'));expect(b.path).toBe(path.join(root,'bob/Personal'));expect(a.id).not.toBe(b.id);
 for(const [user,vault]of [['alice',a],['bob',b]]){expect(access.check(user,read(vault.id)).allowed).toBe(true);expect(access.check(user==='alice'?'bob':'alice',read(vault.id)).allowed).toBe(false);expect(access.check('admin',read(vault.id)).allowed).toBe(false);}
 expect(()=>create('alice')).toThrow(expect.objectContaining({code:'VAULT_EXISTS'}));
 expect(()=>resolveRegisteredVault(db,root,'Personal')).toThrow();
 db.close();db=openDatabase(path.join(temp,'data'));expect(resolveRegisteredVault(db,root,'alice/Personal').id).toBe(a.id);
});
it('imports equal names for different users and checks collisions only in the importing account',async()=>{
 async function imported(user){const scope=importer.scope(user),draft=await scope.begin({name:'Imported',configuration:false,files:[{path:'Note.md',size:3}]});await scope.put(draft.id,0,Buffer.from(user==='alice'?'one':'two'));return scope.commit(draft.id);}
 const a=await imported('alice'),b=await imported('bob');expect(a.id).not.toBe(b.id);
 expect(fs.readFileSync(path.join(root,'alice/Imported/Note.md'),'utf8')).toBe('one');expect(fs.readFileSync(path.join(root,'bob/Imported/Note.md'),'utf8')).toBe('two');
 await expect(imported('alice')).rejects.toMatchObject({code:'VAULT_EXISTS'});
});
it('renames inside the owner namespace while retaining identity and grants',async()=>{
 const a=create('alice'),b=create('bob','Renamed');db.prepare("INSERT INTO memberships VALUES (?,?,'reader')").run(a.id,'bob');
 const moved=await renameRegisteredVault(db,root,'alice',a.id,'Renamed',{...lifecycle,isCurrent:()=>true});
 expect(moved.directory).toBe('alice/Renamed');expect(moved.id).toBe(a.id);expect(resolveRegisteredVault(db,root,b.id).directory).toBe('bob/Renamed');expect(access.check('bob',read(a.id)).allowed).toBe(true);
 expect(()=>resolveRegisteredVault(db,root,'alice/Personal')).toThrow();
});
it('moves ownership to the new owner directory while preserving UUID, contents and other memberships',async()=>{
 const vault=create('alice');fs.writeFileSync(path.join(vault.path,'Note.md'),'preserved');db.prepare("INSERT INTO memberships VALUES (?,'bob','reader'),(?,'admin','reader')").run(vault.id,vault.id);
 const service=createVaultMembersService(db,root,sessions);
 await service.transfer('alice',{vault:vault.id,userId:'bob',expectedRole:'reader',revision:1,confirm:true},lifecycle);
 expect(resolveRegisteredVault(db,root,vault.id).directory).toBe('bob/Personal');expect(fs.existsSync(vault.path)).toBe(false);expect(fs.readFileSync(path.join(root,'bob/Personal/Note.md'),'utf8')).toBe('preserved');
 expect(access.check('alice',{...read(vault.id),capability:'content.write'}).allowed).toBe(true);expect(access.check('admin',read(vault.id)).allowed).toBe(true);
});
it('refuses ownership transfer on destination collision without moving files or changing permissions',async()=>{
 const a=create('alice'),b=create('bob');db.prepare("INSERT INTO memberships VALUES (?,'bob','reader')").run(a.id);
 await expect(createVaultMembersService(db,root,sessions).transfer('alice',{vault:a.id,userId:'bob',expectedRole:'reader',revision:1,confirm:true},lifecycle)).rejects.toMatchObject({code:'VAULT_EXISTS'});
 expect(resolveRegisteredVault(db,root,a.id).directory).toBe('alice/Personal');expect(resolveRegisteredVault(db,root,b.id).directory).toBe('bob/Personal');expect(db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id='alice'").get(a.id).role).toBe('owner');
});
it('revalidates ownership transfer after watcher shutdown and quarantines uncertainty without publishing new roles',async()=>{
 const a=create('alice');db.prepare("INSERT INTO memberships VALUES (?,'bob','reader')").run(a.id);
 await expect(createVaultMembersService(db,root,sessions).transfer('alice',{vault:a.id,userId:'bob',expectedRole:'reader',revision:1,confirm:true},{...lifecycle,quiesce:async()=>{active=false;}})).rejects.toThrow();
 expect(fs.existsSync(a.path)).toBe(true);expect(fs.existsSync(path.join(root,'bob/Personal'))).toBe(false);expect(db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id='alice'").get(a.id).role).toBe('owner');
});
it('deletes only the selected vault, preserving a namesake owned by another account',async()=>{
 const a=create('alice'),b=create('bob');fs.writeFileSync(path.join(b.path,'Note.md'),'keep');
 await deleteRegisteredVault(db,root,'alice',a.id,{...lifecycle,isCurrent:()=>true});expect(fs.existsSync(a.path)).toBe(false);expect(resolveRegisteredVault(db,root,b.id).id).toBe(b.id);expect(fs.readFileSync(path.join(b.path,'Note.md'),'utf8')).toBe('keep');
});
it.each(['outside','inside'])('rejects symlinked user namespaces pointing %s the root',async kind=>{
 const a=create('alice');const target=kind==='inside'?path.join(root,'alice'):path.join(temp,'outside');if(kind==='outside')fs.mkdirSync(target);
 fs.symlinkSync(target,path.join(root,'bob'));
 expect(()=>create('bob')).toThrow();await expect(importer.scope('bob').begin({name:'Imported',configuration:false,files:[]})).rejects.toThrow();
 expect(resolveRegisteredVault(db,root,a.id).directory).toBe('alice/Personal');expect(fs.existsSync(path.join(target,'Imported'))).toBe(false);
});
it('refuses a replaced parent even when the replacement points back to the original files',()=>{
 const a=create('alice');fs.renameSync(path.join(root,'alice'),path.join(root,'saved'));fs.symlinkSync(path.join(root,'saved'),path.join(root,'alice'));
 expect(()=>resolveRegisteredVault(db,root,a.id)).toThrow();expect(access.check('alice',read(a.id)).allowed).toBe(false);
});
it('does not adopt folders copied into user namespaces or overwrite them on creation/import',async()=>{
 fs.mkdirSync(path.join(root,'alice/Personal/.obsidian'),{recursive:true});fs.writeFileSync(path.join(root,'alice/Personal/Note.md'),'unregistered');
 expect(access.check('alice',read('alice/Personal')).allowed).toBe(false);expect(()=>create('alice')).toThrow();await expect(importer.scope('alice').begin({name:'Personal',configuration:false,files:[]})).rejects.toMatchObject({code:'VAULT_EXISTS'});expect(db.prepare('SELECT count(*) n FROM vaults').get().n).toBe(0);
});
it.each(['../bob/Notes','alice/../Notes','alice/Notes/child','/alice/Notes','alice//Notes','alice\\Notes','Alice/Notes','.alice/Notes','alice/.hidden'])('rejects noncanonical storage path %j',value=>{expect(validDirectory(value)).toBe(false);expect(()=>resolveRegisteredVault(db,root,value)).toThrow();});
it('removes obsolete registration surfaces instead of exposing another incorporation path',()=>{
 const {dataRoutePolicy}=require('./route-manifest');expect(dataRoutePolicy('GET','/api/vault/registration')).toBeNull();expect(dataRoutePolicy('POST','/api/vault/register')).toBeNull();
});

it('never publishes new ownership if auditing fails after the directory move',async()=>{
 const a=create('alice');fs.writeFileSync(path.join(a.path,'Note.md'),'keep');db.prepare("INSERT INTO memberships VALUES (?,'bob','reader')").run(a.id);
 db.exec("CREATE TRIGGER fail_transfer_final BEFORE INSERT ON audit_events WHEN NEW.action='transfer-vault-ownership' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 await expect(createVaultMembersService(db,root,sessions).transfer('alice',{vault:a.id,userId:'bob',expectedRole:'reader',revision:1,confirm:true},lifecycle)).rejects.toThrow();
 expect(db.prepare('SELECT status FROM vaults WHERE id=?').get(a.id).status).toBe('quarantine');expect(db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id='alice'").get(a.id).role).toBe('owner');
 expect(fs.readFileSync(path.join(root,'bob/Personal/Note.md'),'utf8')).toBe('keep');expect(access.check('bob',read(a.id)).allowed).toBe(false);
 expect(()=>create('bob')).toThrow();expect(()=>create('alice')).toThrow();
});
it('refuses a target user-directory replacement while watcher shutdown is pending',async()=>{
 const a=create('alice');db.prepare("INSERT INTO memberships VALUES (?,'bob','reader')").run(a.id);const outside=path.join(temp,'outside');fs.mkdirSync(outside);
 await expect(createVaultMembersService(db,root,sessions).transfer('alice',{vault:a.id,userId:'bob',expectedRole:'reader',revision:1,confirm:true},{...lifecycle,quiesce:async()=>{fs.rmdirSync(path.join(root,'bob'));fs.symlinkSync(outside,path.join(root,'bob'));}})).rejects.toThrow();
 expect(fs.existsSync(a.path)).toBe(true);expect(fs.readdirSync(outside)).toEqual([]);
});
it('retains shared-resource identities and contents across an ownership move',async()=>{
 const a=create('alice');fs.writeFileSync(path.join(a.path,'Note.md'),'shared');db.prepare("INSERT INTO memberships VALUES (?,'bob','reader')").run(a.id);
 const shares=require('../features/sharing/adapters/resource-shares').createResourceSharesService(db,root,sessions);
 const shared=shares.create('alice',{vault:a.id,path:'Note.md',login:'admin',role:'reader'});
 await createVaultMembersService(db,root,sessions).transfer('alice',{vault:a.id,userId:'bob',expectedRole:'reader',revision:1,confirm:true},lifecycle);
 expect(access.check('admin',read(a.id)).allowed).toBe(false);expect(Buffer.from((await shares.read('admin',{id:shared.id,path:''})).content,'base64').toString()).toBe('shared');
 expect(db.prepare('SELECT vault_id FROM shared_resources WHERE id=?').get(shared.id).vault_id).toBe(a.id);
});
it('builds the runtime catalog only from valid active registrations, never from copied folders',()=>{
 const store=require('../features/vaults/adapters/vault-store').createVaultStore(db,root,sessions);
 fs.mkdirSync(path.join(root,'alice/Manual/.obsidian'),{recursive:true});expect(Object.keys(store.catalog())).toEqual([]);
 const a=create('alice');expect(Object.keys(store.catalog())).toEqual(['alice/Personal']);db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(a.id);expect(Object.keys(store.catalog())).toEqual([]);
});
