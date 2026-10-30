import {beforeEach,afterEach,it,expect} from "vitest";
import {createRequire} from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require=createRequire(import.meta.url);
const {openDatabase}=require("./database");
const {registerVault}=require("./store");
const {createVaultMembersService}=require("./vault-members");
let root,db,vault,service,active;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),"ignis-members-"));fs.mkdirSync(path.join(root,"Notes"));
 db=openDatabase(path.join(root,"data"));
 for(const id of ["owner","reader","editor","admin","target"])
  db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)").run(id,id,id==="admin"?"admin":"user");
 vault=registerVault(db,root,"Notes","owner");
 for(const id of ["reader","editor"]) db.prepare("INSERT INTO memberships VALUES (?,?,?)").run(vault.id,id,id);
 active=true;
 service=createVaultMembersService(db,root,{resolve:token=>active && ["owner","reader","editor","admin"].includes(token)?{user:{id:token}}:null});
});
afterEach(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
const change=(extra={})=>({vault:vault.id,login:"target",role:"reader",expectedRole:null,revision:1,...extra});
it("lets a normal owner add, update and remove a member, auditing each atomic change",()=>{
 const added=service.update("owner",change());
 expect(added.revision).toBe(2);expect(added.members.find(x=>x.login==="target").role).toBe("reader");
 expect(service.update("owner",change({role:"editor",expectedRole:"reader",revision:2})).revision).toBe(3);
 expect(service.update("owner",change({role:null,expectedRole:"editor",revision:3})).members.some(x=>x.login==="target")).toBe(false);
 expect(db.prepare("SELECT count(*) n FROM audit_events WHERE action='update-vault-member'").get().n).toBe(3);
 expect(service.list("owner",vault.id).members[0]).not.toHaveProperty("email");
});
it.each(["reader","editor","admin","invalid"])("denies %s listing and mutation without ownership",token=>{
 expect(()=>service.list(token,vault.id)).toThrow();expect(()=>service.update(token,change())).toThrow();
 expect(service.list("owner",vault.id).revision).toBe(1);
});
it("rejects expired sessions, removed ownership, aliases and replacement identities",()=>{
 active=false;expect(()=>service.update("owner",change())).toThrow();active=true;
 expect(()=>service.list("owner","Notes")).toThrow();
 db.prepare("DELETE FROM memberships WHERE user_id='owner'").run();expect(()=>service.update("owner",change())).toThrow();
 db.prepare("DELETE FROM vaults WHERE id=?").run(vault.id);registerVault(db,root,"Notes","owner");
 expect(()=>service.update("owner",change())).toThrow();
});
it("rejects stale revisions and expected roles instead of overwriting another window",()=>{
 service.update("owner",change());
 expect(()=>service.update("owner",change({role:"editor"}))).toThrow(expect.objectContaining({code:"MEMBERSHIP_CONFLICT"}));
 expect(()=>service.update("owner",change({revision:2}))).toThrow(expect.objectContaining({code:"MEMBERSHIP_CONFLICT"}));
});
it("protects every owner, rejects role escalation and never changes instance roles",()=>{
 for(const input of [change({login:"owner",role:null}),change({role:"owner"}),change({role:"admin"}),change({userId:"admin"}),change({revision:0})])
  expect(()=>service.update("owner",input)).toThrow();
 service.update("owner",change({login:"ADMIN"}));
 expect(db.prepare("SELECT role FROM users WHERE id='admin'").get().role).toBe("admin");
 expect(service.list("owner",vault.id).members.find(x=>x.login==="admin").role).toBe("reader");
});
it("rejects missing/disabled new members but allows removing disabled existing members",()=>{
 expect(()=>service.update("owner",change({login:"missing"}))).toThrow();
 service.update("owner",change());db.prepare("UPDATE users SET status='disabled' WHERE id='target'").run();
 expect(()=>service.update("owner",change({revision:2,expectedRole:"reader",role:"editor"}))).toThrow();
 expect(service.update("owner",change({revision:2,expectedRole:"reader",role:null})).revision).toBe(3);
});
it("rolls back membership and revision if auditing fails",()=>{
 db.exec("CREATE TRIGGER fail_member_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test'); END");
 expect(()=>service.update("owner",change())).toThrow();
 expect(service.list("owner",vault.id).revision).toBe(1);
 expect(db.prepare("SELECT 1 FROM memberships WHERE user_id='target'").get()).toBeUndefined();
});
