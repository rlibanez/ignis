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
it('builds explorer mounts only from granted resources, excluding private configuration and links',()=>{
 const id=share();fs.mkdirSync(path.join(root,'Notes','Project','.hidden'));fs.symlinkSync('../secret.md',path.join(root,'Notes','Project','link'));
 const destination=makeDestination();service.destination('recipient',{id,vault:destination.id});
 const snapshot=service.mounts('recipient',{vault:destination.id});expect(snapshot.mounts).toHaveLength(1);expect(snapshot.mounts[0]).toMatchObject({id,role:'reader',kind:'directory'});expect(Object.keys(snapshot.mounts[0].tree)).toEqual(['','note.md']);expect(()=>service.mounts('outsider',{vault:destination.id})).toThrow();expect(service.mounts('owner',{vault:vault.id}).mounts).toEqual([]);
 service.grant('owner',{action:'revoke',id,revision:1});expect(service.mounts('recipient',{vault:destination.id}).mounts).toEqual([]);
});
it('rejects explorer snapshots after session revocation',()=>{share();active=false;expect(()=>service.mounts('recipient')).toThrow();});

function makeDestination(name='Inbox',owner='recipient') {fs.mkdirSync(path.join(root,name));return registerVault(db,root,name,owner);}
it('requires explicit placement and mounts each resource in only one vault',()=>{
 const a=makeDestination(),b=makeDestination('Other'),id=share();
 expect(service.catalog('recipient').resources[0].destination).toBe(null);
 expect(service.mounts('recipient',{vault:a.id}).mounts).toEqual([]);
 service.destination('recipient',{id,vault:a.id});expect(service.mounts('recipient',{vault:a.id}).mounts).toHaveLength(1);expect(service.mounts('recipient',{vault:b.id}).mounts).toEqual([]);
 service.destination('recipient',{id,vault:b.id});expect(service.mounts('recipient',{vault:a.id}).mounts).toEqual([]);expect(service.mounts('recipient',{vault:b.id}).mounts).toHaveLength(1);
 service.destination('recipient',{id,vault:null});expect(service.mounts('recipient',{vault:b.id}).mounts).toEqual([]);
});
it('rejects foreign vaults, admin bypass, forged resources and disabled accounts',()=>{
 const a=makeDestination(),id=share();
 expect(()=>service.destination('recipient',{id,vault:vault.id})).toThrow();
 expect(()=>service.destination('admin',{id,vault:a.id})).toThrow();
 expect(()=>service.destination('recipient',{id:'missing',vault:a.id})).toThrow();
 db.prepare("UPDATE users SET status='disabled' WHERE id='recipient'").run();expect(()=>service.destination('recipient',{id,vault:a.id})).toThrow();
});
it('does not expose a recipient mount to other members of its destination',async()=>{
 const a=makeDestination(),id=share();db.prepare("INSERT INTO memberships VALUES (?,'outsider','editor')").run(a.id);
 service.destination('recipient',{id,vault:a.id});expect(service.mounts('outsider',{vault:a.id}).mounts).toEqual([]);await expect(service.read('outsider',{id,path:'note.md'})).rejects.toThrow();
 expect(service.catalog('outsider').resources).toEqual([]);
});
it('clears placement on destination membership removal and grant removal',()=>{
 const a=makeDestination(),id=share();service.destination('recipient',{id,vault:a.id});
 db.prepare("DELETE FROM memberships WHERE vault_id=? AND user_id='recipient'").run(a.id);
 expect(db.prepare('SELECT * FROM resource_destinations').all()).toEqual([]);
 db.prepare("INSERT INTO memberships VALUES (?,'recipient','owner')").run(a.id);expect(service.mounts('recipient',{vault:a.id}).mounts).toEqual([]);
 service.destination('recipient',{id,vault:a.id});service.grant('owner',{action:'grant',id,revision:1,login:'recipient',role:null});expect(db.prepare('SELECT * FROM resource_destinations').all()).toEqual([]);
});
it('rolls back placement on audit failure and rejects inactive destinations',()=>{
 const a=makeDestination(),id=share();db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(a.id);expect(()=>service.destination('recipient',{id,vault:a.id})).toThrow();
 db.prepare("UPDATE vaults SET status='active' WHERE id=?").run(a.id);db.exec("CREATE TRIGGER reject_destination_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit failed'); END");expect(()=>service.destination('recipient',{id,vault:a.id})).toThrow();expect(db.prepare('SELECT * FROM resource_destinations').all()).toEqual([]);
});
it('keeps two recipients choices independent and clears deleted destinations',()=>{
 const a=makeDestination(),b=makeDestination('Outside','outsider'),id=share();
 service.grant('owner',{action:'grant',id,revision:1,login:'outsider',role:'reader'});
 service.destination('recipient',{id,vault:a.id});service.destination('outsider',{id,vault:b.id});
 service.destination('recipient',{id,vault:null});expect(service.catalog('outsider').resources[0].destination).toBe(b.id);
 db.prepare('DELETE FROM vaults WHERE id=?').run(b.id);expect(service.catalog('outsider').resources[0].destination).toBe(null);
});
it('places received resources at the root or inside existing folders without copying originals',()=>{
 const a=makeDestination(),id=share();fs.mkdirSync(path.join(root,'Inbox','Work'));
 service.destination('recipient',{id,vault:a.id,localPath:'Work/Project'});
 expect(service.mounts('recipient',{vault:a.id}).mounts[0].localPath).toBe('Work/Project');expect(fs.existsSync(path.join(root,'Inbox','Work','Project'))).toBe(false);
 service.destination('recipient',{id,vault:a.id,localPath:'Project'});expect(service.catalog('recipient').resources[0].localPath).toBe('Project');
});
it('rejects placement traversal, configuration, symlink parents and case-insensitive collisions',()=>{
 const a=makeDestination(),id=share();fs.writeFileSync(path.join(root,'Inbox','taken'),'local');fs.symlinkSync(path.join(root,'Notes'),path.join(root,'Inbox','link'));
 for(const localPath of ['../escape','.obsidian/Plugins','link/Alias','Taken','Missing/Alias','/absolute','bad//path'])expect(()=>service.destination('recipient',{id,vault:a.id,localPath})).toThrow();
 expect(fs.readFileSync(path.join(root,'Inbox','taken'),'utf8')).toBe('local');
});
it('rejects overlapping mounts and blocks a later physical collision without exposing either tree',()=>{
 const a=makeDestination(),first=share(),second=share('secret.md');fs.mkdirSync(path.join(root,'Inbox','Work'));
 service.destination('recipient',{id:first,vault:a.id,localPath:'Work/Project'});
 expect(()=>service.destination('recipient',{id:second,vault:a.id,localPath:'Work/Project/secret.md'})).toThrow();
 fs.mkdirSync(path.join(root,'Inbox','Work','Project'));fs.writeFileSync(path.join(root,'Inbox','Work','Project','private.md'),'local secret');
 const mount=service.mounts('recipient',{vault:a.id}).mounts[0];expect(mount.blocked).toBe(true);expect(mount.tree).toEqual({});
});
it('rejects changing the extension of a local file alias',()=>{const a=makeDestination(),id=share('secret.md');expect(()=>service.destination('recipient',{id,vault:a.id,localPath:'Script.js'})).toThrow();});
it('renames writable notes and folders while preserving nested explicit grants',async()=>{
 const id=share('Project','editor'),fileId=share('Project/note.md');const etag=(await read(id,'note.md')).etag;
 await service.rename('recipient',{id,path:'note.md',to:'Renamed.md',etag});expect((await read(fileId)).kind).toBe('file');expect(db.prepare('SELECT path FROM shared_resources WHERE id=?').get(fileId).path).toBe('Project/Renamed.md');
 await service.mutate('recipient',{id,path:'Sub',action:'mkdir',etag:null});await write(id,null,'inside','Sub/Inside.md');const nested=share('Project/Sub/Inside.md');
 const directory=await read(id,'Sub');await service.rename('recipient',{id,path:'Sub',to:'Renamed folder',etag:directory.etag});expect(Buffer.from((await read(nested)).content,'base64').toString()).toBe('inside');
});
it('denies rename for Read, foreign users, traversal, stale root revisions and cross-folder moves',async()=>{
 const id=share(),file=await read(id,'note.md');await expect(service.rename('recipient',{id,path:'note.md',to:'Other.md',etag:file.etag})).rejects.toThrow();
 service.grant('owner',{action:'grant',id,revision:1,login:'recipient',role:'editor'});
 for(const [token,from,to] of [['admin','note.md','Other.md'],['recipient','','Other'],['recipient','note.md','../Other.md'],['recipient','note.md','.hidden'],['recipient','note.md','Sub/Other.md']])await expect(service.rename(token,{id,path:from,to,etag:file.etag})).rejects.toThrow();
});
it('rejects stale revisions, overwrites and protected descendants on rename',async()=>{
 const id=share('Project','editor'),file=await read(id,'note.md');await write(id,file.etag,'updated');await expect(service.rename('recipient',{id,path:'note.md',to:'Other.md',etag:file.etag})).rejects.toMatchObject({code:'SHARE_CONFLICT'});
 fs.writeFileSync(path.join(root,'Notes','Project','Taken.md'),'keep');const fresh=await read(id,'note.md');await expect(service.rename('recipient',{id,path:'note.md',to:'taken.md',etag:fresh.etag})).rejects.toThrow();
 fs.mkdirSync(path.join(root,'Notes','Project','Sub'));fs.symlinkSync('../note.md',path.join(root,'Notes','Project','Sub','link'));const sub=await read(id,'Sub');await expect(service.rename('recipient',{id,path:'Sub',to:'Other',etag:sub.etag})).rejects.toThrow();
 expect(fs.readFileSync(path.join(root,'Notes','Project','Taken.md'),'utf8')).toBe('keep');
});
it('does not rename onto the location of an unavailable explicit grant',async()=>{
 const id=share('Project','editor');fs.writeFileSync(path.join(root,'Notes','Project','Old.md'),'old');share('Project/Old.md');fs.unlinkSync(path.join(root,'Notes','Project','Old.md'));
 await expect(service.rename('recipient',{id,path:'note.md',to:'Old.md',etag:(await read(id,'note.md')).etag})).rejects.toMatchObject({code:'SHARE_CONFLICT'});
});
it('rechecks sessions after flushing and leaves data unchanged on audit failure',async()=>{
 const id=share('Project','editor'),etag=(await read(id,'note.md')).etag;
 const flush=vi.spyOn(writeCoalescer,'flushPendingSubtree').mockImplementationOnce(async()=>{active=false;});await expect(service.rename('recipient',{id,path:'note.md',to:'Other.md',etag})).rejects.toThrow();flush.mockRestore();active=true;
 db.exec("CREATE TRIGGER reject_rename_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit failed'); END");await expect(service.rename('recipient',{id,path:'note.md',to:'Other.md',etag})).rejects.toThrow();expect(fs.existsSync(path.join(root,'Notes','Project','note.md'))).toBe(true);
});
it('reports uncertain disk/database rename and leaves explicit grants fail-closed',async()=>{
 const id=share('Project','editor'),nested=share('Project/note.md'),etag=(await read(id,'note.md')).etag;
 db.exec("CREATE TRIGGER reject_rename_metadata BEFORE UPDATE OF path ON shared_resources BEGIN SELECT RAISE(ABORT,'metadata failed'); END");
 await expect(service.rename('recipient',{id,path:'note.md',to:'Other.md',etag})).rejects.toMatchObject({code:'SHARE_RENAME_UNCERTAIN'});await expect(read(nested)).rejects.toThrow();expect(fs.existsSync(path.join(root,'Notes','Project','Other.md'))).toBe(true);
});
it('flushes buffered content before rename and rejects its stale content version',async()=>{
 const id=share('Project','editor'),etag=(await read(id,'note.md')).etag,filename=path.join(root,'Notes','Project','note.md');
 await writeCoalescer.writeCoalesced(filename,'first','utf8');await writeCoalescer.writeCoalesced(filename,'latest','utf8');
 await expect(service.rename('recipient',{id,path:'note.md',to:'Other.md',etag})).rejects.toMatchObject({code:'SHARE_CONFLICT'});
 expect(fs.readFileSync(filename,'utf8')).toBe('latest');
});
it('refuses rename when a new buffered write appeared after the flush',async()=>{
 const id=share('Project','editor'),etag=(await read(id,'note.md')).etag,probe=vi.spyOn(writeCoalescer,'hasPendingSubtree').mockReturnValueOnce(true);
 try{await expect(service.rename('recipient',{id,path:'note.md',to:'Other.md',etag})).rejects.toMatchObject({code:'SHARE_CONFLICT'});}finally{probe.mockRestore();}
 expect(fs.existsSync(path.join(root,'Notes','Project','note.md'))).toBe(true);
});

