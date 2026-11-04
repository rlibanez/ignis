// Build the production image first. The host repository is mounted read-only;
// only a dedicated 1 MiB tmpfs is filled by the ENOSPC fixture.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repository=fileURLToPath(new URL('../',import.meta.url));
const image=process.argv[2] || 'ignis:architecture-smoke';
if(!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image) || process.argv.length>3)throw new Error('Usage: node scripts/check-content-faults.mjs [image]');
const name='ignis-content-faults-'+randomUUID();
const source=`
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
fs.writeFileSync('/tmp/vitest.config.mjs','export default {test:{cache:false}};');
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','apps/ignis-server/server/auth/resource-shares-recovery.test.mjs','--config','/tmp/vitest.config.mjs','--no-cache','--fsModuleCachePath','/tmp/vitest-cache','--no-file-parallelism'],{stdio:'inherit',timeout:40000});
if(result.error || result.status!==0)process.exitCode=1;
`;
try{
 const result=spawnSync('docker',['run','--rm','--init','--name',name,'--network','none','--read-only','--user','1000:1000',
  '--tmpfs','/tmp:rw,nosuid,noexec,size=128m','--tmpfs','/fault:rw,nosuid,noexec,size=1m',
  '--mount',`type=bind,source=${repository},target=/workspace,readonly`,'--workdir','/workspace',
  // Vitest persists its API token here; keep the repository and image read-only.
  '-e','XDG_DATA_HOME=/tmp/vitest-data',
  '-e','IGNIS_TEST_FAULT_ROOT=/fault','--entrypoint','node',image,'-e',source],
  {encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
 if(result.stdout)process.stdout.write(result.stdout);
 if(result.stderr)process.stderr.write(result.stderr);
 if(result.error || result.status!==0)throw new Error('Isolated content fault acceptance failed');
}finally{spawnSync('docker',['rm','--force',name],{stdio:'ignore',timeout:10000});}
