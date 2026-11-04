const {inflateRaw}=require('node:zlib');
const {promisify}=require('node:util');
const inflate=promisify(inflateRaw);
const {limits,fail,importPath}=require('../application/import-policy');
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
async function crc(bytes){let n=0xffffffff;for(let start=0;start<bytes.length;start+=1048576){const end=Math.min(bytes.length,start+1048576);for(let i=start;i<end;i++)n=table[(n^bytes[i])&255]^(n>>>8);if(end<bytes.length)await new Promise(resolve=>setImmediate(resolve));}return (n^0xffffffff)>>>0;}
function readZip(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>limits.zipBytes||bytes.length<22)fail('IMPORT_ZIP');
 let end=bytes.length-22;for(;end>=Math.max(0,bytes.length-65557);end--)if(bytes.readUInt32LE(end)===0x06054b50&&end+22+bytes.readUInt16LE(end+20)===bytes.length)break;
 if(end<0||(bytes.readUInt32LE(end)!==0x06054b50||end+22+bytes.readUInt16LE(end+20)!==bytes.length))fail('IMPORT_ZIP');
 const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||count!==bytes.readUInt16LE(end+8)||count===65535||count>limits.files||offset+size!==end)fail('IMPORT_ZIP');
 let cursor=offset,total=0;const entries=[],ranges=[],declared=new Set();
 for(let i=0;i<count;i++){
  if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)fail('IMPORT_ZIP');
  const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),checksum=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),length=bytes.readUInt32LE(cursor+24),nl=bytes.readUInt16LE(cursor+28),el=bytes.readUInt16LE(cursor+30),cl=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42),mode=bytes.readUInt32LE(cursor+38)>>>16;
  if(cursor+46+nl+el+cl>end||(flags&~0x080e)!==0||![0,8].includes(method)||length>limits.fileBytes||compressed>limits.zipBytes||bytes.readUInt16LE(cursor+34)||(mode&0xf000)&&![0x8000,0x4000].includes(mode&0xf000))fail('IMPORT_ZIP');
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(cursor+46,cursor+46+nl));}catch{fail('IMPORT_ZIP');}
  const directory=name.endsWith('/'),key=importPath(directory?name.slice(0,-1):name).toLowerCase();if(declared.has(key))fail('IMPORT_COLLISION');declared.add(key);
  for(let x=cursor+46+nl;x<cursor+46+nl+el;){if(x+4>cursor+46+nl+el||bytes.readUInt16LE(x)===1)fail('IMPORT_ZIP');const next=x+4+bytes.readUInt16LE(x+2);if(next>cursor+46+nl+el)fail('IMPORT_ZIP');x=next;}
  if(local+30>offset||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)fail('IMPORT_ZIP');
  const lnl=bytes.readUInt16LE(local+26),lel=bytes.readUInt16LE(local+28),start=local+30+lnl+lel;
  if(start+compressed>offset||lnl!==nl||!bytes.subarray(local+30,local+30+lnl).equals(bytes.subarray(cursor+46,cursor+46+nl))||(!(flags&8)&&(bytes.readUInt32LE(local+14)!==checksum||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==length)))fail('IMPORT_ZIP');
  ranges.push([local,start+compressed]);total+=length;if(total>limits.totalBytes)fail('IMPORT_LIMIT');
  if(directory&&length)fail('IMPORT_ZIP');
  entries.push({path:directory?name.slice(0,-1):name,kind:directory?'directory':'file',size:length,method,checksum,start,compressed});
  cursor+=46+nl+el+cl;
 }
 if(cursor!==end)fail('IMPORT_ZIP');ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])fail('IMPORT_ZIP');
 // The sole outer folder identifies the vault. Preserve every directory below
 // it, including empty ones, and discard only its optional explicit root entry.
 const first=entries[0]?.path.split('/')[0];
 if(first&&!first.startsWith('.')&&entries.every(e=>(e.path===first&&e.kind==='directory')||e.path.startsWith(first+'/'))){
  return entries.filter(e=>e.path!==first).map(e=>({...e,path:e.path.slice(first.length+1)}));
 }
 return entries;
}
async function zipFile(bytes,entry){
 let result;try{const raw=bytes.subarray(entry.start,entry.start+entry.compressed);result=entry.method===0?raw:await inflate(raw,{maxOutputLength:Math.max(1,entry.size)});}catch{fail('IMPORT_ZIP');}
 if(result.length!==entry.size||(await crc(result))!==entry.checksum)fail('IMPORT_ZIP');return result;
}
module.exports={readZip,zipFile};
