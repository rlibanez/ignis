const {resolveRegisteredVault,listRegisteredVaults}=require('./vault-catalog');
const {createVaultMembersService}=require('./vault-members');
const {createRegisteredVault,directoryAvailable}=require('./vault-creation');
const {renameRegisteredVault}=require('./vault-rename');
const {deleteRegisteredVault}=require('./vault-deletion');
const {resolveVaultRequest,resolvePluginVaultRequest}=require('./vault-request');
function createVaultStore(db,root,sessions){
 const members=createVaultMembersService(db,root,sessions);
 return Object.freeze({
  resolve:reference=>resolveRegisteredVault(db,root,reference),
  catalog:()=>{
   const result=Object.create(null);
   for(const row of listRegisteredVaults(db))if(row.status==='active') {
    try {const vault=resolveRegisteredVault(db,root,row.id);result[vault.directory]=vault.path;}catch {/* Unavailable storage is not discovered. */}
   }
   return result;
  },
  directoryAvailable:directory=>directoryAvailable(db,directory,root),
  resolveRequest:(query,body)=>resolveVaultRequest(db,root,query,body),
  resolvePluginRequest:(query,body,field)=>resolvePluginVaultRequest(db,root,query,body,field),
  membership:(id,user)=>db.prepare('SELECT role FROM memberships WHERE vault_id=? AND user_id=?').get(id,user)?.role,
  owners:()=>db.prepare("SELECT id,login FROM users WHERE status='active' ORDER BY login,id").all(),
  username:id=>db.prepare('SELECT login FROM users WHERE id=?').get(id)?.login,
  state:reference=>({registered:db.prepare('SELECT id FROM vaults WHERE id=? OR directory=?').get(reference,reference)?.id,
   deletion:db.prepare('SELECT state FROM vault_deletions WHERE vault_id=?').get(reference)?.state}),
  create:(actor,name,isCurrent)=>createRegisteredVault(db,root,actor,name,{isCurrent}),
  rename:(actor,reference,name,lifecycle,isCurrent)=>renameRegisteredVault(db,root,actor,reference,name,{...lifecycle,isCurrent}),
  delete:(actor,reference,lifecycle,isCurrent)=>deleteRegisteredVault(db,root,actor,reference,{...lifecycle,isCurrent}),
  members,
 });
}
module.exports={createVaultStore};
