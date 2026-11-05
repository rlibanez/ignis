// Explicit test setup only; production incorporates existing files through import.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {ownedDirectory,ensureUserDirectory,storagePath}=require('../../features/vaults/adapters/vault-storage');
function registerExistingVault(db,root,name,ownerId){
 const directory=ownedDirectory(db,ownerId,name),target=path.join(root,directory),source=path.join(root,name);
 ensureUserDirectory(root,directory);
 if(fs.existsSync(source)){const st=fs.lstatSync(source);if(st.isSymbolicLink()||!st.isDirectory())throw Error('Invalid directory');fs.renameSync(source,target);}
 else if(!fs.existsSync(target))fs.mkdirSync(target);
 storagePath(root,directory);
 const id=randomUUID();db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES (?,?,?,'active',0)").run(id,name,directory);
 db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").run(id,ownerId);
 return {id,name,directory,path:target};
}
module.exports={registerExistingVault};
