import { it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {openDatabase}=require('./database');
const {createRegisteredVault}=require('./vault-creation');
const {createUserDeletionService}=require('./user-deletion');
let db,root,service,lifecycle,current;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-user-delete-'));
 fs.mkdirSync(path.join(root,'vaults'));
 db=openDatabase(path.join(root,'data'));
 db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('admin','admin','admin',0),('target','target','user',0),('other','other','user',0)");
 current=true;lifecycle={quiesce:async()=>{},invalidate:()=>{}};
 service=createUserDeletionService(db,path.join(root,'vaults'),lifecycle);
});
afterEach(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
const live=()=>current;
function vault(owner,name){return createRegisteredVault(db,path.join(root,'vaults'),owner,name,{isCurrent:()=>true});}
function input(deleteVaults=false){const p=service.plan('admin','target',live);return {userId:'target',revision:p.revision,confirmLogin:p.login,deleteVaults};}
it('deletes credentials, provider links and memberships but preserves foreign vaults and their files',async()=>{
 const v=vault('other','Foreign');fs.writeFileSync(path.join(v.path,'note.md'),'keep');
 db.prepare("INSERT INTO memberships VALUES (?,'target','editor')").run(v.id);
 db.exec("INSERT INTO local_credentials VALUES ('target','hash',0); INSERT INTO oidc_identities VALUES ('https://id.example','subject','target',0)");
 expect(await service.remove('admin',input(),live)).toEqual({ok:true});
 expect(db.prepare("SELECT * FROM users WHERE id='target'").get()).toBeUndefined();
 expect(db.prepare('SELECT * FROM local_credentials').all()).toEqual([]);
 expect(db.prepare('SELECT * FROM oidc_identities').all()).toEqual([]);
 expect(fs.readFileSync(path.join(v.path,'note.md'),'utf8')).toBe('keep');
 expect(db.prepare("SELECT action FROM audit_events WHERE action='delete-user'").get()).toBeTruthy();
});
it('blocks owned vaults without consent and rejects forged confirmation or stale scope without disabling',async()=>{
 vault('target','Owned');
 await expect(service.remove('admin',input(),live)).rejects.toMatchObject({code:'OWNED_VAULTS'});
 await expect(service.remove('admin',{...input(true),confirmLogin:'other'},live)).rejects.toMatchObject({code:'USER_STATE_CHANGED'});
 const old=input(true);vault('target','New');
 await expect(service.remove('admin',old,live)).rejects.toMatchObject({code:'USER_STATE_CHANGED'});
 expect(db.prepare("SELECT status FROM users WHERE id='target'").get().status).toBe('active');
 expect(db.prepare('SELECT * FROM user_deletions').all()).toEqual([]);
});
it('deletes owned shared vaults and cascades grants while retaining recipients and foreign vaults',async()=>{
 const a=vault('target','Owned'),b=vault('target','Second'),foreign=vault('other','Foreign');
 db.prepare("INSERT INTO memberships VALUES (?,'other','editor')").run(a.id);
 fs.writeFileSync(path.join(a.path,'note.md'),'deleted');
 const stat=fs.statSync(path.join(a.path,'note.md'));
 db.prepare("INSERT INTO shared_resources(id,vault_id,path,kind,device,inode) VALUES ('share',?,'note.md','file',?,?)").run(a.id,String(stat.dev),`${stat.ino}:${stat.birthtimeMs}`);
 db.exec("INSERT INTO resource_grants VALUES ('share','other','reader')");
 expect((await service.remove('admin',input(true),live)).ok).toBe(true);
 for(const v of [a,b])expect(fs.existsSync(v.path)).toBe(false);
 expect(fs.existsSync(foreign.path)).toBe(true);
 expect(db.prepare('SELECT * FROM resource_grants').all()).toEqual([]);
 expect(db.prepare("SELECT * FROM users WHERE id='other'").get()).toBeTruthy();
 expect(db.prepare("SELECT count(*) n FROM vault_deletions WHERE state='purged'").get().n).toBe(2);
});
it.each(['other',null,'missing'])('rejects unauthorized operator %s',async actor=>{
 await expect(service.remove(actor,input(),live)).rejects.toMatchObject({code:'SESSION_CHANGED'});
});
it('rejects self deletion and expired authentication without changing data',async()=>{
 expect(()=>service.plan('admin','admin',live)).toThrow();
 const request=input();current=false;
 await expect(service.remove('admin',request,live)).rejects.toMatchObject({code:'SESSION_CHANGED'});
 expect(db.prepare('SELECT count(*) n FROM users').get().n).toBe(3);
});
it('retains disabled account and persistent progress after partial failure; resumes without deleting replacements',async()=>{
 vault('target','One');vault('target','Two');
 let calls=0;lifecycle.assertReady=()=>{if(++calls===3)throw new Error('simulated busy vault');};
 const result=await service.remove('admin',input(true),live);
 expect(result.code).toBe('DELETE_INCOMPLETE');
 expect(db.prepare("SELECT status FROM users WHERE id='target'").get().status).toBe('disabled');
 expect(db.prepare("SELECT count(*) n FROM vault_deletions WHERE state='purged'").get().n).toBe(1);
 expect(()=>db.exec("UPDATE users SET status='active' WHERE id='target'")).toThrow();
 const retired=db.prepare("SELECT source FROM vault_deletions WHERE state='purged'").get().source;
 const replacement=vault('other',retired);
 db.close();db=openDatabase(path.join(root,'data'));
 service=createUserDeletionService(db,path.join(root,'vaults'),{quiesce:async()=>{},invalidate:()=>{}});
 expect((await service.remove('admin',input(true),live)).ok).toBe(true);
 expect(fs.existsSync(replacement.path)).toBe(true);
});
it('stops on administrator revocation during drain, leaving an inaccessible quarantined vault',async()=>{
 const v=vault('target','Owned');lifecycle.quiesce=async()=>{current=false;};
 const result=await service.remove('admin',input(true),live);
 expect(result).toEqual({ok:false,code:'DELETE_INCOMPLETE',reason:'SESSION_CHANGED'});
 expect(fs.existsSync(v.path)).toBe(true);
 expect(db.prepare('SELECT status FROM vaults WHERE id=?').get(v.id).status).toBe('quarantine');
 expect(db.prepare("SELECT status FROM users WHERE id='target'").get().status).toBe('disabled');
});
it('rolls back preparation when auditing fails',async()=>{
 db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'failure'); END");
 await expect(service.remove('admin',input(),live)).rejects.toThrow();
 expect(db.prepare("SELECT status FROM users WHERE id='target'").get().status).toBe('active');
 expect(db.prepare('SELECT * FROM user_deletions').all()).toEqual([]);
});
it('does not delete user when final audit fails and permits an explicit retry',async()=>{
 db.exec("CREATE TRIGGER fail_final BEFORE INSERT ON audit_events WHEN NEW.action='delete-user' BEGIN SELECT RAISE(ABORT,'failure'); END");
 expect((await service.remove('admin',input(),live)).code).toBe('DELETE_INCOMPLETE');
 expect(db.prepare("SELECT * FROM users WHERE id='target'").get()).toBeTruthy();
 db.exec('DROP TRIGGER fail_final');
 expect((await service.remove('admin',input(true),live)).ok).toBe(true);
});
it('refuses duplicate destructive requests while a drain is pending',async()=>{
 vault('target','Owned');let release;
 lifecycle.quiesce=()=>new Promise(resolve=>{release=resolve;});
 const first=service.remove('admin',input(true),live);
 await expect(service.remove('admin',input(true),live)).rejects.toMatchObject({code:'DELETE_BUSY'});
 release();expect((await first).ok).toBe(true);
});
it('can delete another administrator but neither the operator nor the last admin through SQL',async()=>{
 db.exec("UPDATE users SET role='admin' WHERE id='target'");
 expect((await service.remove('admin',input(),live)).ok).toBe(true);
 expect(()=>db.exec("DELETE FROM users WHERE id='admin'")).toThrow();
 expect(()=>service.plan('admin','admin',live)).toThrow();
});
it('invalidates real sessions, CSRF tokens, reset secrets and recipient placements',async()=>{
 const {createSessionService}=require('./sessions');
 const {hashPassword}=require('./password');
 const {issuePasswordReset}=require('./password-reset');
 db.prepare("INSERT INTO local_credentials VALUES ('target',?,0)").run(await hashPassword('synthetic-local-password'));
 const sessions=createSessionService(db);
 const login=await sessions.loginLocal('target','synthetic-local-password');
 const resolved=sessions.resolve(login.token);
 db.prepare("INSERT INTO csrf_tokens VALUES ('hash',?, ?, ?)").run(Buffer.from('browser'),resolved.id,Date.now()+10000);
 const foreign=vault('other','Foreign');
 db.prepare("INSERT INTO memberships VALUES (?,'target','reader')").run(foreign.id);
 db.prepare("INSERT INTO shared_resources(id,vault_id,path,kind,device,inode) VALUES ('r',?,'note.md','file','1','1')").run(foreign.id);
 db.exec("INSERT INTO resource_grants VALUES ('r','target','reader')");
 db.prepare("INSERT INTO resource_destinations(resource_id,user_id,vault_id,local_path) VALUES ('r','target',?,'Received.md')").run(foreign.id);
 expect((await service.remove('admin',input(),live)).ok).toBe(true);
 expect(sessions.resolve(login.token)).toBeNull();
 expect(db.prepare('SELECT * FROM csrf_tokens').all()).toEqual([]);
 expect(db.prepare('SELECT * FROM resource_destinations').all()).toEqual([]);
 expect(db.prepare('SELECT * FROM resource_grants').all()).toEqual([]);
 // Separate account ensures outstanding reset records also cascade.
 db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('target','target','user',0)");
 db.prepare("INSERT INTO local_credentials VALUES ('target',?,0)").run(await hashPassword('another-synthetic-password'));
 issuePasswordReset(db,'admin','target',{isCurrent:()=>true});
 expect(db.prepare('SELECT * FROM password_resets').all()).toHaveLength(1);
 expect((await service.remove('admin',input(),live)).ok).toBe(true);
 expect(db.prepare('SELECT * FROM password_resets').all()).toEqual([]);
});
it('rejects editing an account whose deletion is in progress',async()=>{
 db.exec("INSERT INTO user_deletions VALUES ('target','[]',0); UPDATE users SET status='disabled' WHERE id='target'");
 expect(()=>require('./users').changeUserStatus(db,'admin','target','active','disabled',{isCurrent:()=>true}))
  .toThrowError(expect.objectContaining({code:'USER_DELETION_IN_PROGRESS'}));
});
it('does not expand normal vault deletion to an administrator without a deletion job',async()=>{
 const v=vault('target','Owned');
 const {deleteRegisteredVault}=require('./vault-deletion');
 await expect(deleteRegisteredVault(db,path.join(root,'vaults'),'admin',v.id,{...lifecycle,isCurrent:live})).rejects.toMatchObject({code:'VAULT_UNAVAILABLE'});
 await expect(deleteRegisteredVault(db,path.join(root,'vaults'),'admin',v.id,{...lifecycle,isCurrent:live,deletingUser:'target'})).rejects.toMatchObject({code:'SESSION_CHANGED'});
 expect(fs.existsSync(v.path)).toBe(true);
 db.exec("INSERT INTO user_deletions VALUES ('target','[]',0); UPDATE users SET status='disabled' WHERE id='target'");
 await expect(deleteRegisteredVault(db,path.join(root,'vaults'),'admin',v.id,{...lifecycle,isCurrent:live,deletingUser:'target'})).rejects.toMatchObject({code:'SESSION_CHANGED'});
});
