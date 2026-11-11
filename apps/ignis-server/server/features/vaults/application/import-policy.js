const {limits:transferLimits,portablePath,excludedTransferSegment}=require('./transfer-policy');
const limits=Object.freeze({...transferLimits,fileBytes:512*1024*1024,totalBytes:4*1024*1024*1024,zipBytes:1024*1024*1024,ttl:4*60*60*1000,idle:30*60*1000});
const fail=code=>{throw Object.assign(new Error('Vault import rejected'),{code});};
function importPath(value){const result=portablePath(value);if(result===null)fail('IMPORT_PATH');return result;}
function restoreMode(value='none',role='user'){
 if(!['none','plugins','full'].includes(value))fail('IMPORT_REQUEST');
 if(value!=='none'&&role!=='admin')fail('IMPORT_FORBIDDEN');
 return value;
}
function included(name,configuration,kind='file',restore='none',role='user'){
 const parts=name.toLowerCase().split('/');
 if(parts.some(excludedTransferSegment))return false;
 if(parts[0]==='.obsidian'){
  if(parts[1]==='plugins'){
   return restore==='full'||(restore==='plugins'&&kind==='file'&&/^\.obsidian\/plugins\/[^./][^/]*\/(main\.js|manifest\.json|styles\.css)$/.test(name));
  }
  if(parts[1]==='community-plugins.json')return restore==='full'&&kind==='file';
  return configuration&&(role==='admin'||(kind==='directory'?name==='.obsidian':/^\.obsidian\/(app|hotkeys|graph)\.json$/.test(name)));
 }
 return (configuration&&role==='admin')||!parts.some(part=>part.startsWith('.'));
}
function exclusionReason(name,configuration,restore){
 const parts=name.toLowerCase().split('/');
 if(parts.some(excludedTransferSegment))return 'generated-files';
 if(parts[0]==='.obsidian'){
  if(parts[1]==='plugins'&&restore==='plugins')return 'plugin-settings';
  if(parts[1]==='plugins')return 'plugins-themes';
  if(parts[1]==='appearance.json')return 'appearance-state';
  if(parts[1]==='community-plugins.json')return 'community-plugins-state';
  if(parts[1]==='core-plugins.json')return 'core-plugins-state';
  if(['workspace.json','workspace-mobile.json','workspaces.json'].includes(parts[1]))return 'workspace-state';
  return configuration?'unsupported-configuration':'preferences-disabled';
 }
 if(parts.some(p=>['node_modules','__macosx'].includes(p)))return 'generated-files';
 return 'hidden-state';
}
function selectable(name,kind,role){
 if(kind!=='file')return false;
 return /^\.obsidian\/(app|hotkeys|graph|workspace|workspace-mobile|workspaces)\.json$/.test(name)||
  (role==='admin'&&/^\.obsidian\/(appearance|core-plugins)\.json$/.test(name));
}
function manifest(input,configuration,selected=[],role='user',sourceOnly=false,restore='none'){
 restoreMode(restore,role);
 if(!Array.isArray(selected)||selected.length>8||selected.some(p=>typeof p!=='string')||new Set(selected).size!==selected.length)fail('IMPORT_REQUEST');
 if(!Array.isArray(input)||input.length>limits.files)fail('IMPORT_LIMIT');
 const nodes=new Map();let total=0;
 const entries=input.map(item=>{
  if(!item||!['path,size','kind,path,size'].includes(Object.keys(item).sort().join(','))||!Number.isSafeInteger(item.size)||item.size<0||item.size>limits.fileBytes)fail('IMPORT_LIMIT');
  const kind=Object.hasOwn(item,'kind')?item.kind:'file';if(!['file','directory'].includes(kind)||(kind==='directory'&&item.size!==0))fail('IMPORT_REQUEST');
  const name=importPath(item.path),parts=name.split('/'),original=item.path.split('/');
  // Explicit and implicit directories share one namespace. Repeated directory
  // declarations, file/parent conflicts and case/Unicode aliases are rejected.
  for(let depth=1;depth<=parts.length;depth++){
   const key=parts.slice(0,depth).join('/').toLowerCase(),spelling=original.slice(0,depth).join('/');
   const leaf=depth===parts.length,type=leaf?kind:'directory',previous=nodes.get(key);
   if(previous&&(previous.spelling!==spelling||previous.kind!==type||(leaf&&previous.explicit)))fail('IMPORT_COLLISION');
   nodes.set(key,{spelling,kind:type,explicit:leaf||previous?.explicit});
   if(nodes.size>limits.files)fail('IMPORT_LIMIT');
  }
  total+=item.size;if(total>limits.totalBytes)fail('IMPORT_LIMIT');
  return {path:name,kind,size:item.size,include:included(name,configuration,kind,restore,role)||selected.includes(name)};
 });
 if(selected.some(name=>!entries.some(e=>e.path===name&&selectable(e.path,e.kind,role))))fail('IMPORT_REQUEST');
 if(!sourceOnly&&entries.some(e=>e.kind==='file')&&!entries.some(e=>e.include||selectable(e.path,e.kind,role)))fail('IMPORT_EMPTY');
 const excludedEntries=entries.filter(e=>!included(e.path,configuration,e.kind,restore,role)).map(e=>({path:e.path,kind:e.kind,reason:exclusionReason(e.path,configuration,restore),selectable:selectable(e.path,e.kind,role),selected:e.include}));
 return {entries,total,excluded:excludedEntries.filter(e=>!e.selected).length,excludedEntries};
}
module.exports={limits,fail,importPath,included,manifest,restoreMode};