it.each(['Project','secret.md'])('keeps independent aliases when the owner renames %s',async original=>{
 const id=share(original,'editor'),a=makeDestination(),b=makeDestination('Outside','outsider');
 fs.mkdirSync(path.join(root,'Inbox','Work'));
 service.grant('owner',{action:'grant',id,revision:1,login:'outsider',role:'reader'});
 const alias=original==='Project'?'carpetaAdmin':'admin.md',other=original==='Project'?'admin':'mario.md',to=original==='Project'?'carpetaMain':'main.md';
 service.destination('recipient',{id,vault:a.id,localPath:'Work/'+alias});service.destination('outsider',{id,vault:b.id,localPath:other});
 fs.writeFileSync(path.join(root,'Outside',to),'local collision with original name');
 await expect(service.rename('recipient',{id,path:'',to,etag:(await read(id)).etag})).rejects.toThrow();
 service.renameOriginal('owner',vault.id,original,to);
 expect(service.mounts('recipient',{vault:a.id}).mounts[0]).toMatchObject({localPath:'Work/'+alias});
 expect(service.mounts('outsider',{vault:b.id}).mounts[0]).toMatchObject({localPath:other});
 expect(service.mounts('outsider',{vault:b.id}).mounts[0].blocked).not.toBe(true);
 expect(service.catalog('recipient').resources[0]).toMatchObject({name:to,localPath:'Work/'+alias});
 expect((await read(id)).kind).toBe(original==='Project'?'directory':'file');
 expect(fs.readFileSync(path.join(root,'Outside',to),'utf8')).toBe('local collision with original name');
});
it('preserves the initially chosen name without an explicit alias after an owner rename',()=>{
 const id=share(),a=makeDestination();service.destination('recipient',{id,vault:a.id});
 service.renameOriginal('owner',vault.id,'Project','Main');
 expect(service.mounts('recipient',{vault:a.id}).mounts[0].localPath).toBe('Project');
});
it('denies original root renaming by a full-vault editor but allows internal renaming',()=>{
 share();db.prepare("INSERT INTO memberships(vault_id,user_id,role) VALUES (?,'outsider','editor')").run(vault.id);
 expect(()=>service.renameOriginal('outsider',vault.id,'Project','Other')).toThrow();
 service.renameOriginal('outsider',vault.id,'Project/note.md','Project/Other.md');
 expect(fs.existsSync(path.join(root,'Notes','Project','Other.md'))).toBe(true);
});
it('coordinates original-vault renames with nested shares and forbids implicit admin access',async()=>{
 const parent=share('Project','editor'),child=share('Project/note.md');
 expect(()=>service.renameOriginal('admin',vault.id,'Project','Renamed')).toThrow();
 service.renameOriginal('owner',vault.id,'Project','Renamed');
 expect(db.prepare('SELECT path FROM shared_resources WHERE id=?').get(parent).path).toBe('Renamed');
 expect(db.prepare('SELECT path FROM shared_resources WHERE id=?').get(child).path).toBe('Renamed/note.md');
 expect(Buffer.from((await read(child)).content,'base64').toString()).toBe('hello');
});

