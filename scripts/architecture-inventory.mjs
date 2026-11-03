// Snapshot reviewed surfaces; this is documentation, never an authorization input.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const repo=fileURLToPath(new URL('../',import.meta.url));
const {parse}=require('acorn');
const {routes}=require('../apps/ignis-server/server/auth/route-manifest');
const source=fs.readFileSync(new URL('../apps/ignis-server/server/auth/http.js',import.meta.url),'utf8');
const authPaths=new Set();
function walk(node){
  if(!node || typeof node!=='object')return;
  if(node.type==='Literal' && typeof node.value==='string' && node.value.startsWith('/api/auth/') && !node.value.endsWith('/'))authPaths.add(node.value);
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value && typeof value==='object')walk(value);
}
walk(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({
  sourceCommit:git('rev-parse','HEAD'),
  scope:'Data APIs from the reviewed manifest; authentication path literals from the current boundary (not a complete method/schema registry).',
  publicDocuments:['/login','/setup','/reset-password','/share-target'],
  removedManagementDocuments:['/account','/shares','/admin/users'],
  authenticationPathLiterals:[...authPaths].sort(),
  dataRoutes:routes,
  websocketChannels:[{path:'/ws?events=1&context=<session>',purpose:'account invalidations'},{path:'/ws?vault=<uuid>&context=<session>',purpose:'authorized vault file events'}],
},null,2)+'\n');
