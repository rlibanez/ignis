const {sessionContext,matchesSession}=require('../../../../../../packages/contracts/src/session');
const reads=new Set(['catalog','history','mounts','validateGrant','browseOwner','read','previewRemoval']);
const operations=[...reads,'destination','create','grants','revoke','rename','renameOriginal','copy','removeConfirmed','mutate'];
const unavailable=()=>{throw Object.assign(new Error('Shared resource unavailable'),{code:'SHARE_UNAVAILABLE'});};
function createSharing({store,sessions,onChanged=()=>{},onNotificationError=()=>{}}){
 function changed(){try{onChanged();}catch(error){try{onNotificationError(error);}catch{/* Notification failure must not change a committed result. */}}}
 function execute(token,operation,...input){
  if(!operations.includes(operation))unavailable();
  const context=sessionContext(sessions.resolve(token));
  const credential=Object.freeze({token,context});
  const complete=value=>{
   // The adapter checks this same context again inside transactional effects.
   if(!reads.has(operation))changed();
   if(!matchesSession(context,sessions.resolve(token)))unavailable();
   return value;
  };
  const failed=error=>{if(error.outcome==='uncertain' || error.code?.endsWith('_UNCERTAIN'))changed();throw error;};
  try{
   const result=store[operation](credential,...input);
   return result && typeof result.then==='function'?result.then(complete,failed):complete(result);
  }catch(error){return failed(error);}
 }
 return Object.freeze({limits:store.limits,execute,...Object.fromEntries(operations.map(operation=>[operation,(token,...input)=>execute(token,operation,...input)]))});
}
module.exports={createSharing};
