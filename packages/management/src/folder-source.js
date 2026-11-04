const t=text=>globalThis.IgnisI18n?.t(text)??text;
export async function readDirectory(directory,signal){
 const entries=[];
 async function walk(handle,prefix=''){
  for await(const child of handle.values()){
   signal.throwIfAborted();if(entries.length>=10000)throw Error(t('Import limit exceeded.'));
   const path=prefix+child.name;
   if(child.kind==='directory'){entries.push({path,kind:'directory',size:0});await walk(child,path+'/');}
   else if(child.kind==='file'){const file=await child.getFile();signal.throwIfAborted();entries.push({path,kind:'file',size:file.size,file});}
   else throw Error(t('Unsupported folder entry. Use a ZIP file.'));
  }
 }
 await walk(directory);return entries;
}
function entryHandle(entry){
 if(entry.isFile)return {name:entry.name,kind:'file',getFile:()=>new Promise((resolve,reject)=>entry.file(resolve,reject))};
 if(!entry.isDirectory)throw Error(t('Drop one local folder here.'));
 return {name:entry.name,kind:'directory',async *values(){
  const reader=entry.createReader();
  // A reader may return only 100 entries per batch. Empty means exhausted,
  // not a short batch; keep reading to preserve all files and empty folders.
  for(;;){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)return;for(const child of batch)yield entryHandle(child);}
 }};
}
export async function directoryFromDrop(transfer){
 // Read the drag data synchronously before the first await: browsers protect it
 // after the drop event returns. Never fall back to FileList, which loses dirs.
 const items=Array.from(transfer?.items||[]).filter(item=>item.kind==='file');
 if(items.length!==1)throw Error(t('Drop one local folder here.'));
 const item=items[0],entry=item.getAsEntry?.()||item.webkitGetAsEntry?.();
 if(entry){if(!entry.isDirectory)throw Error(t('Drop one local folder here.'));return entryHandle(entry);}
 if(item.getAsFileSystemHandle){const pending=item.getAsFileSystemHandle();const handle=await pending;if(handle?.kind==='directory')return handle;}
 throw Error(t('The browser could not read this folder. Try dragging it again or use a ZIP file.'));
}

export function folderFromFiles(files){
 const entries=[],directories=new Set();let name;
 const add=entry=>{if(entries.length>=10000)throw Error(t('Import limit exceeded.'));entries.push(entry);};
 if(!files.length)throw Error(t('No files were provided. Drag the folder here to import an empty folder.'));
 for(const file of files){
  const parts=file.webkitRelativePath?.split('/');
  if(!parts||parts.length<2||parts.some(part=>!part))throw Error(t('This browser did not supply folder paths. Use a ZIP file.'));
  if(name===undefined)name=parts[0];else if(name!==parts[0])throw Error(t('Select one local folder.'));
  const relative=parts.slice(1);
  for(let depth=1;depth<relative.length;depth++){
   const path=relative.slice(0,depth).join('/');if(!directories.has(path)){directories.add(path);add({path,kind:'directory',size:0});}
  }
  add({path:relative.join('/'),kind:'file',size:file.size,file});
 }
 return {name,entries};
}
export function zipFromDrop(transfer){
 const items=Array.from(transfer?.items||[]).filter(item=>item.kind==='file');
 const files=items.length?items.map(item=>{
  const entry=item.getAsEntry?.()||item.webkitGetAsEntry?.();if(entry?.isDirectory)throw Error(t('Drop one ZIP file here.'));return item.getAsFile?.();
 }):Array.from(transfer?.files||[]);
 const file=files[0];
 if(files.length!==1||!file||(!/\.zip$/i.test(file.name)&&!['application/zip','application/x-zip-compressed'].includes(file.type)))throw Error(t('Drop one ZIP file here.'));
 return file;
}
