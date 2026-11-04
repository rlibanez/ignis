const {manifest,fail}=require('./import-policy');
// Validate the entire source before partitioning it. Limits and path aliases
// cannot be bypassed by splitting one upload into multiple vaults.
function inspectSource(files){
 const {entries}=manifest(files,false,[],'user',true),markers=new Set();
 for(const entry of entries){const parts=entry.path.split('/'),at=parts.indexOf('.obsidian');if(at>=0&&!parts.slice(0,at).some(p=>p.startsWith('.')||['node_modules','__macosx'].includes(p.toLowerCase()))&&(at<parts.length-1||entry.kind==='directory'))markers.add(parts.slice(0,at).join('/'));}
 const sorted=[...markers].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
 const roots=[],nested=[];
 for(const root of sorted){if(roots.some(parent=>parent===''||root.startsWith(parent+'/')))nested.push(root);else roots.push(root);}
 if(!roots.length)roots.push('');
 if(roots.length>32)fail('IMPORT_LIMIT');
 const vaults=roots.map(root=>({root,name:root.split('/').pop()||null,indexes:entries.flatMap((entry,index)=>root===''||entry.path.startsWith(root+'/')?[index]:[])}));
 const outside=entries.filter(entry=>!roots.some(root=>root===''||entry.path===root||entry.path.startsWith(root+'/'))&&!roots.some(root=>entry.kind==='directory'&&root.startsWith(entry.path+'/'))).map(({path,kind})=>({path,kind,reason:'outside-vaults',selectable:false,selected:false}));
 return {entries,vaults,nested,outside};
}
module.exports={inspectSource};
