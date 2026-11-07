const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { finished } = require("node:stream/promises");
const archiver = require("archiver");
const MAX_ENTRIES = 10000;
const MAX_BYTES = 256 * 1024 * 1024;
let active = 0;
function limit() { throw Object.assign(new Error("Shared download limit exceeded"), {code:"SHARE_DOWNLOAD_LIMIT"}); }

// Use only authorized sharing reads, never paths supplied by the client.
// Prepare on private temporary disk; keep just one file in memory at a time.
async function sharedArchive(service, token, input, {maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, signal} = {}) {
  if (active >= 2) throw Object.assign(new Error("Shared downloads busy"),{code:"SHARE_DOWNLOAD_BUSY"});
  active++;
  let directory,zip,output,disposed=false;
  const dispose = async () => {
    if(disposed)return;disposed=true;
    try {if(directory)await fs.promises.rm(directory,{recursive:true,force:true});}
    finally {active--;}
  };
  try {
    signal?.throwIfAborted();
    const root = await service.read(token,input);
    if(root.kind!=="directory")throw new Error("Directory required");
    directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),"ignis-share-download-"));
    const file=path.join(directory,"download.zip");
    output=fs.createWriteStream(file,{flags:"wx",mode:0o600});
    const complete=finished(output);complete.catch(()=>{});
    zip=archiver("zip",{zlib:{level:1}});
    zip.on("error",error=>output.destroy(error));
    output.on("error",error=>zip.destroy(error));
    zip.pipe(output);
    const append=async(data,name)=>{const entry=once(zip,"entry");zip.append(data,{name});await entry;};
    const queue=[{relative:input.path,name:"",item:root}];
    let count=0,bytes=0;
    while(queue.length) {
      signal?.throwIfAborted();
      if(++count>maxEntries)limit();
      const node=queue.pop();
      const {relative,name}=node;
      const item=node.item || await service.read(token,{id:input.id,path:relative});
      if(item.kind==="directory") {
        if(name)await append(Buffer.alloc(0),name+"/");
        if(!Array.isArray(item.entries) || count+queue.length+item.entries.length>maxEntries)limit();
        for(const entry of item.entries) {
          // eslint-disable-next-line no-control-regex
          if(typeof entry.name!=="string" || !entry.name || entry.name.startsWith(".") || /[\\/:\x00-\x1f\x7f]/.test(entry.name))throw new Error("Invalid entry");
          queue.push({relative:relative?relative+"/"+entry.name:entry.name,name:name?name+"/"+entry.name:entry.name});
        }
      } else if(item.kind==="file") {
        const size=Buffer.byteLength(item.content || "","base64");
        if(bytes+size>maxBytes)limit();bytes+=size;
        await append(Buffer.from(item.content,"base64"),name);
      } else throw new Error("Invalid entry");
      // Each subsequent item is resolved lazily through the sharing policy.
    }
    await zip.finalize();await complete;
    // Authorization may change while the archive is being written.
    signal?.throwIfAborted();
    await service.read(token,input);
    return {name:(root.name || "Shared")+".zip",file,dispose};
  } catch(error) {
    zip?.destroy();output?.destroy();
    if(output)await finished(output).catch(()=>{});
    await dispose();throw error;
  }
}
module.exports={sharedArchive};
