const {writeCoalescer}=require('@ignis/server-core');
const {createContentReplacement}=require('../application/replace');
const {createContentPublisher}=require('./publication');
const {inspect,canonical}=require('./content-path');
const {resolveRegisteredVault}=require('../../vaults/adapters/vault-catalog');
const {vaultCapabilityAllowed}=require('../../vaults/application/vault-policy');
const {sessionContext,matchesSession}=require('../../../../../../packages/contracts/src/session');
const fail=()=>{throw Object.assign(new Error('Content unavailable'),{code:'SHARE_UNAVAILABLE'});};
function createContentRuntime({db,root,sessions,queue=writeCoalescer,io}){
  const replacement=createContentReplacement({queue,publisher:createContentPublisher(db,{io})});
  function selector(token,reference,relative){
    canonical(relative);
    const context=sessionContext(sessions.resolve(token));
    const select=()=>{
      const session=sessions.resolve(token,{withinTransaction:true});
      if(!matchesSession(context,session))fail();
      const user=db.prepare('SELECT role,status,auth_version FROM users WHERE id=?').get(context.userId);
      if(!user || user.status!=='active' || user.role!==context.role || user.auth_version!==context.authVersion)fail();
      const vault=resolveRegisteredVault(db,root,reference);
      if(vault.id!==reference)fail();
      const role=db.prepare('SELECT role FROM memberships WHERE vault_id=? AND user_id=?').get(vault.id,context.userId)?.role;
      if(!vaultCapabilityAllowed({status:user.status,instanceRole:user.role,membership:role,capability:'content.write',path:relative}))fail();
      return {item:inspect(vault.path,relative,true),vaultId:vault.id,relative,actorId:context.userId,rootPath:vault.path};
    };
    return select;
  }
  async function writeOriginal(token,reference,relative,bytes,expectedHash){
    return replacement.replace({select:selector(token,reference,relative),bytes,expectedHash});
  }
  async function appendOriginal(token,reference,relative,bytes){
    return replacement.replace({select:selector(token,reference,relative),bytes,mode:'append'});
  }
  async function copyOriginal(token,reference,source,destination){
    canonical(source);
    if(source===destination)throw Object.assign(new Error('Invalid copy'),{code:'CONTENT_CONFLICT'});
    const destinationPlan=selector(token,reference,destination);
    return replacement.replace({mode:'copy',bytes:Buffer.alloc(0),select:()=>{
      const selected=destinationPlan();
      return {...selected,sourceItem:inspect(selected.rootPath,source)};
    }});
  }
  return Object.freeze({...replacement,writeOriginal,appendOriginal,copyOriginal});
}
module.exports={createContentRuntime};
