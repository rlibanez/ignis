// Explicit, isolated large-file acceptance. No private Obsidian assets or real data.
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-large-acceptance-'));
try{
 const result=spawnSync(process.execPath,['--max-old-space-size=64','--max-semi-space-size=8',fileURLToPath(new URL('./lib/large-import-probe.cjs',import.meta.url))],{stdio:'inherit',timeout:420000,env:{...Object.fromEntries(['PATH','HOME','TMPDIR','TZ','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),IGNIS_LARGE_IMPORT_ROOT:directory}});
 if(result.error||result.status!==0)throw Error('Bounded-memory large import acceptance failed');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
