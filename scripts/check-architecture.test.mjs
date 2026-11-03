import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkArchitecture} from './check-architecture.mjs';
it('keeps the current staged architecture within its dependency boundaries',()=>{
  expect(checkArchitecture().files).toBeGreaterThan(100);
});
it('rejects infrastructure in pure contracts, reverse platform imports and indirect cycles',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-architecture-'));
  const put=(name,source)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);};
  try{
    put('packages/contracts/src/model.js',"import fs from 'node:fs';");
    expect(()=>checkArchitecture(root)).toThrow('Pure contract');
    put('packages/contracts/src/model.js','export const value=1;');
    put('apps/ignis-server/server/platform/store.js',"require('../app/service');");
    expect(()=>checkArchitecture(root)).toThrow('Platform imports');
    put('apps/ignis-server/server/platform/store.js','module.exports={};');
    put('apps/ignis-server/server/app/service.js',"require('../auth/service');");
    put('apps/ignis-server/server/auth/service.js',"require('../app/service');");
    expect(()=>checkArchitecture(root)).toThrow('Architecture cycle');
    put('apps/ignis-server/server/auth/service.js','module.exports={};');
    put('apps/ignis-server/server/features/identity/application/use-case.js',"require('node:fs');");
    expect(()=>checkArchitecture(root)).toThrow('Identity use case imports infrastructure');
    put('apps/ignis-server/server/features/identity/application/use-case.js','module.exports={};');
    put('apps/ignis-server/server/transport/http/identity/route.js',"require('../../../features/identity/adapters/store');");
    expect(()=>checkArchitecture(root)).toThrow('Identity HTTP imports persistence');
    put('apps/ignis-server/server/transport/http/identity/route.js','module.exports={};');
    put('apps/ignis-server/server/features/vaults/application/use-case.js',"require('../adapters/vault-store');");
    expect(()=>checkArchitecture(root)).toThrow('Vault use case imports infrastructure');
    put('apps/ignis-server/server/features/vaults/application/use-case.js','module.exports={};');
    put('packages/management/src/new.js',"import '../../../apps/ignis-server/server/auth/service.js';");
    expect(()=>checkArchitecture(root)).toThrow('New client-to-server');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
