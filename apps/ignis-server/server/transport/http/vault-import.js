const express=require('express');
function createImportRouter(service,{refresh=()=>{}}={}){
 const manifest=express.json({limit:'4mb',strict:true}),json=express.json({limit:'8kb',strict:true});
 const {importBody}=require('./import-body');const {permitImportUpload}=require('./upload-timeouts');const limits=service.limits;
 const router=express.Router();
 function parseSelection(value){try{if(typeof value!=='string'||value.length>1024)throw Error();return JSON.parse(value);}catch{throw Object.assign(Error('Invalid selection'),{code:'IMPORT_REQUEST'});}}
 async function route(req,res){
  const operation=req.route.path.split('/').pop();
  let scope,release=()=>{};try{scope=service.scope(req.importToken);await scope.prepare();if(operation==='file'||operation==='commit'||operation==='select'||(operation==='cancel'&&req.query.id)){const job=scope.inspect(req.query.id,operation==='commit');if(operation!=='cancel'&&job.busy)throw Error('Busy');}}catch{return res.status(404).json({error:'Import unavailable'});}
  res.once('close',()=>{if(!res.writableEnded)scope.abort();});
  const binary=['file','zip','scan-zip'].includes(operation);
  if(!req.is(binary?'application/octet-stream':'application/json'))return res.status(415).json({error:'Invalid import content type'});
  try{if(binary||['start','select','scan','review','prepare'].includes(operation))release=scope.claim(['zip','scan-zip'].includes(operation)?'zip':'upload');}catch{return res.status(429).json({error:'Another import is in progress. Try again later.'});}
  let body;
  if(binary){
   try{body=importBody(req,operation==='file'?limits.fileBytes:limits.zipBytes);permitImportUpload(req);req.setTimeout?.(120000,()=>scope.abort());req.once('end',()=>req.setTimeout?.(0));}
   catch(error){release();res.set('Connection','close');return res.status(error.status||413).json({error:'Invalid or oversized import'});}
  }else{
   const parse=['start','scan'].includes(operation)?manifest:json;
   try{await new Promise((resolve,reject)=>parse(req,res,error=>error?reject(error):resolve()));}
   catch(error){release();return res.status(error.status===413?413:400).json({error:'Invalid or oversized import'});}
  }
   try{
    let result;
    if(operation==='scan'&&Object.keys(req.query).length===0)result=await scope.scan(req.body);
    else if(operation==='scan-zip'&&Object.keys(req.query).join(',')==='attempt')result=await scope.scanStream({attempt:req.query.attempt},body);
    else if(operation==='review'&&Object.keys(req.query).length===0)result=await scope.reviewSource(req.body);
    else if(operation==='prepare'&&Object.keys(req.query).length===0)result=await scope.prepareSource(req.body);
    else if(operation==='cancel-source'&&Object.keys(req.query).length===0)result=await scope.cancelSource(req.body);
    else if(operation==='start'&&Object.keys(req.query).length===0)result=await scope.begin(req.body);
    else if(operation==='zip'&&['configuration,name','attempt,configuration,name','configuration,name,selected','attempt,configuration,name,selected'].includes(Object.keys(req.query).sort().join(','))&&['true','false'].includes(req.query.configuration))result=await scope.zipStream({name:req.query.name,configuration:req.query.configuration==='true',...(Object.hasOwn(req.query,'selected')?{selected:parseSelection(req.query.selected)}:{}),...(req.query.attempt?{attempt:req.query.attempt}:{})},body);
    else if(operation==='file'&&Object.keys(req.query).sort().join(',')==='id,index'&&/^\d+$/.test(req.query.index))result=await scope.putStream(req.query.id,Number(req.query.index),body);
    else if(operation==='select'&&Object.keys(req.query).join(',')==='id'&&req.body&&!Array.isArray(req.body)&&Object.keys(req.body).join(',')==='selected')result=await scope.select(req.query.id,req.body.selected);
    else if(operation==='cancel'&&Object.keys(req.query).length===0&&req.body&&Object.keys(req.body).join(',')==='attempt')result=await scope.cancelAttempt(req.body.attempt);
    else if(['commit','cancel'].includes(operation)&&Object.keys(req.query).join(',')==='id'&&req.body&&!Array.isArray(req.body)&&Object.keys(req.body).length===0)result=await scope[operation](req.query.id);
    else {if(binary)res.set('Connection','close');return res.status(400).json({error:'Invalid import request'});}
    if(operation==='commit'){try{refresh();}catch{/* Publication already succeeded; listing retries discovery. */}}return res.json(result);
   }catch(error){if(res.destroyed||res.writableEnded)return;if(binary)res.set('Connection','close');const status={SESSION_CHANGED:401,IMPORT_UNAVAILABLE:404,IMPORT_LIMIT:413,IMPORT_BUSY:429,VAULT_EXISTS:409,IMPORT_SPACE:507}[error.code]||(/^IMPORT_(PATH|ZIP|COLLISION|CONFIGURATION|INCOMPLETE|EMPTY|REQUEST)$/.test(error.code)?400:503);return res.status(status).json({error:({IMPORT_SPACE:'Not enough free space to import the vault.',IMPORT_REQUEST:'Check the vault name and selected files.',IMPORT_EMPTY:'No importable files were found.',VAULT_EXISTS:'A vault with this name already exists.',IMPORT_PATH:'Unsafe or unsupported file path.',IMPORT_ZIP:'Invalid or unsupported ZIP. Use a standard, unencrypted ZIP with UTF-8 filenames.',IMPORT_LIMIT:'Import limit exceeded.',IMPORT_COLLISION:'Conflicting file paths.',IMPORT_CONFIGURATION:'Invalid Obsidian preferences.',IMPORT_INCOMPLETE:'Upload is incomplete.',IMPORT_BUSY:'Another import is in progress. Try again later.'})[error.code]||'Import could not be completed.'});}finally{release();if(body&&body!==req){if(res.writableFinished||res.destroyed)body.destroy();else res.once('finish',()=>body.destroy());}}
 }
 router.post('/api/vault/import/scan',route);
 router.post('/api/vault/import/scan-zip',route);
 router.post('/api/vault/import/review',route);
 router.post('/api/vault/import/prepare',route);
 router.post('/api/vault/import/cancel-source',route);

 router.post('/api/vault/import/start',route);
 router.post('/api/vault/import/zip',route);
 router.post('/api/vault/import/file',route);
 router.post('/api/vault/import/commit',route);
 router.post('/api/vault/import/cancel',route);
 router.post('/api/vault/import/select',route);
 return router;
}
module.exports={createImportRouter};
