const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { transaction } = require("./database");
const { resolveRegisteredVault } = require("./vault-catalog");
const { classifyVaultPath } = require("./vault-policy");
const { normalizeLogin } = require("./store");
const { writeCoalescer } = require("@ignis/server-core");
const { readResourceShareLimits } = require("./resource-share-limits");
const MAX_ENTRIES = 1000;
const fail = (code = "SHARE_UNAVAILABLE") => { throw Object.assign(new Error("Shared resource unavailable"), { code }); };
const identity = stat => `${stat.ino}:${stat.birthtimeMs}`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function canonical(value, empty = false) {
  if (typeof value !== "string" || value.length > 1024 || (!value && !empty) || (value && classifyVaultPath(value) !== "content")) fail("INVALID_SHARE_PATH");
  return value;
}
function inspect(root, relative, missing = false) {
  canonical(relative, true);
  let filename = root, stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const parts = relative.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    filename = path.join(filename, parts[i]);
    try { stat = fs.lstatSync(filename); }
    catch (error) { if (missing && error.code === "ENOENT" && i === parts.length - 1) return { filename, stat:null }; throw error; }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1) ||
      (i < parts.length - 1 && !stat.isDirectory())) fail();
  }
  return { filename, stat };
}
function readFile(item, maxFileBytes) {
  if (!item.stat?.isFile() || item.stat.size > maxFileBytes) fail("SHARE_TOO_LARGE");
  const fd = fs.openSync(item.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== item.stat.dev || stat.ino !== item.stat.ino || stat.size > maxFileBytes) fail();
    // A fixed-size read prevents an externally growing file from allocating without a bound.
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail("SHARE_CONFLICT"); offset += count; }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("SHARE_CONFLICT");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function createResourceSharesService(db, root, sessions, limits = readResourceShareLimits({})) {
  const { maxFileBytes } = limits;
  function actor(token) {
    const session = sessions.resolve(token, { withinTransaction:true });
    if (!session) fail();
    const user = db.prepare("SELECT id,login,role,status,auth_version FROM users WHERE id=?").get(session.user.id);
    if (!user || user.status !== "active" || !["admin","user"].includes(user.role) || user.auth_version !== session.user.authVersion) fail();
    return user;
  }
  function vault(reference) { const result = resolveRegisteredVault(db, root, reference); if (result.id !== reference) fail(); return result; }
  function owner(user, id) { return db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(id,user.id)?.role === "owner"; }
  function audit(user, action, info) { db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?)").run(randomUUID(),user.id,action,JSON.stringify(info),Date.now()); }
  function resource(token, id, relative = "", write = false) {
    const user = actor(token);
    const row = typeof id === "string" && db.prepare("SELECT * FROM shared_resources WHERE id=?").get(id);
    if (!row) fail();
    const v = vault(row.vault_id);
    const owns = owner(user,v.id);
    const role = owns ? "editor" : db.prepare("SELECT role FROM resource_grants WHERE resource_id=? AND user_id=?").get(id,user.id)?.role;
    if (!role || (write && role !== "editor")) fail();
    const base = inspect(v.path,row.path);
    if (String(base.stat.dev) !== row.device || identity(base.stat) !== row.inode ||
       (row.kind === "file" ? !base.stat.isFile() : !base.stat.isDirectory())) fail();
    canonical(relative,true);
    if (row.kind === "file" && relative !== "") fail();
    return {user,row,v,base,role,owns,relative};
  }
  function target(access, missing = false) { return access.row.kind === "file" ? access.base : inspect(access.base.filename,access.relative,missing); }
  function catalog(token) {
    return transaction(db,()=>{
      const user=actor(token);
      const ownedVaults=db.prepare("SELECT v.id,v.name FROM vaults v JOIN memberships m ON m.vault_id=v.id WHERE m.user_id=? AND m.role='owner' AND v.status='active' ORDER BY v.name").all(user.id);
      const rows=db.prepare(`SELECT DISTINCT r.* FROM shared_resources r LEFT JOIN resource_grants g ON g.resource_id=r.id
        LEFT JOIN memberships m ON m.vault_id=r.vault_id AND m.user_id=? WHERE g.user_id=? OR m.role='owner' ORDER BY r.path`).all(user.id,user.id);
      const resources=rows.flatMap(row=>{
        // Owners retain stale entries so they can revoke them; recipients see only live resources.
        const owns=owner(user,row.vault_id); let available=true, access;
        try {access=resource(token,row.id);} catch {available=false;}
        if(!owns && !available) return [];
        const result={id:row.id,name:path.basename(row.path),kind:row.kind,revision:row.revision,owned:owns,available,
          role:owns?"editor":access.role};
        if(owns) Object.assign(result,{vault:row.vault_id,path:row.path,grants:db.prepare("SELECT u.login,g.role FROM resource_grants g JOIN users u ON u.id=g.user_id WHERE g.resource_id=? ORDER BY u.login").all(row.id)});
        else result.owner=db.prepare("SELECT u.login FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.vault_id=? AND m.role='owner'").get(row.vault_id)?.login || "";
        return [result];
      });
      return {ownedVaults,resources,limits:{maxFileBytes,maxFileMiB:limits.maxFileMiB}};
    });
  }
  function create(token,input) {
    return transaction(db,()=>{
      const user=actor(token), v=vault(input.vault);
      if(!owner(user,v.id)) fail();
      const relative=canonical(input.path), item=inspect(v.path,relative);
      const login=normalizeLogin(input.login), recipient=db.prepare("SELECT id,status FROM users WHERE login=?").get(login);
      if(!recipient || recipient.status!=="active" || recipient.id===user.id || !["reader","editor"].includes(input.role)) fail("INVALID_SHARE");
      if(db.prepare("SELECT count(*) n FROM shared_resources WHERE vault_id=?").get(v.id).n>=MAX_ENTRIES) fail("SHARE_LIMIT");
      if(db.prepare("SELECT id FROM shared_resources WHERE vault_id=? AND path=?").get(v.id,relative)) fail("SHARE_EXISTS");
      const id=randomUUID();
      db.prepare("INSERT INTO shared_resources(id,vault_id,path,kind,device,inode) VALUES (?,?,?,?,?,?)").run(id,v.id,relative,item.stat.isDirectory()?"directory":"file",String(item.stat.dev),identity(item.stat));
      db.prepare("INSERT INTO resource_grants VALUES (?,?,?)").run(id,recipient.id,input.role);
      audit(user,"create-resource-share",{id,vault:v.id,path:relative,userId:recipient.id,role:input.role});
      return {id};
    });
  }
  function grant(token,input) {
    return transaction(db,()=>{
      const user=actor(token), row=db.prepare("SELECT * FROM shared_resources WHERE id=?").get(input.id);
      if(!row || !owner(user,row.vault_id)) fail();
      vault(row.vault_id);
      if(!Number.isSafeInteger(input.revision) || row.revision!==input.revision || row.revision>=Number.MAX_SAFE_INTEGER) fail("SHARE_CONFLICT");
      if(input.action === "revoke") {db.prepare("DELETE FROM shared_resources WHERE id=?").run(row.id);audit(user,"revoke-resource-share",{id:row.id});return {ok:true};}
      if(![null,"reader","editor"].includes(input.role)) fail("INVALID_SHARE");
      const recipient=db.prepare("SELECT id,status FROM users WHERE login=?").get(normalizeLogin(input.login));
      if(!recipient || (input.role!==null && recipient.status!=="active") || recipient.id===user.id) fail("INVALID_SHARE");
      if(input.role!==null) {
        resource(token,row.id); // Cannot extend access to a replaced root.
        db.prepare("INSERT INTO resource_grants VALUES (?,?,?) ON CONFLICT(resource_id,user_id) DO UPDATE SET role=excluded.role").run(row.id,recipient.id,input.role);
      } else db.prepare("DELETE FROM resource_grants WHERE resource_id=? AND user_id=?").run(row.id,recipient.id);
      db.prepare("UPDATE shared_resources SET revision=revision+1 WHERE id=?").run(row.id);
      audit(user,"update-resource-grant",{id:row.id,userId:recipient.id,role:input.role});
      return {ok:true};
    });
  }
  function browseOwner(token,input) {
    const user=actor(token),v=vault(input.vault); if(!owner(user,v.id)) fail();
    return listing(inspect(v.path,canonical(input.path,true)));
  }
  function listing(item) {
    if(!item.stat.isDirectory()) fail();
    // Bounded iteration, including hidden entries, to avoid unbounded allocations.
    const directory=fs.opendirSync(item.filename), entries=[];let count=0;
    try {for(let entry; (entry=directory.readSync());) {
      if(++count>MAX_ENTRIES) fail("SHARE_LIMIT");
      try {
        canonical(entry.name);const child=inspect(item.filename,entry.name);
        entries.push({name:entry.name,kind:child.stat.isDirectory()?"directory":"file"});
      } catch(error) { if(!["INVALID_SHARE_PATH","SHARE_UNAVAILABLE","ENOENT"].includes(error.code)) throw error; }
    }} finally {directory.closeSync();}
    return {entries:entries.sort((a,b)=>a.name.localeCompare(b.name))};
  }
  async function read(token,input) {
    const access=resource(token,input.id,input.path || ""),item=target(access);
    if(item.stat.isDirectory()) return {...listing(item),kind:"directory",role:access.role};
    await writeCoalescer.flushPending(item.filename);
    const current=resource(token,input.id,input.path || ""),bytes=readFile(target(current),maxFileBytes);
    return {kind:"file",role:current.role,name:path.basename(item.filename),content:bytes.toString("base64"),etag:digest(bytes)};
  }
  async function mutate(token,input) {
    const relative=input.path || "", access=resource(token,input.id,relative,true),item=target(access,true);
    if(!["write","mkdir","remove"].includes(input.action)) fail("INVALID_SHARE");
    if(input.action!=="write" && !relative) fail("INVALID_SHARE");
    let bytes;
    if(input.action==="write") {
      if(typeof input.content!=="string" || input.content.length>Math.ceil(maxFileBytes/3)*4 || (input.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content))) fail("SHARE_TOO_LARGE");
      bytes=Buffer.from(input.content,"base64");if(bytes.length>maxFileBytes || bytes.toString("base64")!==input.content) fail("SHARE_TOO_LARGE");
    }
    await writeCoalescer.flushPending(item.filename);
    return writeCoalescer.supersedePending(item.filename,()=>{
      const fresh=resource(token,input.id,relative,true),current=target(fresh,true);
      if(writeCoalescer.getPending(current.filename)!==null) fail("SHARE_CONFLICT");
      const etag=current.stat ? current.stat.isFile()?digest(readFile(current,maxFileBytes)):"directory" : null;
      if(input.etag!==etag) fail("SHARE_CONFLICT");
      if(input.action==="mkdir") {if(current.stat) fail("SHARE_CONFLICT");fs.mkdirSync(current.filename,{mode:0o700});}
      else if(input.action==="remove") {
        if(!current.stat) fail();
        if(current.stat.isDirectory()) fs.rmdirSync(current.filename); else fs.unlinkSync(current.filename);
      } else {
        if(current.stat && !current.stat.isFile()) fail("INVALID_SHARE");
        // Publish complete bytes atomically. A crash between disk publication and
        // SQLite commit leaves file grants unavailable, never pointing at a replacement.
        const temporary=path.join(path.dirname(current.filename),".ignis-share-"+randomUUID());
        let published=false;
        try {
          const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,current.stat ? current.stat.mode & 0o777 : 0o600);
          try {
            let offset=0;
            while(offset<bytes.length) {const count=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!count) fail();offset+=count;}
            fs.fsyncSync(fd);
          } finally {fs.closeSync(fd);}
          transaction(db,()=>{
            const replacement=fs.lstatSync(temporary);
            fs.renameSync(temporary,current.filename);published=true;
            const directoryFd=fs.openSync(path.dirname(current.filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
            try {fs.fsyncSync(directoryFd);} finally {fs.closeSync(directoryFd);}
            // Keep every explicit file grant to the same original resource usable.
            if(current.stat) db.prepare("UPDATE shared_resources SET device=?,inode=? WHERE vault_id=? AND path=? AND device=? AND inode=?")
              .run(String(replacement.dev),identity(replacement),fresh.v.id,
                fresh.row.kind==="file"?fresh.row.path:fresh.row.path+"/"+relative,String(current.stat.dev),identity(current.stat));
          });
        } catch(error) {if(published) fail("SHARE_WRITE_UNCERTAIN");throw error;}
        finally {try{fs.unlinkSync(temporary);}catch{/* Preserve the original failure; reserved temporary files are never shareable. */}}

      }
      return {ok:true,...(bytes?{etag:digest(bytes)}:{})};
    });
  }
  return {catalog,create,grant,browseOwner,read,mutate,limits};
}
module.exports={createResourceSharesService};