it('exposes outgoing badges only to the current vault owner and only for live resources with grants',()=>{
 const id=share(),single=share('secret.md');
 expect(service.mounts('owner',{vault:vault.id}).outgoing).toEqual(expect.arrayContaining([{path:'Project',kind:'directory'},{path:'secret.md',kind:'file'}]));
 db.prepare("INSERT INTO memberships(vault_id,user_id,role) VALUES (?,'outsider','editor')").run(vault.id);
 expect(service.mounts('outsider',{vault:vault.id}).outgoing).toEqual([]);
 const other=makeDestination('Other','owner');expect(service.mounts('owner',{vault:other.id}).outgoing).toEqual([]);
 expect(()=>service.mounts('admin',{vault:vault.id})).toThrow();
 service.grant('owner',{action:'revoke',id,revision:1});expect(service.mounts('owner',{vault:vault.id}).outgoing).toEqual([{path:'secret.md',kind:'file'}]);
 fs.unlinkSync(path.join(root,'Notes','secret.md'));expect(service.mounts('owner',{vault:vault.id}).outgoing).toEqual([]);
 fs.writeFileSync(path.join(root,'Notes','secret.md'),'replacement');expect(service.mounts('owner',{vault:vault.id}).outgoing).toEqual([]);
 expect(single).toBeTruthy();
});

