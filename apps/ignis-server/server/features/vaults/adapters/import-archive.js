const {Readable,Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');const {createInflateRaw}=require('node:zlib');
const {openPinned,small,crcUpdate}=require('./import-streams');const {zipIndex}=require('./zip-index');const {fail,limits}=require('../application/import-policy');
async function openArchive(file,expected,check=()=>{}){
 if(!Number.isSafeInteger(expected?.size)||expected.size<22||expected.size>limits.zipBytes)fail('IMPORT_ZIP');
 const pinned=await openPinned(file,expected,check);
 try{
  const parser=zipIndex(expected.size);let step=parser.next();
  while(!step.done){check();const [offset,length]=step.value;if(offset<0||length<0||offset+length>expected.size)fail('IMPORT_ZIP');const bytes=Buffer.alloc(length);let position=0;while(position<length){check();const {bytesRead}=await pinned.handle.read(bytes,position,length-position,offset+position);if(!bytesRead)fail('IMPORT_ZIP');position+=bytesRead;}step=parser.next(bytes);}
  await pinned.validate();const entries=step.value;
  function stream(entry){
   return Readable.from((async function*(){
    await pinned.validate();const input=pinned.stream(entry.start,entry.compressed),output=new Transform({transform(chunk,_encoding,callback){callback(null,chunk);}});
    const done=entry.method===8?pipeline(input,createInflateRaw({chunkSize:64*1024}),output):pipeline(input,output);done.catch(()=>{});
    let size=0,crc=0xffffffff;
    try{for await(const chunk of output){check();size+=chunk.length;if(size>entry.size)fail('IMPORT_ZIP');crc=crcUpdate(crc,chunk);yield chunk;}await done;if(size!==entry.size||((crc^0xffffffff)>>>0)!==entry.checksum)fail('IMPORT_ZIP');await pinned.validate();}
    catch(error){if(error.code?.startsWith('Z_'))fail('IMPORT_ZIP');throw error;}
    finally{output.destroy();await done.catch(()=>{});}
   })());
  }
  return {entries,stream,small:(entry,limit=1024*1024)=>{if(entry.size>limit)fail('IMPORT_LIMIT');return small(stream(entry),limit,check);},close:pinned.close};
 }catch(error){await pinned.close();throw error;}
}
module.exports={openArchive};
