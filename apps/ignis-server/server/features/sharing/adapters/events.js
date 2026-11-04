const {createStateEvents}=require('../application/state-events');
const {observeIdentityDatabase}=require('./database-watch');
function createSharingEvents({dataRoot,store,sessions,entries,valid,failed,observeDatabase=observeIdentityDatabase}){
 const hub=createStateEvents({resolve:token=>sessions.resolve(token),snapshot:store.snapshot,valid,entries});
 let closed=false,watchHealthy=true,stateTimer,contentTimer,updateSources=()=>{},stopSources=()=>{};
 const pending=new Map();
 function schedule(){
  if(closed||stateTimer)return;
  stateTimer=setTimeout(()=>{
   stateTimer=null;if(closed)return;
   try{hub.reconcile();updateSources();}catch{failed();for(const ws of entries.keys())valid(ws);}
  },25);stateTimer.unref();
 }
 const stopDatabase=observeDatabase({dataRoot,changed:schedule,unavailable:()=>{
  watchHealthy=false;failed('watch');for(const ws of entries.keys())ws.terminate();
 },recovered:()=>{watchHealthy=true;schedule();}});
 function observeSources(watcher,getVaultPath){
  stopSources();const watched=new Map();
  updateSources=()=>{
   const users=new Set([...entries.values()].filter(entry=>entry.events).map(entry=>sessions.resolve(entry.token)?.user.id).filter(Boolean));
   const wanted=store.sources(users);
   for(const [directory,listener]of watched)if(!wanted.has(directory)){watcher.removeListener(directory,listener);watched.delete(directory);}
   for(const directory of wanted)if(!watched.has(directory)){
    const root=getVaultPath(directory);if(!root)continue;
    const listener=()=>{};watcher.startWatching(directory,root);watcher.addListener(directory,listener);watched.set(directory,listener);
   }
  };
  const rebuilt=directory=>{if(watched.delete(directory))schedule();};watcher.onWatcherRebuild(rebuilt);
  stopSources=()=>{watcher.offWatcherRebuild(rebuilt);for(const [directory,listener]of watched)watcher.removeListener(directory,listener);watched.clear();};
  schedule();
 }
 function contentChanged(directory,event){
  if(closed||!event?.path||event.path.split('/').some(part=>part.startsWith('.')))return;
  if(!pending.has(directory))pending.set(directory,new Set());const paths=pending.get(directory);
  if(!paths.has('')){paths.add(event.path);if(paths.size>128){paths.clear();paths.add('');}}
  if(contentTimer)return;
  contentTimer=setTimeout(()=>{
   contentTimer=null;if(closed)return;
   const batch=new Map(pending);pending.clear();
   try{
    const users=new Set();
    // Resolve recipients at delivery, after any concurrent revocation has committed.
    for(const [source,paths]of batch)for(const user of store.affectedUsers(source,paths))users.add(user);
    hub.sharedContent(users);
   }catch{failed();for(const ws of entries.keys())valid(ws);}
  },50);contentTimer.unref();
 }
 function close(){if(closed)return;closed=true;clearTimeout(stateTimer);clearTimeout(contentTimer);pending.clear();stopDatabase();stopSources();updateSources=()=>{};}
 return Object.freeze({available:()=>!closed&&watchHealthy,capture:hub.capture,schedule,observeSources,contentChanged,close});
}
module.exports={createSharingEvents};
