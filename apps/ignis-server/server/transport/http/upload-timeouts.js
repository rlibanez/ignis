// Node's parser deadline is global. Keep the ordinary five-minute deadline in
// userland; only an authenticated, leased import may opt into the longer one.
const grants=new WeakMap();
const ordinaryMs=5*60*1000,uploadMs=60*60*1000;
function installUploadTimeouts(server,{ordinary=ordinaryMs,upload=uploadMs}={}){
 server.requestTimeout=upload; // includes headers; headers retain their own bound
 server.headersTimeout=Math.min(60000,ordinary);
 server.prependListener('request',(req,res)=>{
  let timer,ended=false;const started=Date.now();
  const expire=()=>{if(res.headersSent){req.destroy();return;}res.statusCode=408;res.setHeader('Connection','close');res.once('finish',()=>req.destroy());res.end();};
  const deadline=duration=>{clearTimeout(timer);if(!ended){timer=setTimeout(expire,Math.max(1,duration-(Date.now()-started)));timer.unref?.();}};
  const clear=()=>{ended=true;clearTimeout(timer);grants.delete(req);};
  grants.set(req,()=>deadline(upload));deadline(ordinary);
  req.once('end',clear);req.once('close',clear);res.once('finish',()=>{grants.delete(req);if(req.complete||req.readableEnded)clear();else deadline(ordinary);});res.once('close',clear);
 });
}
function permitImportUpload(req){grants.get(req)?.();}
module.exports={installUploadTimeouts,permitImportUpload,uploadMs};
