const {Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');const {createGunzip,createInflate}=require('node:zlib');
function importBody(req,limit){
 const encoding=(req.headers['content-encoding']||'identity').toLowerCase();
 if(!['identity','gzip','deflate'].includes(encoding))throw Object.assign(Error('Import encoding'),{status:415});
 const declared=req.headers['content-length'];if(encoding==='identity'&&declared!==undefined&&Number(declared)>limit)throw Object.assign(Error('Import limit'),{code:'IMPORT_LIMIT'});
 if(encoding==='identity')return req;
 let size=0;const wire=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;callback(size>Math.max(65536,2*limit)?Object.assign(Error('Import limit'),{code:'IMPORT_LIMIT'}):null,chunk);}}),decoder=encoding==='gzip'?createGunzip():createInflate();
 pipeline(req,wire,decoder).catch(()=>{});return decoder;
}
module.exports={importBody};
