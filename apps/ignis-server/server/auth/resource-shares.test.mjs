import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {createRequire} from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require=createRequire(import.meta.url);
const {openDatabase}=require("./database");
const {registerVault}=require("./store");
const {createResourceSharesService}=require("./resource-shares");
const {writeCoalescer}=require("@ignis/server-core");
let root,db,vault,service,active;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),"ignis-shares-"));fs.mkdirSync(path.join(root,"Notes","Project"),{recursive:true});
 fs.writeFileSync(path.join(root,"Notes","Project","note.md"),"hello");fs.writeFileSync(path.join(root,"Notes","secret.md"),"private");
 fs.mkdirSync(path.join(root,"Notes",".obsidian"));fs.writeFileSync(path.join(root,"Notes",".obsidian","plugins.json"),"secret config");
 db=openDatabase(path.join(root,"data"));
 for(const id of ["owner","recipient","outsider","admin"])db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)").run(id,id,id==="admin"?"admin":"user");
 vault=registerVault(db,root,"Notes","owner");active=true;
 service=createResourceSharesService(db,root,{resolve:token=>active && ["owner","recipient","outsider","admin"].includes(token)?{user:{id:token,authVersion:1}}:null});
});
afterEach(async()=>{await writeCoalescer.flushAll();db.close();fs.rmSync(root,{recursive:true,force:true});});
const share=(p="Project",role="reader")=>service.create("owner",{vault:vault.id,path:p,login:"recipient",role}).id;
const read=(id,p="")=>service.read("recipient",{id,path:p});
const write=(id,etag,content="updated",p="note.md")=>service.mutate("recipient",{id,path:p,action:"write",etag,content:Buffer.from(content).toString("base64")});
it("shares folder descendants without granting vault membership or exposing unrelated paths",async()=>{
 const id=share();expect((await read(id)).entries).toEqual([{name:"note.md",kind:"file"}]);
 expect(Buffer.from((await read(id,"note.md")).content,"base64").toString()).toBe("hello");
 const catalog=service.catalog("recipient");expect(catalog.ownedVaults).toEqual([]);expect(catalog.resources[0]).not.toHaveProperty("path");expect(catalog.resources[0]).not.toHaveProperty("vault");
 expect(db.prepare("SELECT * FROM memberships WHERE user_id='recipient'").all()).toEqual([]);
 fs.writeFileSync(path.join(root,"Notes","Project","new.md"),"new");expect((await read(id)).entries).toHaveLength(2);
});
it("shares a single file but neither its parent nor sibling",async()=>{
 const id=share("Project/note.md");expect((await read(id)).kind).toBe("file");await expect(read(id,"../secret.md")).rejects.toThrow();await expect(read(id,"other.md")).rejects.toThrow();
});
it.each(["admin","recipient","outsider","bad"])("denies non-owner %s management",token=>{
 expect(()=>service.create(token,{vault:vault.id,path:"Project",login:"recipient",role:"editor"})).toThrow();
 const id=share();expect(()=>service.grant(token,{action:"revoke",id,revision:1})).toThrow();
});
it("does not let a guessed share ID authorize outsiders",async()=>{const id=share();await expect(service.read("outsider",{id,path:""})).rejects.toThrow();expect(service.catalog("outsider").resources).toEqual([]);});
it.each(["../secret.md","/secret.md","Project/../secret.md","Project//note.md","Project\\note.md",".obsidian/plugins.json","Project/.git/config","Project/note.md ","Project/note.md/."])("rejects invalid or protected path %s",p=>{expect(()=>share(p)).toThrow();});
it("rejects sibling prefixes, traversal, hidden descendants and symlinks",async()=>{
 const id=share();fs.symlinkSync("../secret.md",path.join(root,"Notes","Project","link.md"));fs.mkdirSync(path.join(root,"Notes","Project",".hidden"));fs.linkSync(path.join(root,"Notes","secret.md"),path.join(root,"Notes","Project","hard.md"));
 expect((await read(id)).entries).toHaveLength(1);
 for(const p of ["../secret.md","../Project2/file","link.md","hard.md",".hidden/file","x/../../secret.md"])await expect(read(id,p)).rejects.toThrow();
 for(const p of ["Project/link.md","Project/hard.md"])expect(()=>share(p)).toThrow();
});
it("denies write, mkdir and delete to a reader",async()=>{
 const id=share(),file=await read(id,"note.md");await expect(write(id,file.etag)).rejects.toThrow();
 for(const action of ["mkdir","remove"])await expect(service.mutate("recipient",{id,path:"note.md",action,etag:file.etag})).rejects.toThrow();
});
it("supports editor content writes, creation, nested folders and removal with conflict detection",async()=>{
 const id=share("Project","editor"),old=await read(id,"note.md");const result=await write(id,old.etag);
 expect(result.etag).not.toBe(old.etag);await expect(write(id,old.etag,"stale")).rejects.toMatchObject({code:"SHARE_CONFLICT"});
 expect(fs.readFileSync(path.join(root,"Notes","Project","note.md"),"utf8")).toBe("updated");
 await service.mutate("recipient",{id,path:"sub",action:"mkdir",etag:null});await write(id,null,"new","sub/new.md");
 await expect(service.mutate("recipient",{id,path:"sub",action:"remove",etag:"directory"})).rejects.toThrow();
 const child=await read(id,"sub/new.md");await service.mutate("recipient",{id,path:"sub/new.md",action:"remove",etag:child.etag});await service.mutate("recipient",{id,path:"sub",action:"remove",etag:"directory"});
 expect((await read(id)).entries).toHaveLength(1);
});
it("edits a shared file while retaining its root identity",async()=>{const id=share("Project/note.md","editor"),file=await read(id);await write(id,file.etag,"edited","");expect(Buffer.from((await read(id)).content,"base64").toString()).toBe("edited");});
it("protects the root, hidden configuration and stale existing files on creation",async()=>{
 const id=share("Project","editor");for(const action of ["mkdir","remove"])await expect(service.mutate("recipient",{id,path:"",action,etag:"directory"})).rejects.toThrow();
 await expect(write(id,null,"overwrite")).rejects.toMatchObject({code:"SHARE_CONFLICT"});await expect(write(id,null,"config",".obsidian/plugins.json")).rejects.toThrow();
});
it("revokes access, handles downgrade and refuses stale permission updates",async()=>{
 const id=share("Project","editor"),file=await read(id,"note.md");service.grant("owner",{action:"grant",id,revision:1,login:"recipient",role:"reader"});await expect(write(id,file.etag)).rejects.toThrow();
 expect(()=>service.grant("owner",{action:"revoke",id,revision:1})).toThrow();service.grant("owner",{action:"revoke",id,revision:2});await expect(read(id)).rejects.toThrow();
});
it("checks disabled users, revoked sessions and inactive vaults on each access",async()=>{
 const id=share();active=false;await expect(read(id)).rejects.toThrow();active=true;db.prepare("UPDATE users SET status='disabled' WHERE id='recipient'").run();await expect(read(id)).rejects.toThrow();
 db.prepare("UPDATE users SET status='active' WHERE id='recipient'").run();db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(vault.id);await expect(read(id)).rejects.toThrow();
});
it("never follows a replacement root and lets the owner revoke the stale share",async()=>{
 const id=share();fs.renameSync(path.join(root,"Notes","Project"),path.join(root,"Notes","Old"));fs.mkdirSync(path.join(root,"Notes","Project"));fs.writeFileSync(path.join(root,"Notes","Project","secret.md"),"private");
 await expect(read(id)).rejects.toThrow();expect(service.catalog("recipient").resources).toEqual([]);expect(service.catalog("owner").resources[0].available).toBe(false);service.grant("owner",{action:"revoke",id,revision:1});
});
it("transfers management with vault ownership without turning admin into owner",()=>{
 const id=share();db.prepare("UPDATE memberships SET role='editor' WHERE user_id='owner'").run();db.prepare("INSERT INTO memberships VALUES (?,'admin','owner')").run(vault.id);
 expect(()=>service.grant("owner",{action:"revoke",id,revision:1})).toThrow();expect(service.grant("admin",{action:"revoke",id,revision:1})).toEqual({ok:true});
});
it("rolls back grants and resource creation when audit fails",()=>{
 db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit failed'); END");expect(()=>share()).toThrow();expect(db.prepare("SELECT * FROM shared_resources").all()).toEqual([]);
});
it("coordinates with pending vault writes and rejects a stale shared editor",async()=>{
 const id=share("Project","editor"),old=await read(id,"note.md");await writeCoalescer.writeCoalesced(path.join(root,"Notes","Project","note.md"),"new from Obsidian","utf8");
 await expect(write(id,old.etag,"stale")).rejects.toMatchObject({code:"SHARE_CONFLICT"});expect(Buffer.from((await read(id,"note.md")).content,"base64").toString()).toBe("new from Obsidian");
});
it("rejects unsupported roles, self-sharing and invalid recipients",()=>{
 for(const input of [{login:"missing"},{login:"owner"},{role:"owner"},{role:"admin"}])expect(()=>service.create("owner",{vault:vault.id,path:"Project",login:"recipient",role:"reader",...input})).toThrow();
});
it("enforces file and listing limits before returning data",async()=>{
 const id=share("Project","editor");const filename=path.join(root,"Notes","Project","big.bin");fs.writeFileSync(filename,"");fs.truncateSync(filename,8*1024*1024+1);
 await expect(read(id,"big.bin")).rejects.toMatchObject({code:"SHARE_TOO_LARGE"});
 await expect(service.mutate("recipient",{id,path:"invalid",action:"write",etag:null,content:"not base64!"})).rejects.toThrow();
 for(let i=0;i<1000;i++)fs.writeFileSync(path.join(root,"Notes","Project",String(i)),"");await expect(read(id)).rejects.toMatchObject({code:"SHARE_LIMIT"});
});
it("rolls back permission edits and revision when audit fails",()=>{
 const id=share();db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit failed'); END");
 expect(()=>service.grant("owner",{action:"grant",id,revision:1,login:"recipient",role:"editor"})).toThrow();
 expect(db.prepare("SELECT role FROM resource_grants WHERE resource_id=?").get(id).role).toBe("reader");expect(db.prepare("SELECT revision FROM shared_resources WHERE id=?").get(id).revision).toBe(1);
});
it("revalidates a revoked grant after waiting for vault writes",async()=>{
 const id=share("Project","editor");const reading=read(id,"note.md");service.grant("owner",{action:"revoke",id,revision:1});await expect(reading).rejects.toThrow();
});
it("does not truncate an existing file if writing the temporary file fails",async()=>{
 const id=share("Project/note.md","editor"),old=await read(id),original=fs.writeSync;
 const spy=vi.spyOn(fs,"writeSync").mockImplementation((fd,buffer,offset,length,position)=>{original(fd,buffer,offset,Math.min(length,2),position);throw Object.assign(new Error("disk full"),{code:"ENOSPC"});});
 try{await expect(write(id,old.etag,"replacement","")).rejects.toThrow();}finally{spy.mockRestore();}
 expect(fs.readFileSync(path.join(root,"Notes","Project","note.md"),"utf8")).toBe("hello");expect(fs.readdirSync(path.join(root,"Notes","Project"))).toEqual(["note.md"]);
});
it("keeps explicit file grants usable after an atomic write through a folder grant",async()=>{
 const folder=share("Project","editor"),file=share("Project/note.md","reader"),old=await read(folder,"note.md");await write(folder,old.etag,"atomic");expect(Buffer.from((await read(file)).content,"base64").toString()).toBe("atomic");
});
it("fails closed with an explicit outcome if SQLite fails after file publication",async()=>{
 const id=share("Project/note.md","editor"),old=await read(id);db.exec("CREATE TRIGGER fail_identity BEFORE UPDATE ON shared_resources BEGIN SELECT RAISE(ABORT,'metadata failed'); END");
 await expect(write(id,old.etag,"complete","")).rejects.toMatchObject({code:"SHARE_WRITE_UNCERTAIN"});expect(fs.readFileSync(path.join(root,"Notes","Project","note.md"),"utf8")).toBe("complete");await expect(read(id)).rejects.toThrow();
});
it("accepts the maximum binary file size without regex stack exhaustion",async()=>{
 const id=share("Project","editor"),content=Buffer.alloc(8*1024*1024,255).toString("base64");
 await service.mutate("recipient",{id,path:"large.bin",action:"write",etag:null,content});expect((await read(id,"large.bin")).content).toBe(content);
});
it.each([1,16])("applies the configured %i MiB limit to reads, writes and client metadata",async mib=>{
 service=createResourceSharesService(db,root,{resolve:token=>({user:{id:token,authVersion:1}})},require("./resource-share-limits").readResourceShareLimits({IGNIS_SHARED_RESOURCE_MAX_FILE_MIB:String(mib)}));
 const id=share("Project","editor"),size=mib*1024*1024;
 expect(service.catalog("recipient").limits).toEqual({maxFileMiB:mib,maxFileBytes:size});
 await service.mutate("recipient",{id,path:"limit.bin",action:"write",etag:null,content:Buffer.alloc(size,1).toString("base64")});
 expect(Buffer.from((await read(id,"limit.bin")).content,"base64")).toHaveLength(size);
 await expect(service.mutate("recipient",{id,path:"large.bin",action:"write",etag:null,content:Buffer.alloc(size+1,1).toString("base64")})).rejects.toMatchObject({code:"SHARE_TOO_LARGE"});
 fs.truncateSync(path.join(root,"Notes","Project","limit.bin"),size+1);await expect(read(id,"limit.bin")).rejects.toMatchObject({code:"SHARE_TOO_LARGE"});
});
