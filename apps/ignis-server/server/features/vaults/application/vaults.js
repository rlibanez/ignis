const {sessionContext,matchesSession}=require('../../../../../../packages/contracts/src/session');
const unavailable=()=>{throw Object.assign(new Error('Vault unavailable'),{code:'VAULT_UNAVAILABLE'});};
// Request-scoped authority is pinned to a session, never to request-supplied actor IDs.
// The adapters repeat authorization inside transactions immediately before effects.
function createVaults({store,sessions,access,createView}){
 function scope(token){
  const original=sessions.resolve(token);if(!original)unavailable();
  const context=sessionContext(original);
  const current=(withinTransaction=false)=>matchesSession(context,sessions.resolve(token,{withinTransaction}));
  const guard=()=>{if(!current())unavailable();};
  const admin=()=>{guard();if(context.role!=='admin')unavailable();};
  const sameContext=decision=>Object.keys(context).every(key=>decision.context?.[key]===context[key]);
  const authorize=(reference,capability='content.list',path='')=>{
   // Access resolves the live session inside its transaction. Reuse that fresh
   // decision instead of resolving the same session twice for every tree entry.
   const decision=access.check(token,{reference,capability,path});
   if(decision.allowed&&!sameContext(decision))unavailable();
   return decision;
  };
  const check=(reference,capability='content.list',path='')=>authorize(reference,capability,path).allowed;
  const resolve=reference=>{if(!check(reference))unavailable();return store.resolve(reference);};
  const uuid=reference=>resolve(reference).id;
  const viewed=new Set();
  const visible=reference=>{
   const decision=authorize(reference);
   if(decision.allowed)viewed.add(decision.vaultId);
   return decision.allowed;
  };
  const revalidateView=()=>current()&&[...viewed].every(reference=>{
   const decision=access.check(token,{reference,capability:'content.list',path:''});
   return decision.allowed&&sameContext(decision);
  });
  return Object.freeze({
   context,check,authorize,resolve,revalidateView,
   exportAuthority:reference=>{
    const vault=resolve(reference);
    const validate=()=>{
     guard();const live=store.resolve(vault.id);
     if(store.membership(vault.id,context.userId)!=='owner' || live.path!==vault.path || live.policy_version!==vault.policy_version)unavailable();
    };
    validate();return {actor:context.userId,name:vault.name,path:vault.path,validate};
   },
   project:(reference,operations)=>{
    const decision=access.project(token,reference,operations);
    if(decision.allowed&&!sameContext(decision))unavailable();
    return decision;
   },
   resolveRequest:(query,body)=>{guard();return store.resolveRequest(query,body);},
   resolvePluginRequest:(query,body,field)=>{admin();return store.resolvePluginRequest(query,body,field);},
   state:reference=>{guard();return store.state(reference);},
   uuid,
   owners:()=>{admin();return store.owners();},
   create:name=>{guard();return store.create(context.userId,name,current);},
   rename:(reference,name,lifecycle)=>{guard();return store.rename(context.userId,reference,name,lifecycle,current);},
   delete:(reference,lifecycle)=>{guard();return store.delete(context.userId,reference,lifecycle,current);},
   members:(operation,input,lifecycle)=>{
    guard();if(!['list','update','transfer'].includes(operation))unavailable();
    return store.members[operation](token,input,lifecycle);
   },
   logDetails:(operation,input)=>{
    const reference=operation==='list'?input:input.vault;
    return {directory:resolve(reference).directory,username:operation==='transfer'?store.username(input.userId):input.login};
   },
   view:createView({administrator:context.role==='admin',authorize:visible,uuid,
    membership:reference=>store.membership(uuid(reference),context.userId)}),
  });
 }
 return Object.freeze({scope});
}
module.exports={createVaults};
