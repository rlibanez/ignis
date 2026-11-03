const fs=require('node:fs');const path=require('node:path');
function observeIdentityDatabase({dataRoot,changed,unavailable,recovered=changed,watch=fs.watch,setTimer=setTimeout,clearTimer=clearTimeout}){
 let observer,timer,closed=false,delay=1000,failed=false;
 function open(){
  if(closed)return;
  try{
   const current=watch(path.join(dataRoot,'auth'),(_event,name)=>{
    if(!closed&&observer===current&&(!name||['identity.sqlite','identity.sqlite-wal','identity.sqlite-journal'].includes(String(name))))changed();
   });
   observer=current;
   current.on('error',()=>{if(observer===current)broken();});
   current.on('close',()=>{if(observer===current)broken();});
   delay=1000;if(failed){failed=false;recovered();}
  }catch{broken();}
 }
 function broken(){
  if(closed)return;
  const previous=observer;observer=null;previous?.close();failed=true;unavailable();
  if(timer)return;
  timer=setTimer(()=>{timer=null;open();},delay);timer.unref?.();delay=Math.min(30000,delay*2);
 }
 open();
 return ()=>{if(closed)return;closed=true;clearTimer(timer);observer?.close();observer=null;};
}
module.exports={observeIdentityDatabase};