const ordinary=(expected,content='owner update',p='Project/note.md',user='owner')=>service.writeOriginal(user,vault.id,p,Buffer.from(content),expected);
it.each(['Project','Project/note.md'])('coordinates ordinary owner and recipient writes for %s in both orders',async p=>{
 const id=share(p,'editor'),relative=p==='Project'?'note.md':'';
 const initial=await read(id,relative);
 const own=await ordinary(initial.etag);
 expect(Buffer.from((await read(id,relative)).content,'base64').toString()).toBe('owner update');
 await expect(write(id,initial.etag,'stale recipient',relative)).rejects.toMatchObject({code:'SHARE_CONFLICT'});
 const recipient=await write(id,own.etag,'recipient update',relative);
 await expect(ordinary(own.etag,'stale owner')).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 expect(fs.readFileSync(path.join(root,'Notes','Project/note.md'),'utf8')).toBe('recipient update');
 expect((await ordinary(recipient.etag,'fresh owner')).etag).not.toBe(recipient.etag);
 expect((await read(id,relative)).kind).toBe('file');
});
it('permits only one racing ordinary or mixed publication on a read version',async()=>{
 const id=share('Project/note.md','editor'),initial=await read(id);
 const races=await Promise.allSettled([ordinary(initial.etag,'one'),ordinary(initial.etag,'two'),write(id,initial.etag,'three','')]);
 expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(races.filter(r=>r.status==='rejected')).toHaveLength(2);
});
it('requires an exact version and rejects deleted files, collisions, traversal, links and unauthorized writers',async()=>{
 const id=share('Project/note.md','editor'),initial=await read(id);
 for(const missing of ['*','',false,{},'a'.repeat(63)])await expect(ordinary(missing)).rejects.toMatchObject({code:'CONTENT_VERSION_REQUIRED'});
 await expect(ordinary(null)).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 for(const user of ['admin','recipient','outsider','invalid'])await expect(ordinary(initial.etag,'no','Project/note.md',user)).rejects.toThrow();
 for(const p of ['../outside','.obsidian/config','Project/../secret.md'])await expect(ordinary(null,'no',p)).rejects.toThrow();
 fs.symlinkSync('note.md',path.join(root,'Notes/Project/link.md'));fs.linkSync(path.join(root,'Notes/secret.md'),path.join(root,'Notes/Project/hard.md'));
 for(const p of ['Project/link.md','Project/hard.md'])await expect(ordinary(initial.etag,'no',p)).rejects.toThrow();
 fs.unlinkSync(path.join(root,'Notes/Project/note.md'));await expect(ordinary(initial.etag)).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 expect(fs.existsSync(path.join(root,'Notes/Project/note.md'))).toBe(false);
 const created=await ordinary(null,'new','Project/new.md');expect(created.size).toBe(3);
});
it('rechecks revocation after draining pending writes',async()=>{
 const id=share('Project/note.md','editor'),initial=await read(id);
 const spy=vi.spyOn(writeCoalescer,'flushPending').mockImplementationOnce(async()=>{active=false;});
 try{await expect(ordinary(initial.etag)).rejects.toThrow();expect(fs.readFileSync(path.join(root,'Notes/Project/note.md'),'utf8')).toBe('hello');}finally{spy.mockRestore();}
});

