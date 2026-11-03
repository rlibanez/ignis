const express=require('express');
function createImportRouter(service,{refresh=()=>{}}={}){
 const manifest=express.json({limit:'4mb',strict:true}),json=express.json({limit:'8kb',strict:true});
 const zipBody=express.raw({type:'application/octet-stream',limit:'64mb'}),fileBody=express.raw({type:'application/octet-stream',limit:'32mb'});
 const router=express.Router();
 function parseSelection(value){try{if(typeof value!=='string'||value.length>1024)throw Error();return JSON.parse(value);}catch{throw Object.assign(Error('Invalid selection'),{code:'IMPORT_REQUEST'});}}
 async function route(req,res){
  const operation=req.route.path.split('/').pop();
  let scope,release=()=>{};try{scope=service.scope(req.importToken);await scope.prepare();if(operation==='file'||operation==='commit'||operation==='select'||(operation==='cancel'&&req.query.id)){const job=scope.inspect(req.query.id,operation==='commit');if(operation!=='cancel'&&job.busy)throw Error('Busy');}}catch{return res.status(404).json({error:'Import unavailable'});}
  res.once('close',()=>{if(!res.writableEnded){release();scope.abort();}});
  const binary=operation==='file'||operation==='zip';
  if(!req.is(binary?'application/octet-stream':'application/json'))return res.status(415).json({error:'Invalid import content type'});
  try{if(binary||operation==='start'||operation==='select')release=scope.claim(operation==='zip'?'zip':'upload');}catch{return res.status(429).json({error:'Another import is in progress. Try again later.'});}
  const parse=binary?(operation==='zip'?zipBody:fileBody):operation==='start'?manifest:json;
  try{await new Promise((resolve,reject)=>parse(req,res,error=>error?reject(error):resolve()));}
  catch(error){release();return res.status(error.status===413?413:400).json({error:'Invalid or oversized import'});}
   try{
    let result;
    if(operation==='start'&&Object.keys(req.query).length===0)result=await scope.begin(req.body);
    else if(operation==='zip'&&['configuration,name','attempt,configuration,name','configuration,name,selected','attempt,configuration,name,selected'].includes(Object.keys(req.query).sort().join(','))&&['true','false'].includes(req.query.configuration))result=await scope.zip({name:req.query.name,configuration:req.query.configuration==='true',...(Object.hasOwn(req.query,'selected')?{selected:parseSelection(req.query.selected)}:{}),...(req.query.attempt?{attempt:req.query.attempt}:{})},req.body);
    else if(operation==='file'&&Object.keys(req.query).sort().join(',')==='id,index'&&/^\d+$/.test(req.query.index))result=await scope.put(req.query.id,Number(req.query.index),req.body);
    else if(operation==='select'&&Object.keys(req.query).join(',')==='id'&&req.body&&!Array.isArray(req.body)&&Object.keys(req.body).join(',')==='selected')result=await scope.select(req.query.id,req.body.selected);
    else if(operation==='cancel'&&Object.keys(req.query).length===0&&req.body&&Object.keys(req.body).join(',')==='attempt')result=await scope.cancelAttempt(req.body.attempt);
    else if(['commit','cancel'].includes(operation)&&Object.keys(req.query).join(',')==='id'&&req.body&&!Array.isArray(req.body)&&Object.keys(req.body).length===0)result=await scope[operation](req.query.id);
    else return res.status(400).json({error:'Invalid import request'});
    if(operation==='commit'){try{refresh();}catch{/* Publication already succeeded; listing retries discovery. */}}return res.json(result);
   }catch(error){const status={SESSION_CHANGED:401,IMPORT_UNAVAILABLE:404,IMPORT_LIMIT:413,IMPORT_BUSY:429,VAULT_EXISTS:409}[error.code]||(/^IMPORT_(PATH|ZIP|COLLISION|CONFIGURATION|INCOMPLETE|EMPTY|REQUEST)$/.test(error.code)?400:503);return res.status(status).json({error:({IMPORT_REQUEST:'Check the vault name and selected files.',IMPORT_EMPTY:'No importable files were found.',VAULT_EXISTS:'A vault with this name already exists.',IMPORT_PATH:'Unsafe or unsupported file path.',IMPORT_ZIP:'Invalid or unsupported ZIP. Use a standard, unencrypted ZIP with UTF-8 filenames.',IMPORT_LIMIT:'Import limit exceeded.',IMPORT_COLLISION:'Conflicting file paths.',IMPORT_CONFIGURATION:'Invalid Obsidian preferences.',IMPORT_INCOMPLETE:'Upload is incomplete.',IMPORT_BUSY:'Another import is in progress. Try again later.'})[error.code]||'Import could not be completed.'});}finally{release();}
 }
 router.post('/api/vault/import/start',route);
 router.post('/api/vault/import/zip',route);
 router.post('/api/vault/import/file',route);
 router.post('/api/vault/import/commit',route);
 router.post('/api/vault/import/cancel',route);
 router.post('/api/vault/import/select',route);
 return router;
}
module.exports={createImportRouter};
