const {limits,fail,importPath}=require('../application/import-policy');
// One parser for memory fixtures and file-backed archives. Only the EOCD tail,
// individual headers and names/extra fields are read, never compressed payloads.
function* zipIndex(length){
 if(!Number.isSafeInteger(length)||length>limits.zipBytes||length<22)fail('IMPORT_ZIP');
 const tailStart=Math.max(0,length-65557),tail=yield [tailStart,length-tailStart];
 let end=tail.length-22;for(;end>=0;end--)if(tail.readUInt32LE(end)===0x06054b50&&end+22+tail.readUInt16LE(end+20)===tail.length)break;
 if(end<0)fail('IMPORT_ZIP');
 const count=tail.readUInt16LE(end+10),offset=tail.readUInt32LE(end+16),size=tail.readUInt32LE(end+12),absoluteEnd=tailStart+end;
 if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||count!==tail.readUInt16LE(end+8)||count===65535||count>limits.files||offset+size!==absoluteEnd)fail('IMPORT_ZIP');
 let cursor=offset,total=0;const entries=[],ranges=[],declared=new Set();
 for(let i=0;i<count;i++){
  if(cursor+46>absoluteEnd)fail('IMPORT_ZIP');const header=yield [cursor,46];if(header.readUInt32LE(0)!==0x02014b50)fail('IMPORT_ZIP');
  const flags=header.readUInt16LE(8),method=header.readUInt16LE(10),checksum=header.readUInt32LE(16),compressed=header.readUInt32LE(20),length=header.readUInt32LE(24),nl=header.readUInt16LE(28),el=header.readUInt16LE(30),cl=header.readUInt16LE(32),local=header.readUInt32LE(42),mode=header.readUInt32LE(38)>>>16;
  if(cursor+46+nl+el+cl>absoluteEnd||nl>4096||(flags&~0x080e)!==0||![0,8].includes(method)||length>limits.fileBytes||compressed>limits.zipBytes||header.readUInt16LE(34)||(mode&0xf000)&&![0x8000,0x4000].includes(mode&0xf000))fail('IMPORT_ZIP');
  const rawName=yield [cursor+46,nl];let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(rawName);}catch{fail('IMPORT_ZIP');}
  const directory=name.endsWith('/'),key=importPath(directory?name.slice(0,-1):name).toLowerCase();if(declared.has(key))fail('IMPORT_COLLISION');declared.add(key);
  const extra=yield [cursor+46+nl,el];for(let x=0;x<el;){if(x+4>el||extra.readUInt16LE(x)===1)fail('IMPORT_ZIP');const next=x+4+extra.readUInt16LE(x+2);if(next>el)fail('IMPORT_ZIP');x=next;}
  if(local+30>offset)fail('IMPORT_ZIP');const localHeader=yield [local,30];if(localHeader.readUInt32LE(0)!==0x04034b50||localHeader.readUInt16LE(6)!==flags||localHeader.readUInt16LE(8)!==method)fail('IMPORT_ZIP');
  const lnl=localHeader.readUInt16LE(26),lel=localHeader.readUInt16LE(28),start=local+30+lnl+lel;
  if(start+compressed>offset||lnl!==nl||(!(flags&8)&&(localHeader.readUInt32LE(14)!==checksum||localHeader.readUInt32LE(18)!==compressed||localHeader.readUInt32LE(22)!==length)))fail('IMPORT_ZIP');
  const localName=yield [local+30,lnl];if(!localName.equals(rawName))fail('IMPORT_ZIP');
  ranges.push([local,start+compressed]);total+=length;if(total>limits.totalBytes)fail('IMPORT_LIMIT');if(directory&&length)fail('IMPORT_ZIP');
  entries.push({path:directory?name.slice(0,-1):name,kind:directory?'directory':'file',size:length,method,checksum,start,compressed});cursor+=46+nl+el+cl;
 }
 if(cursor!==absoluteEnd)fail('IMPORT_ZIP');ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])fail('IMPORT_ZIP');
 const first=entries[0]?.path.split('/')[0];
 if(first&&!first.startsWith('.')&&!['node_modules','__macosx'].includes(first.toLowerCase())&&entries.every(e=>(e.path===first&&e.kind==='directory')||e.path.startsWith(first+'/')))return entries.filter(e=>e.path!==first).map(e=>({...e,path:e.path.slice(first.length+1)}));
 return entries;
}
module.exports={zipIndex};
