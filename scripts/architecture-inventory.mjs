// Snapshot reviewed surfaces; this is documentation, never an authorization input.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const repo=fileURLToPath(new URL('../',import.meta.url));
const reference=JSON.parse(require('node:fs').readFileSync(new URL('../docs/architecture/delivery-reference.json',import.meta.url)));
const {routes}=require('../apps/ignis-server/server/auth/route-manifest');
const {definitions:authenticationRoutes}=require('../apps/ignis-server/server/transport/http/identity/router');
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({
  integration:{upstreamBase:reference.upstreamBase,
    changes:git('diff','--no-renames','--name-status',reference.upstreamBase).split('\n').filter(Boolean).map(line=>{const [status,file]=line.split('\t');return {status,file};}),
    newUntrackedFiles:git('ls-files','--others','--exclude-standard').split('\n').filter(Boolean)},
  sourceCommit:git('rev-parse','HEAD'),
  scope:'Data APIs from the reviewed manifest; authentication method/path registrations (not an input-schema registry).',
  publicDocuments:['/login','/setup','/reset-password','/share-target'],
  removedManagementDocuments:['/account','/shares','/admin/users'],
  authenticationRoutes,
  dataRoutes:routes,
  websocketChannels:[{path:'/ws?events=1&context=<session>',purpose:'account invalidations'},{path:'/ws?vault=<uuid>&context=<session>',purpose:'authorized vault file events'}],
},null,2)+'\n');
