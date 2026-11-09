import {it,expect,afterEach} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import http from 'node:http';
const require=createRequire(import.meta.url);
const {createBuildInfo}=require('./version');
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-version-'));roots.push(root);
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'1.0.0',ignis:{upstream:{version:'0.9.0',repository:'https://github.com/Nystik-gh/ignis'}}}));
 return {root};
}
it('rejects an invalid build stamp',()=>{
 const {root}=fixture();
 expect(()=>createBuildInfo({root,env:{IGNIS_BUILD:'bad\nvalue'}})).toThrow('Invalid IGNIS_BUILD');
});
it('keeps release version separate from unique per-build cache stamps',()=>{
 const {root}=fixture(),a=createBuildInfo({root,env:{}}),b=createBuildInfo({root,env:{}});
 expect(a.version).toBe('1.0.0');expect(b.version).toBe(a.version);expect(a).not.toHaveProperty('commit');expect(a.semver).toBe('1.0.0');expect(a.build).not.toBe(b.build);
});
it('serves the same immutable metadata as asset URLs and keeps Obsidian distinct',async()=>{
 const express=require('express'),app=express();app.use('/api/version',require('./routes/version'));
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/version`),info=await response.json();
  const version=require('./version');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(info).not.toHaveProperty('dirty');
  expect(info.version).toBe(info.semver);
  expect(info).not.toHaveProperty('commit');
  expect(info).toMatchObject({build:version.getInfo().build,semver:require('../../../package.json').version,upstream:require('../../../package.json').ignis.upstream});
  expect(info.obsidianVersion).toBeTypeOf('string');
  expect(version.getVersion()).toBe(`${info.semver}+${info.build}`);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
it('tags the fork image for a local build',()=>{
 const {root}=fixture(),capture=path.join(root,'captured.json'),docker=path.join(root,'docker');
 fs.writeFileSync(docker,`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.VERSION_CAPTURE,JSON.stringify(process.argv.slice(2)));\n`,{mode:0o755});
 execFileSync(process.execPath,[path.resolve('apps/ignis-server/scripts/build-image.js')],{env:{...process.env,PATH:root+path.delimiter+process.env.PATH,VERSION_CAPTURE:capture,IGNIS_IMAGE:'example/ignis'},stdio:'pipe'});
 const args=JSON.parse(fs.readFileSync(capture,'utf8'));
 expect(args).toContain('example/ignis:'+require('../../../package.json').version);
 expect(args).not.toContain('--push');
});

it('requires the Compose tag version to match the application version',()=>{
 const {root}=fixture();
 expect(createBuildInfo({root,env:{IGNIS_VERSION:'1.0.0'}}).version).toBe('1.0.0');
 expect(()=>createBuildInfo({root,env:{IGNIS_VERSION:'1.1.0'}})).toThrow('IGNIS_VERSION must match package.json version 1.0.0');
});