it('does not damage the original when publication fails before the rename',async()=>{
 const id=share('Project/note.md','editor'),initial=await read(id);
 const spy=vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw Object.assign(new Error('disk failure'),{code:'EIO'});});
 try{await expect(ordinary(initial.etag)).rejects.toThrow();}finally{spy.mockRestore();}
 expect(fs.readFileSync(path.join(root,'Notes/Project/note.md'),'utf8')).toBe('hello');
 expect(fs.readdirSync(path.join(root,'Notes/Project'))).toEqual(['note.md']);
 expect((await read(id)).etag).toBe(initial.etag);
});
it('preserves binary contents and file grants across an ordinary atomic save',async()=>{
 const id=share('Project/note.md','editor'),initial=await read(id),bytes=Buffer.from([0,255,128,13,10]);
 const result=await service.writeOriginal('owner',vault.id,'Project/note.md',bytes,initial.etag);
 expect(Buffer.from((await read(id)).content,'base64')).toEqual(bytes);expect((await read(id)).etag).toBe(result.etag);
});

it('allows deliberate plugin replacement but rejects an editor based on the overwritten version',async()=>{
 const id=share('Project/note.md','editor'),initial=await read(id);
 await ordinary(undefined,'plugin replacement');
 expect(Buffer.from((await read(id)).content,'base64').toString()).toBe('plugin replacement');
 await expect(ordinary(initial.etag,'stale editor')).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 for(const user of ['admin','recipient','outsider','invalid'])await expect(ordinary(undefined,'unauthorized','Project/note.md',user)).rejects.toThrow();
 for(const bad of ['*','',false,{}])await expect(ordinary(bad,'invalid')).rejects.toMatchObject({code:'CONTENT_VERSION_REQUIRED'});
});
