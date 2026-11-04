import {it,expect} from 'vitest';
import {spawn,execFile} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../../../',import.meta.url));

it('starts and stops real resources twice without process exit or residual handles',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-app-lifecycle-'));
  fs.mkdirSync(path.join(root,'assets'));
  fs.writeFileSync(path.join(root,'assets/index.html'),'<script src="app.js"></script>');
  const source=`
    const assert=require('node:assert/strict');
    const http=require('node:http');
    const {createApplication}=require('./apps/ignis-server/server/app/create-application');
    const signals=['SIGTERM','SIGINT','uncaughtException','unhandledRejection'];
    const before=signals.map(signal=>process.listenerCount(signal));
    (async()=>{
      for(let i=0;i<2;i++){
        const app=createApplication();
        try {
          const address=await app.start();
          const competing=createApplication();
          await assert.rejects(()=>competing.start(),/Only one/);await competing.stop();
          const result=await new Promise((resolve,reject)=>{
            const req=http.get({host:'127.0.0.1',port:address.port,path:'/api/auth/status',headers:{Host:'localhost:8080'}},response=>{
              let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));
            });req.on('error',reject);
          });
          assert.equal(result.status,200);assert.equal(result.body.initialized,false);
          const directory=require('node:path').join(process.env.VAULT_ROOT,'Watching');
          require('node:fs').mkdirSync(directory,{recursive:true});
          require('@ignis/server-core').watcher.startWatching('Watching',directory);
        } finally {await Promise.all([app.stop(),app.stop()]);}
        assert.equal(app.state,'stopped');
      }
      assert.deepEqual(signals.map(signal=>process.listenerCount(signal)),before);
      console.log('CLEAN');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  try{
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['-e',source],{cwd:repo,env:{PATH:process.env.PATH,
        DATA_ROOT:path.join(root,'data'),VAULT_ROOT:path.join(root,'vaults'),OBSIDIAN_ASSETS_PATH:path.join(root,'assets'),
        PORT:'0',IGNIS_PUBLIC_ORIGIN:'http://localhost:8080',IGNIS_ALLOW_HTTP_LOOPBACK:'true',IGNIS_LOG_FILE_ENABLED:'false',IGNIS_OIDC_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
      const timer=setTimeout(()=>{child.kill('SIGKILL');},8000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,output});});
    });
    expect(result,result.output).toMatchObject({code:0,signal:null});
    expect(result.output).toContain('CLEAN');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
},12000);

it('rejects an old development schema at startup with a safe diagnostic and intact data',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-app-schema-'));
  fs.mkdirSync(path.join(root,'data/auth'),{recursive:true});
  fs.mkdirSync(path.join(root,'assets'));
  const file=path.join(root,'data/auth/identity.sqlite'),db=new DatabaseSync(file);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (19); CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES ('original')");
  db.close();
  const before=fs.readFileSync(file);
  try{
    const result=await new Promise(resolve=>execFile(process.execPath,['apps/ignis-server/server/index.js'],{
      cwd:repo,timeout:6000,env:{PATH:process.env.PATH,DATA_ROOT:path.join(root,'data'),
        VAULT_ROOT:path.join(root,'vaults'),OBSIDIAN_ASSETS_PATH:path.join(root,'assets'),
        PORT:'0',IGNIS_PUBLIC_ORIGIN:'http://localhost:8080',IGNIS_ALLOW_HTTP_LOOPBACK:'true',
        IGNIS_LOG_FILE_ENABLED:'false',IGNIS_LOG_FORMAT:'json',IGNIS_OIDC_ENABLED:'false'},
    },(error,stdout,stderr)=>resolve({error,output:stdout+stderr})));
    expect(result.error?.code,result.output).toBe(1);
    expect(result.output).toContain('server.schema_incompatible');
    expect(result.output).not.toContain(root);
    expect(fs.readFileSync(file)).toEqual(before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
},10000);
