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
const directoryTag = stat => "dir:" + createHash("sha256").update([stat.dev,identity(stat),stat.mtimeMs,stat.ctimeMs].join(":")).digest("hex");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function canonical(value, empty = false) {
  if (typeof value !== "string" || value.length > 1024 || (!value && !empty) || (value && classifyVaultPath(value) !== "content")) fail("INVALID_SHARE_PATH");
  return value;
}
function inspect(root, relative, missing = false, trash = false) {
  if(trash && relative.startsWith(".trash/"))canonical(relative.slice(7));else canonical(relative, true);
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
      const destinationVaults=db.prepare("SELECT v.id,v.name FROM vaults v JOIN memberships m ON m.vault_id=v.id WHERE m.user_id=? AND v.status='active' ORDER BY v.name").all(user.id);
      for(const item of resources)if(!item.owned){
        const placement=db.prepare("SELECT d.vault_id,d.local_path FROM resource_destinations d JOIN vaults v ON v.id=d.vault_id WHERE d.resource_id=? AND d.user_id=? AND v.status='active'").get(item.id,user.id);
        item.destination=placement?.vault_id || null;item.localPath=placement?.local_path || item.name;item.folder=path.posix.dirname(item.localPath)==="."?"":path.posix.dirname(item.localPath);
      }
      return {ownedVaults,destinationVaults,resources,limits:{maxFileBytes,maxFileMiB:limits.maxFileMiB}};
    });
  }
  function checkPlacement(user,vaultId,localPath,id,kind,sourceName,placements) {
    canonical(localPath);
    if(kind==="file" && path.extname(localPath).toLowerCase()!==path.extname(sourceName).toLowerCase())fail("INVALID_SHARE_PATH");
    const v=vault(vaultId),parent=path.posix.dirname(localPath);
    const folder=inspect(v.path,parent==="."?"":parent);
    if(!folder.stat.isDirectory())fail("INVALID_SHARE_PATH");
    const name=path.posix.basename(localPath).toLowerCase();
    const directory=fs.opendirSync(folder.filename);let count=0;
    try{for(let entry;(entry=directory.readSync());){if(++count>10000)fail("SHARE_LIMIT");if(entry.name.toLowerCase()===name)fail("SHARE_PLACEMENT_CONFLICT");}}finally{directory.closeSync();}
    const lower=localPath.toLowerCase();
    for(const other of placements ?? db.prepare("SELECT d.resource_id,d.local_path FROM resource_destinations d JOIN shared_resources r ON r.id=d.resource_id WHERE d.user_id=? AND d.vault_id=?").all(user.id,vaultId)){
      if(other.resource_id===id)continue;
      const key=other.local_path.toLowerCase();
      if(lower===key || lower.startsWith(key+"/") || key.startsWith(lower+"/"))fail("SHARE_PLACEMENT_CONFLICT");
    }
    return localPath;
  }
  function destination(token,input) {
    if(Object.hasOwn(input,"folder") || Object.hasOwn(input,"name"))fail("INVALID_SHARE_PATH");
    return transaction(db,()=>{
      const access=resource(token,input.id),user=access.user;
      if(access.owns || !db.prepare("SELECT 1 FROM resource_grants WHERE resource_id=? AND user_id=?").get(input.id,user.id))fail();
      if(input.vault!==null){
        if(typeof input.vault!=="string" || !db.prepare("SELECT 1 FROM memberships m JOIN vaults v ON v.id=m.vault_id WHERE m.user_id=? AND v.id=? AND v.status='active'").get(user.id,input.vault))fail();
        const localPath=canonical(input.localPath ?? path.basename(access.row.path));
        checkPlacement(user,input.vault,localPath,input.id,access.row.kind,access.row.path);
        db.prepare("INSERT INTO resource_destinations(resource_id,user_id,vault_id,local_path) VALUES (?,?,?,?) ON CONFLICT(resource_id,user_id) DO UPDATE SET vault_id=excluded.vault_id,local_path=excluded.local_path").run(input.id,user.id,input.vault,localPath);
      }else db.prepare("DELETE FROM resource_destinations WHERE resource_id=? AND user_id=?").run(input.id,user.id);
      audit(user,"set-resource-destination",{id:input.id,vault:input.vault});return {ok:true};
    });
  }
  function mounts(token,input) {
    return transaction(db,()=>{
      const user=actor(token);
      if(typeof input?.vault!=="string" || !db.prepare("SELECT 1 FROM memberships m JOIN vaults v ON v.id=m.vault_id WHERE m.user_id=? AND v.id=? AND v.status='active'").get(user.id,input.vault))fail();
      vault(input.vault);
      const rows=db.prepare(`SELECT r.id,d.local_path FROM shared_resources r JOIN resource_grants g ON g.resource_id=r.id
        JOIN resource_destinations d ON d.resource_id=g.resource_id AND d.user_id=g.user_id
        WHERE d.vault_id=? AND g.user_id=? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.vault_id=r.vault_id AND m.user_id=? AND m.role='owner')
        ORDER BY r.id`).all(input.vault,user.id,user.id);
      if(rows.length>MAX_ENTRIES) fail("SHARE_LIMIT");
      // This synchronous transaction observes one placement snapshot. Reuse only
      // within this request; retain even stale grants for collision protection.
      const placements=db.prepare("SELECT d.resource_id,d.local_path FROM resource_destinations d JOIN shared_resources r ON r.id=d.resource_id WHERE d.user_id=? AND d.vault_id=?").all(user.id,input.vault);
      let total=0;
      const mounts=[];
      for(const row of rows) {
        let access;
        try {access=resource(token,row.id);} catch(error) {if(["SHARE_UNAVAILABLE","VAULT_UNAVAILABLE","ENOENT"].includes(error.code))continue;throw error;}
        const localPath=row.local_path;
        try{checkPlacement(user,input.vault,localPath,row.id,access.row.kind,access.row.path,placements);}catch{
          mounts.push({id:row.id,localPath,kind:access.row.kind,role:access.role,blocked:true,tree:{}});continue;
        }
        const tree=Object.create(null);
        function visit(relative,depth) {
          if(++total>5000 || depth>32) fail("SHARE_LIMIT");
          const item=relative?inspect(access.base.filename,relative):access.base;
          tree[relative]={type:item.stat.isDirectory()?"directory":"file",size:item.stat.size,mtime:item.stat.mtimeMs,ctime:item.stat.birthtimeMs};
          if(item.stat.isDirectory())for(const entry of listing(item).entries) visit(relative?relative+"/"+entry.name:entry.name,depth+1);
        }
        visit("",0);
        mounts.push({id:row.id,localPath,owner:db.prepare("SELECT u.login FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.vault_id=? AND m.role='owner'").get(access.v.id)?.login || "",name:path.basename(access.row.path),kind:access.row.kind,role:access.role,tree});
      }
      const outgoing=[];
      if(owner(user,input.vault))for(const row of db.prepare("SELECT id,path,kind FROM shared_resources r WHERE vault_id=? AND EXISTS (SELECT 1 FROM resource_grants g WHERE g.resource_id=r.id)").all(input.vault)){
        try{resource(token,row.id);outgoing.push({path:row.path,kind:row.kind});}
        catch(error){if(!["SHARE_UNAVAILABLE","VAULT_UNAVAILABLE","ENOENT"].includes(error.code))throw error;}
      }
      return {mounts,outgoing,limits:{maxFileBytes,maxFileMiB:limits.maxFileMiB}};
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
    if(item.stat.isDirectory()) return {...listing(item),kind:"directory",role:access.role,etag:directoryTag(item.stat)};
    await writeCoalescer.flushPending(item.filename);
    const current=resource(token,input.id,input.path || ""),bytes=readFile(target(current),maxFileBytes);
    return {kind:"file",role:current.role,name:path.basename(item.filename),content:bytes.toString("base64"),etag:digest(bytes)};
  }
  function renameDisk(user,v,oldPath,newPath,etag,trash=false) {
    canonical(oldPath);if(trash)canonical(newPath.slice(7));else canonical(newPath);
    if(oldPath===newPath || newPath.toLowerCase().startsWith(oldPath.toLowerCase()+"/"))fail("INVALID_SHARE_PATH");
    const crossDirectory=path.posix.dirname(oldPath)!==path.posix.dirname(newPath);
    let published=false;
    try{return transaction(db,()=>{
      const source=inspect(v.path,oldPath),destination=inspect(v.path,newPath,true,trash);
        if(destination.stat || writeCoalescer.hasPendingSubtree(source.filename) || writeCoalescer.hasPendingSubtree(destination.filename))fail("SHARE_CONFLICT");
        const expected=etag===undefined?undefined:source.stat.isDirectory()?directoryTag(source.stat):digest(readFile(source,maxFileBytes));
        if(etag!==undefined && etag!==expected)fail("SHARE_CONFLICT");
        const parent=path.dirname(source.filename),destinationParent=path.dirname(destination.filename),entries=fs.opendirSync(destinationParent);let count=0;
        try{for(let entry;(entry=entries.readSync());){if(++count>10000)fail("SHARE_LIMIT");if(entry.name.toLowerCase()===path.basename(destination.filename).toLowerCase())fail("SHARE_CONFLICT");}}finally{entries.closeSync();}
        let total=0;
        function validate(item,depth){if(++total>5000 || depth>32)fail("SHARE_LIMIT");if(!item.stat.isDirectory())return;const dir=fs.opendirSync(item.filename);try{for(let entry;(entry=dir.readSync());)validate(inspect(item.filename,canonical(entry.name)),depth+1);}finally{dir.closeSync();}}
        validate(source,0);
        const shares=db.prepare("SELECT * FROM shared_resources WHERE vault_id=?").all(v.id),affected=[];
        if(crossDirectory && !trash){
          // Moving must not silently add or remove access inherited from a folder
          // grant. Explicit grants within the moved subtree travel with that subtree.
          const enclosing=target=>shares.filter(row=>row.kind==="directory" && target.startsWith(row.path+"/")).map(row=>row.id).sort();
          const before=enclosing(oldPath),after=enclosing(newPath);
          if(!before.length || JSON.stringify(before)!==JSON.stringify(after))fail("SHARE_MOVE_BOUNDARY");
        }
        for(const row of shares){
          if(row.path.toLowerCase()===newPath.toLowerCase() || row.path.toLowerCase().startsWith(newPath.toLowerCase()+"/"))fail("SHARE_CONFLICT");
          if(row.path===oldPath || row.path.startsWith(oldPath+"/")){
            const item=inspect(v.path,row.path);if(String(item.stat.dev)!==row.device || identity(item.stat)!==row.inode)fail("SHARE_CONFLICT");
            affected.push(row);
          }
        }
        audit(user,trash?"trash-shared-content":"rename-shared-content",{vault:v.id,path:oldPath,to:newPath});
        fs.renameSync(source.filename,destination.filename);published=true;
        for(const directory of new Set([parent,destinationParent])){const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
        for(const row of affected){
          if(trash)db.prepare("DELETE FROM shared_resources WHERE id=?").run(row.id);
          else db.prepare("UPDATE shared_resources SET path=?,revision=revision+1 WHERE id=?").run(newPath+row.path.slice(oldPath.length),row.id);
        }
      return {ok:true};
    });}catch(error){if(published)fail("SHARE_RENAME_UNCERTAIN");throw error;}
  }
  async function rename(token,input) {
    const relative=canonical(input.path),to=canonical(input.to);
    function resolve(){
      const access=resource(token,input.id,relative,true);
      const oldPath=access.row.path+"/"+relative;
      const newPath=access.row.path+"/"+to;
      return {...access,oldPath,newPath};
    }
    const initial=resolve(),source=path.join(initial.v.path,initial.oldPath),dest=path.join(initial.v.path,initial.newPath);
    await writeCoalescer.flushPendingSubtree(source);await writeCoalescer.flushPendingSubtree(dest);
    return writeCoalescer.supersedePendingSubtree(source,()=>writeCoalescer.supersedePendingSubtree(dest,()=>{
      const fresh=resolve();if(initial.oldPath!==fresh.oldPath)fail("SHARE_CONFLICT");
      if(typeof input.etag!=="string")fail("SHARE_CONFLICT");
      return renameDisk(fresh.user,fresh.v,fresh.oldPath,fresh.newPath,input.etag);
    }));
  }
  // Called synchronously after the ordinary filesystem route has drained writes
  // and revalidated every permission. No gap for a new grant before disk mutation.
  function renameOriginal(token,reference,oldPath,newPath) {
    for(const value of [oldPath,newPath])if(["invalid","reserved","root"].includes(classifyVaultPath(value)))fail("INVALID_SHARE_PATH");
    const user=actor(token),v=vault(reference);
    if(!["owner","editor"].includes(db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(v.id,user.id)?.role))fail();
    const overlaps=(a,b)=>a===b || a.startsWith(b+"/") || b.startsWith(a+"/");
    const shared=db.prepare("SELECT path FROM shared_resources WHERE vault_id=?").all(v.id).some(row=>overlaps(row.path.toLowerCase(),oldPath.toLowerCase()) || overlaps(row.path.toLowerCase(),newPath.toLowerCase()));
    if(db.prepare("SELECT 1 FROM shared_resources WHERE vault_id=? AND path=?").get(v.id,oldPath) &&
      db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(v.id,user.id)?.role!=="owner")fail();
    if(shared)return renameDisk(user,v,oldPath,newPath,undefined,newPath.startsWith(".trash/") && !newPath.slice(7).includes("/"));
    fs.renameSync(path.join(v.path,oldPath),path.join(v.path,newPath));return {ok:true};
  }
  let activeCopies=0;
  async function copy(token,input) {
    if(activeCopies>=2)fail("SHARE_COPY_BUSY");
    activeCopies++;
    try{return await copyContent(token,input);}finally{activeCopies--;}
  }
  async function copyContent(token,input) {
    const overlaps=(a,b)=>a===b || a.startsWith(b+"/") || b.startsWith(a+"/");
    function select(selector,write) {
      if(!selector || typeof selector!=="object" || Array.isArray(selector) ||
        Object.keys(selector).sort().join(",")!=="id,path,vault" ||
        !((typeof selector.id==="string" && selector.vault===null) || (selector.id===null && typeof selector.vault==="string")))fail("INVALID_SHARE");
      canonical(selector.path,!write && selector.id!==null);
      if(selector.id!==null){
        const access=resource(token,selector.id,selector.path,write);
        return {user:access.user,v:access.v,item:target(access,write)};
      }
      const user=actor(token),v=vault(selector.vault);
      const role=db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(v.id,user.id)?.role;
      if(!(write?["owner","editor"]:["owner","editor","reader"]).includes(role))fail();
      // Virtual mounts cannot be resolved as ordinary physical paths or copied
      // accidentally as empty local containers. Select their grant explicitly.
      for(const row of db.prepare("SELECT local_path FROM resource_destinations WHERE vault_id=? AND user_id=?").all(v.id,user.id))
        if(overlaps(selector.path.toLowerCase(),row.local_path.toLowerCase()))fail("SHARE_PLACEMENT_CONFLICT");
      return {user,v,item:inspect(v.path,selector.path,write)};
    }
    function destination() {
      const selected=select(input.to,true),{filename,stat}=selected.item;
      if(stat || writeCoalescer.hasPendingSubtree(filename))fail("SHARE_CONFLICT");
      const dir=fs.opendirSync(path.dirname(filename));let count=0;
      try{for(let entry;(entry=dir.readSync());){if(++count>10000)fail("SHARE_LIMIT");if(entry.name.toLowerCase()===path.basename(filename).toLowerCase())fail("SHARE_CONFLICT");}}finally{dir.closeSync();}
      const relative=path.relative(selected.v.path,filename).split(path.sep).join("/");
      for(const row of db.prepare("SELECT path FROM shared_resources WHERE vault_id=?").all(selected.v.id))
        if(row.path.toLowerCase()===relative.toLowerCase() || row.path.toLowerCase().startsWith(relative.toLowerCase()+"/"))fail("SHARE_CONFLICT");
      return selected;
    }
    function scan(source) {
      const entries=[];let total=0;
      function visit(filename,relative,depth) {
        if(entries.length>=5000 || depth>32)fail("SHARE_LIMIT");
        const stat=fs.lstatSync(filename);
        if(stat.isSymbolicLink() || stat.dev!==source.item.stat.dev || (!stat.isDirectory()&&!stat.isFile()) || (stat.isFile()&&stat.nlink!==1))fail();
        if(stat.isFile()){if(stat.size>maxFileBytes)fail("SHARE_TOO_LARGE");total+=stat.size;if(total>128*1024*1024)fail("SHARE_LIMIT");}
        entries.push({filename,relative,stat});
        if(stat.isDirectory()) {const dir=fs.opendirSync(filename);try{for(let entry;(entry=dir.readSync());){canonical(entry.name);visit(path.join(filename,entry.name),relative?relative+"/"+entry.name:entry.name,depth+1);}}finally{dir.closeSync();}}
      }
      visit(source.item.filename,"",0);
      entries.sort((a,b)=>a.relative.localeCompare(b.relative));
      const revision=digest(JSON.stringify(entries.map(e=>[e.relative,e.stat.dev,identity(e.stat),e.stat.size,e.stat.mtimeMs,e.stat.ctimeMs])));
      return {entries,revision};
    }
    const first=select(input.from,false),initial=destination();
    if(overlaps(first.item.filename,initial.item.filename))fail("INVALID_SHARE_PATH");
    await writeCoalescer.flushPendingSubtree(first.item.filename);
    const source=select(input.from,false),dest=destination(),snapshot=scan(source);
    if(source.item.filename!==first.item.filename || dest.item.filename!==initial.item.filename)fail("SHARE_CONFLICT");
    const parent=path.dirname(dest.item.filename),parentStat=fs.lstatSync(parent);
    const stage=path.join(parent,".ignis-copy-"+randomUUID());let published=false;
    try {
      // Yield between bounded file copies so sessions and grants can be revoked.
      for(const entry of snapshot.entries){
        const output=entry.relative?path.join(stage,entry.relative):stage;
        if(entry.stat.isDirectory())fs.mkdirSync(output,{mode:0o700});
        else {const bytes=readFile(entry,maxFileBytes);const fd=fs.openSync(output,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
        await new Promise(resolve=>setImmediate(resolve));
        select(input.from,false);select(input.to,true);
      }
      const fresh=select(input.from,false),final=destination(),currentParent=fs.lstatSync(parent);
      if(fresh.item.filename!==source.item.filename || final.item.filename!==dest.item.filename || currentParent.dev!==parentStat.dev || identity(currentParent)!==identity(parentStat) ||
        writeCoalescer.hasPendingSubtree(source.item.filename) || scan(fresh).revision!==snapshot.revision)fail("SHARE_CONFLICT");
      for(const entry of [...snapshot.entries].reverse())if(entry.stat.isDirectory()){
        const fd=fs.openSync(entry.relative?path.join(stage,entry.relative):stage,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      }
      transaction(db,()=>{
        audit(final.user,"copy-content",{sourceVault:fresh.v.id,destinationVault:final.v.id,entries:snapshot.entries.length});
        fs.renameSync(stage,final.item.filename);published=true;
        const fd=fs.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      });
      return {ok:true};
    }catch(error){if(published)fail("SHARE_COPY_UNCERTAIN");throw error;}
    finally{if(!published)try{fs.rmSync(stage,{recursive:true,force:true});}catch{/* Reserved staging data stays inaccessible; never delete the destination. */}}
  }
  // Preview binds confirmation to the exact current subtree, not just its name.
  function removalSnapshot(token,input) {
    canonical(input.path); // A received root is never deletable through its grant.
    const access=resource(token,input.id,input.path,true),item=target(access);
    const hash=createHash("sha256");let files=0,folders=0;
    function visit(relative,depth=0) {
      if(depth>32 || files+folders>=5000)fail("SHARE_LIMIT");
      const entry=inspect(access.base.filename,relative),s=entry.stat;
      if(s.dev!==item.stat.dev)fail();
      hash.update(JSON.stringify([relative,s.dev,identity(s),s.size,s.mtimeMs,s.ctimeMs]));
      if(s.isDirectory()) {
        folders++;
        const names=fs.readdirSync(entry.filename).sort();
        if(names.length>5000)fail("SHARE_LIMIT");
        for(const name of names)visit(relative+"/"+name,depth+1);
      } else files++;
    }
    visit(input.path);
    const original=access.row.path+"/"+input.path;
    const affected=db.prepare("SELECT id,path,revision FROM shared_resources WHERE vault_id=? ORDER BY id").all(access.v.id)
      .filter(row=>row.path===original || row.path.startsWith(original+"/"));
    hash.update(JSON.stringify([access.row.id,access.role,affected]));
    return {access,item,affected,original,revision:hash.digest("hex"),files,folders};
  }
  async function previewRemoval(token,input) {
    const access=resource(token,input.id,canonical(input.path),true);
    await writeCoalescer.flushPendingSubtree(target(access).filename);
    const {revision,files,folders}=removalSnapshot(token,input);
    return {revision,files,folders};
  }
  async function removeConfirmed(token,input) {
    if(input.confirm!==true || typeof input.revision!=="string")fail("INVALID_SHARE");
    const access=resource(token,input.id,canonical(input.path),true),item=target(access);
    await writeCoalescer.flushPendingSubtree(item.filename);
    return writeCoalescer.supersedePendingSubtree(item.filename,()=>{
      const snapshot=removalSnapshot(token,input);
      if(snapshot.revision!==input.revision || writeCoalescer.hasPendingSubtree(snapshot.item.filename))fail("SHARE_CONFLICT");
      // Detach atomically before purging: a failed recursive purge cannot expose a
      // half-deleted tree or let old grants point at a replacement with this name.
      const retired=path.join(path.dirname(snapshot.item.filename),".ignis-delete-"+randomUUID());
      let detached=false;
      try {
        transaction(db,()=>{
          audit(snapshot.access.user,"delete-shared-content",{vault:snapshot.access.v.id,path:snapshot.original,files:snapshot.files,folders:snapshot.folders});
          for(const row of snapshot.affected)db.prepare("DELETE FROM shared_resources WHERE id=?").run(row.id);
          fs.renameSync(snapshot.item.filename,retired);detached=true;
          const fd=fs.openSync(path.dirname(retired),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
          try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        });
        fs.rmSync(retired,{recursive:true});
      } catch(error) {if(detached)fail("SHARE_DELETE_UNCERTAIN");throw error;}
      return {ok:true};
    });
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
        publish(current,bytes,fresh.v.id,fresh.row.kind==="file"?fresh.row.path:fresh.row.path+"/"+relative);

      }
      return {ok:true,...(bytes?{etag:digest(bytes)}:{})};
    });
  }
  // Both ordinary vault edits and resource recipients publish through this path.
  // There is no await between version validation, rename and identity update.
  function publish(current, bytes, vaultId, relative) {
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
          .run(String(replacement.dev),identity(replacement),vaultId, relative,String(current.stat.dev),identity(current.stat));
      });
    } catch(error) {if(published) fail("SHARE_WRITE_UNCERTAIN");throw error;}
    finally {try{fs.unlinkSync(temporary);}catch{/* Preserve the original failure; reserved temporary files are never shareable. */}}
  }
  async function writeOriginal(token, reference, relative, bytes, expectedHash) {
    if (expectedHash !== undefined && expectedHash !== null && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)))
      fail("CONTENT_VERSION_REQUIRED");
    function select() {
      const user=actor(token),v=vault(reference);
      canonical(relative);
      const role=db.prepare("SELECT role FROM memberships WHERE vault_id=? AND user_id=?").get(v.id,user.id)?.role;
      if (!["owner","editor"].includes(role)) fail();
      return {v,item:inspect(v.path,relative,true)};
    }
    const first=select();
    await writeCoalescer.flushPending(first.item.filename);
    return writeCoalescer.supersedePending(first.item.filename,()=>{
      const {v,item}=select();
      if(writeCoalescer.getPending(item.filename)!==null) fail("CONTENT_CONFLICT");
      let actual=null;
      if(item.stat) {
        if(!item.stat.isFile()) fail("CONTENT_CONFLICT");
        const fd=fs.openSync(item.filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        try {
          const before=fs.fstatSync(fd);
          if(before.dev!==item.stat.dev || before.ino!==item.stat.ino || before.nlink!==1) fail();
          const hash=createHash("sha256"),buffer=Buffer.alloc(65536);
          let offset=0;
          while(offset<before.size){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!n)fail("CONTENT_CONFLICT");hash.update(buffer.subarray(0,n));offset+=n;}
          const after=fs.fstatSync(fd);
          if(after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)fail("CONTENT_CONFLICT");
          actual=hash.digest("hex");
        } finally {fs.closeSync(fd);}
      }
      if(expectedHash!==undefined && actual!==expectedHash)fail("CONTENT_CONFLICT");
      publish(item,bytes,v.id,relative);
      const stat=fs.lstatSync(item.filename);
      return {ok:true,etag:digest(bytes),mtime:stat.mtimeMs,size:stat.size};
    });
  }
  return {catalog,mounts,destination,create,grant,browseOwner,read,rename,renameOriginal,writeOriginal,copy,previewRemoval,removeConfirmed,mutate,limits};
}
module.exports={createResourceSharesService};
