const {inflateRaw}=require('node:zlib');
const {promisify}=require('node:util');
const inflate=promisify(inflateRaw);
const {fail}=require('../application/import-policy');
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
async function crc(bytes){let n=0xffffffff;for(let start=0;start<bytes.length;start+=1048576){const end=Math.min(bytes.length,start+1048576);for(let i=start;i<end;i++)n=table[(n^bytes[i])&255]^(n>>>8);if(end<bytes.length)await new Promise(resolve=>setImmediate(resolve));}return (n^0xffffffff)>>>0;}
function readZip(bytes){
 if(!Buffer.isBuffer(bytes))fail('IMPORT_ZIP');const parser=require('./zip-index').zipIndex(bytes.length);let step=parser.next();
 while(!step.done){const [offset,length]=step.value;if(offset<0||length<0||offset+length>bytes.length)fail('IMPORT_ZIP');step=parser.next(bytes.subarray(offset,offset+length));}return step.value;
}
async function zipFile(bytes,entry){
 let result;try{const raw=bytes.subarray(entry.start,entry.start+entry.compressed);result=entry.method===0?raw:await inflate(raw,{maxOutputLength:Math.max(1,entry.size)});}catch{fail('IMPORT_ZIP');}
 if(result.length!==entry.size||(await crc(result))!==entry.checksum)fail('IMPORT_ZIP');return result;
}
module.exports={readZip,zipFile};
