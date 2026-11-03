import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parse} from 'acorn';
const repository=fileURLToPath(new URL('../',import.meta.url));
const legacyClientEdges=new Set([
  ...['resource-action-style.js','resource-tree.css','resource-tree.js','oidc-start.js','users.js','shares.js','login.js','password-visibility.js']
    .map(file=>`packages/management/src/management-modal.js -> apps/ignis-server/server/auth/web/${file}`),
  'packages/shim/src/copy-dialog.js -> apps/ignis-server/server/auth/web/resource-tree.js',
  'packages/shim/src/css-overrides.js -> apps/ignis-server/server/auth/web/resource-tree.css',
  'packages/shim/src/shared-panel.js -> apps/ignis-server/server/auth/web/resource-action-style.js',
]);
function imports(source){
  const result=[];
  function visit(node){
    if(!node || typeof node!=='object')return;
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(node.type) && node.source?.value)result.push(node.source.value);
    if(node.type==='CallExpression' && node.callee.name==='require' && typeof node.arguments[0]?.value==='string')result.push(node.arguments[0].value);
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value && typeof value==='object')visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true}));
  return result;
}
export function checkArchitecture(root=repository){
  const files=new Map(),errors=[];
  const walk=directory=>{
    if(!fs.existsSync(directory))return;
    for(const item of fs.readdirSync(directory,{withFileTypes:true})){
      if(['node_modules','dist','.git'].includes(item.name))continue;
      const file=path.join(directory,item.name);
      if(item.isDirectory())walk(file);
      else if(/\.(js|mjs|svelte)$/.test(file) && !file.includes('.test.') &&
        (!file.startsWith(path.join(root,'packages')) || file.includes('/src/')))files.set(path.relative(root,file).split(path.sep).join('/'),file);
    }
  };
  walk(path.join(root,'packages'));walk(path.join(root,'apps/ignis-server/server'));
  const graph=new Map();
  for(const [name,file] of files){
    let source=fs.readFileSync(file,'utf8');
    if(name.endsWith('.svelte'))source=[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
    const targets=[];
    for(const specifier of imports(source)){
      const relative=specifier.startsWith('.');
      const resolved=relative?path.resolve(path.dirname(file),specifier):null;
      const target=resolved?path.relative(root,resolved).split(path.sep).join('/'):specifier;
      if(name.startsWith('apps/ignis-server/server/features/identity/application/') &&
        (!relative || !(target.startsWith('apps/ignis-server/server/features/identity/application/') || target.startsWith('packages/contracts/'))))
        errors.push(`Identity use case imports infrastructure: ${name} -> ${target}`);
      if(name.startsWith('apps/ignis-server/server/features/vaults/application/') &&
        (!relative || !(target.startsWith('apps/ignis-server/server/features/vaults/application/') || target.startsWith('packages/contracts/'))))
        errors.push(`Vault use case imports infrastructure: ${name} -> ${target}`);
      if(name.startsWith('apps/ignis-server/server/transport/http/identity/') &&
        (target.includes('/features/identity/adapters/') || target.includes('/platform/persistence/') || specifier==='node:sqlite'))
        errors.push(`Identity HTTP imports persistence: ${name} -> ${target}`);
      if(name.startsWith('packages/contracts/') && (!relative || !target.startsWith('packages/contracts/')))errors.push(`Pure contract imports infrastructure: ${name} -> ${specifier}`);
      if(name.startsWith('apps/ignis-server/server/platform/') && relative && !target.startsWith('apps/ignis-server/server/platform/'))errors.push(`Platform imports an application layer: ${name} -> ${target}`);
      if(name.startsWith('packages/') && relative && target.startsWith('apps/') && !legacyClientEdges.has(`${name} -> ${target}`))errors.push(`New client-to-server import: ${name} -> ${target}`);
      if(relative){
        const linked=[target,target+'.js',target+'.mjs',target+'/index.js'].find(candidate=>files.has(candidate));
        if(linked)targets.push(linked);
      }
    }
    graph.set(name,targets);
  }
  // New architectural modules must not participate in cycles, including indirect
  // paths through legacy adapters. Existing unrelated upstream cycles are out of scope.
  const owned=name=>name.startsWith('packages/contracts/') || /^apps\/ignis-server\/server\/(app|platform|integration|features\/(identity|vaults))\//.test(name);
  for(const start of [...graph.keys()].filter(owned)){
    const seen=new Set();
    const visit=(node,chain)=>{
      if(node===start && chain.length){errors.push(`Architecture cycle: ${[...chain,node].join(' -> ')}`);return;}
      if(seen.has(node))return;seen.add(node);
      for(const next of graph.get(node)||[])visit(next,[...chain,node]);
    };
    visit(start,[]);
  }
  if(errors.length)throw new Error([...new Set(errors)].join('\n'));
  return {files:files.size,legacyClientEdges:legacyClientEdges.size};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try {console.log('Architecture check:',checkArchitecture());}
  catch(error){console.error(error.message);process.exitCode=1;}
}
