import { execFileSync } from 'node:child_process';
import { it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const logging=require('./logger');
const roots=[],loggers=[];
function stream(){const s=new EventEmitter();s.lines=[];s.write=line=>{s.lines.push(line);return true;};return s;}
function fixture(options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-logs-'));roots.push(root);const stdout=stream(),stderr=stream();const logger=logging.createLogger({dataRoot:root,stdout,stderr,...options});loggers.push(logger);return {root,logger,stdout,stderr};}
function records(root){return fs.readdirSync(path.join(root,'logs')).filter(n=>n.endsWith('.jsonl')).flatMap(n=>fs.readFileSync(path.join(root,'logs',n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));}
afterEach(()=>{vi.restoreAllMocks();logging.close();for(const l of loggers.splice(0))l.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
it('validates exact configuration and bounded retention',()=>{
 expect(logging.readLogConfig({})).toEqual({level:'info',format:'json',fileEnabled:true,maxBytes:10485760,maxFiles:10});
 for(const [key,values]of Object.entries({IGNIS_LOG_FORMAT:['TEXT','xml','','secret'],IGNIS_LOG_LEVEL:['INFO','trace','', 'secret'],IGNIS_LOG_FILE_ENABLED:['1','TRUE',''],IGNIS_LOG_MAX_SIZE_MIB:['0','101','-1','1.5','01',''],IGNIS_LOG_MAX_FILES:['0','101',' 1','1e2','']}))for(const value of values)expect(()=>logging.readLogConfig({[key]:value})).toThrow(`Invalid ${key}`);
 expect(logging.readLogConfig({IGNIS_LOG_FILE_ENABLED:'false',IGNIS_LOG_MAX_SIZE_MIB:'1',IGNIS_LOG_MAX_FILES:'100'}).fileEnabled).toBe(false);
});
it('persists structured events across restart with private permissions',()=>{
 const {root,logger}=fixture();logger.emit('info','server.started',{version:'0.8.18',obsidianVersion:'1.14.4',port:8080});logger.close();
 const next=logging.createLogger({dataRoot:root,stdout:stream(),stderr:stream()});loggers.push(next);next.emit('warn','oidc.initialize_failed');next.close();
 expect(records(root).map(r=>r.event)).toEqual(['server.started','oidc.initialize_failed']);
 expect(records(root)[0]).toMatchObject({version:'0.8.18',obsidianVersion:'1.14.4'});
 expect(fs.statSync(path.join(root,'logs')).mode&0o777).toBe(0o700);expect(fs.statSync(path.join(root,'logs/ignis.jsonl')).mode&0o777).toBe(0o600);
});
it('never serializes passwords, tokens, paths, errors, URLs or arbitrary fields at debug level',()=>{
 const {root,logger,stdout}=fixture({level:'debug'});const secret='SECRET\nforged-log';
 logger.emit('debug','http.request',{password:secret,cookie:secret,token:secret,authorization:secret,path:secret,url:secret,body:secret,error:new Error(secret),requestId:secret,userId:secret,vaultId:secret,errorCode:secret,component:secret,method:secret,status:200});
 logger.emit('error',secret,{port:80});logger.close();
 const all=JSON.stringify(records(root))+stdout.lines.join('');expect(all).not.toContain('SECRET');expect(records(root)).toHaveLength(1);expect(records(root)[0].status).toBe(200);
});
it('records only known system error codes',()=>{const {root,logger}=fixture();logger.emit('error','server.start_failed',{errorCode:'ENOSPC'});logger.close();expect(records(root)[0].errorCode).toBe('ENOSPC');});
it('honors log levels and can disable file output completely',()=>{
 const {root,logger,stdout,stderr}=fixture({fileEnabled:false,level:'warn'});logger.emit('info','server.started');logger.emit('warn','oidc.initialize_failed');logger.emit('error','server.start_failed');logger.close();expect(fs.existsSync(path.join(root,'logs'))).toBe(false);expect(stdout.lines).toHaveLength(1);expect(stderr.lines).toHaveLength(1);
});
it.each([1,3])('rotates before exceeding size and retains at most %i total files',maxFiles=>{
 const {root,logger}=fixture({maxFiles,maxBytes:1024});for(let i=0;i<80;i++)logger.emit('info','server.started',{count:i});logger.close();const files=fs.readdirSync(path.join(root,'logs'));expect(files).toHaveLength(maxFiles);for(const name of files)expect(fs.statSync(path.join(root,'logs',name)).size).toBeLessThanOrEqual(1024);expect(records(root).some(r=>r.count===79)).toBe(true);expect(records(root).some(r=>r.count===0)).toBe(false);
});
it('prunes excess owned archives after lowering retention',()=>{const {root,logger}=fixture({maxFiles:5,maxBytes:1024});for(let i=0;i<80;i++)logger.emit('info','server.started');logger.close();const next=logging.createLogger({dataRoot:root,maxFiles:2,stdout:stream(),stderr:stream()});loggers.push(next);next.close();expect(fs.readdirSync(path.join(root,'logs'))).toHaveLength(2);});
it.each(['directory','active','archive','hardlink','fifo'])('rejects unsafe %s without overwriting its target',kind=>{
 const {root,logger}=fixture();logger.close();const dir=path.join(root,'logs'),target=path.join(root,'outside');fs.writeFileSync(target,'UNCHANGED');fs.rmSync(dir,{recursive:true});
 if(kind==='directory')fs.symlinkSync(root,dir);else {fs.mkdirSync(dir);const dest=path.join(dir,kind==='archive'?'ignis.1.jsonl':'ignis.jsonl');if(kind==='hardlink')fs.linkSync(target,dest);else if(kind==='fifo')require('node:child_process').execFileSync('mkfifo',[dest]);else fs.symlinkSync(target,dest);}
 const stderr=stream(),stdout=stream();const next=logging.createLogger({dataRoot:root,stdout,stderr});loggers.push(next);next.emit('info','server.started');next.close();expect(fs.readFileSync(target,'utf8')).toBe('UNCHANGED');expect(stderr.lines.join('')).toContain('logging.file_unavailable');expect(stdout.lines.join('')).toContain('server.started');
});
it('continues console logging and reports only once if disk writes fail',()=>{
 const {logger,stdout,stderr}=fixture();vi.spyOn(fs,'writeSync').mockImplementation(()=>{throw Object.assign(new Error('SECRET disk path'),{code:'ENOSPC'});});logger.emit('info','server.started');logger.emit('info','server.started');logger.close();expect(stdout.lines).toHaveLength(2);expect(stderr.lines).toHaveLength(1);expect(stderr.lines.join('')).not.toContain('SECRET');
});
it('bounds queued events and reports dropped records',()=>{const {root,logger}=fixture({maxQueue:2});for(let i=0;i<50;i++)logger.emit('info','server.started');logger.close();const logs=records(root);expect(logs).toHaveLength(3);expect(logs.find(r=>r.event==='logging.dropped').count).toBe(48);});
it('respects console backpressure while still persisting events',()=>{const {root,logger,stdout}=fixture();stdout.write=line=>{stdout.lines.push(line);return false;};for(let i=0;i<50;i++)logger.emit('info','server.started');logger.flush();expect(stdout.lines).toHaveLength(1);expect(records(root)).toHaveLength(50);stdout.emit('drain');logger.emit('info','server.started');logger.close();expect(stdout.lines).toHaveLength(2);});
it('generates correlation IDs and omits inbound IDs, URLs and bodies including OIDC callbacks',()=>{
 const {root,logger}=fixture();logger.close();const next=logging.configure({dataRoot:root,level:'debug',stdout:stream(),stderr:stream()});
 const req={method:'GET',url:'/api/auth/oidc/callback?code=SECRET&state=SECRET',headers:{'x-request-id':'SECRET'},body:{password:'SECRET'}};
 const res=new EventEmitter();res.setHeader=(name,value)=>{res[name]=value;};res.writableFinished=true;res.statusCode=303;
 logging.httpMiddleware(req,res,()=>{});res.emit('finish');res.emit('close');next.flush();const r=records(root);expect(r).toHaveLength(1);expect(r[0].requestId).toBe(res['X-Request-ID']);expect(r[0].component).toBe('oidc');expect(JSON.stringify(r)).not.toContain('SECRET');
});
it('applies a lower size limit to existing archives on restart',()=>{
 const {root,logger}=fixture({maxBytes:4096,maxFiles:3});for(let i=0;i<60;i++)logger.emit('info','server.started');logger.close();
 const next=logging.createLogger({dataRoot:root,maxBytes:1024,maxFiles:2,stdout:stream(),stderr:stream()});loggers.push(next);next.emit('info','server.started');next.close();for(const name of fs.readdirSync(path.join(root,'logs')))expect(fs.statSync(path.join(root,'logs',name)).size).toBeLessThanOrEqual(1024);
});
it('handles rotation errors without losing console availability or leaking exceptions',()=>{
 const {root,logger,stderr,stdout}=fixture({maxBytes:1024});vi.spyOn(fs,'renameSync').mockImplementation(()=>{throw new Error('SECRET rotation target');});for(let i=0;i<30;i++)logger.emit('info','server.started');logger.close();expect(stdout.lines).toHaveLength(30);expect(stderr.lines.filter(l=>l.includes('logging.file_unavailable'))).toHaveLength(1);expect(stderr.lines.join('')).not.toContain('SECRET');expect(records(root).length).toBeGreaterThan(0);
});
it('preserves request IDs through concurrent asynchronous operations without crossing requests',async()=>{
 const {root,logger}=fixture();logger.close();logging.configure({dataRoot:root,stdout:stream(),stderr:stream()});
 const ids=[];await Promise.all([1,2].map(()=>new Promise(resolve=>{const req={method:'POST',url:'/api/vault/create'},res=new EventEmitter();res.setHeader=(_name,id)=>ids.push(id);logging.httpMiddleware(req,res,()=>{const id=req.ignisRequestId;setImmediate(()=>{logging.emit('info','server.started',{requestId:'00000000-0000-0000-0000-000000000000'});resolve(id);});});})));
 logging.close();expect(records(root).map(r=>r.requestId).sort()).toEqual(ids.sort());expect(new Set(ids).size).toBe(2);
});
it('flushes queued events on close and does not write afterwards',()=>{const {root,logger}=fixture();logger.emit('info','server.started');logger.close();logger.emit('error','server.start_failed');logger.close();expect(records(root)).toHaveLength(1);});
it('isolates a collector error from file logging',()=>{const {root,logger,stdout}=fixture();stdout.emit('error',new Error('SECRET broken collector'));logger.emit('info','server.started');logger.close();expect(records(root)).toHaveLength(1);expect(stdout.lines).toHaveLength(0);});

it('formats safe text in console and rotating files without mixing JSON history',()=>{
 const {root,logger}=fixture();logger.emit('info','server.started');logger.close();
 const stdout=stream(),stderr=stream();
 const next=logging.createLogger({dataRoot:root,format:'text',maxBytes:1024,maxFiles:2,stdout,stderr});loggers.push(next);
 for(let i=0;i<80;i++)next.emit('info','server.started',{count:i,password:'SECRET\nforged',requestId:'SECRET',error:new Error('SECRET')});
 next.close();
 expect(stdout.lines[0]).toMatch(/^\d{4}-.* INFO \[server.started\] .+ count=0\n$/);
 expect(stdout.lines.join('')).not.toContain('SECRET');
 const files=fs.readdirSync(path.join(root,'logs')).filter(n=>n.endsWith('.log'));
 expect(files).toHaveLength(2);
 for(const name of files){expect(fs.statSync(path.join(root,'logs',name)).size).toBeLessThanOrEqual(1024);expect(fs.statSync(path.join(root,'logs',name)).mode&0o777).toBe(0o600);}
 expect(fs.readFileSync(path.join(root,'logs/ignis.log'),'utf8')).toContain('count=79');
 expect(records(root)).toHaveLength(1);
 expect(logging.readLogConfig({IGNIS_LOG_FORMAT:'text'}).format).toBe('text');
});

it.each([
 ['/api/auth/session',401,'no-session','GET','debug'],
 ['/api/vault/info',404,'no-initial-vault','GET','debug'],
 ['/api/auth/session',401,undefined,'GET','warn'],
 ['/api/vault/info?vault=SECRET',404,undefined,'GET','warn'],
 ['/api/auth/login',401,'no-session','POST','warn'],
 ['/api/vault/info',403,'no-initial-vault','GET','warn'],
 ['/api/vault/info',500,'no-initial-vault','GET','error'],
])('classifies expected probes narrowly: %s %s %s %s', (url,status,outcome,method,level)=>{
 const {root,logger}=fixture();logger.close();
 const next=logging.configure({dataRoot:root,level:'debug',stdout:stream(),stderr:stream()});
 const req={url,method,ignisExpectedLogOutcome:outcome};
 const res=new EventEmitter();res.setHeader=()=>{};res.writableFinished=true;res.statusCode=status;
 logging.httpMiddleware(req,res,()=>{});res.emit('finish');next.flush();
 const [record]=records(root);expect(record.level).toBe(level);
 if(url.startsWith('/api/vault/info'))expect(record.operation).toBe('vault.info');
 expect(JSON.stringify(record)).not.toContain('SECRET');
});

it.each(['auth.setup','auth.login','auth.logout','auth.password','oidc.callback'])('uses the confirmed server identity for %s',operation=>{
 const {root,logger}=fixture();logger.close();const next=logging.configure({dataRoot:root,level:'debug',stdout:stream(),stderr:stream()});
 const req={method:'POST',url:operation==='oidc.callback'?'/api/auth/oidc/callback':`/api/auth/${operation.split('.')[1]}`,body:{userId:'SECRET',username:'SECRET'},headers:{'x-user-id':'SECRET'}};
 const res=new EventEmitter();res.setHeader=()=>{};res.writableFinished=true;res.statusCode=200;
 logging.httpMiddleware(req,res,()=>{req.ignisLogUsername='roberto';});res.emit('finish');next.flush();
 expect(records(root)[0]).not.toHaveProperty('userId');expect(records(root)[0].username).toBe('roberto');expect(JSON.stringify(records(root))).not.toContain('SECRET');
});

it.each(['text','json'])('escapes confirmed usernames without forged log lines in %s',format=>{
 const {logger,stdout}=fixture({format});
 logger.emit('info','http.request',{operation:'auth.login',userId:'00000000-0000-4000-8000-000000000001',username:'name\nFORGED\r\x1b"'});
 logger.close();expect(stdout.lines).toHaveLength(1);expect(stdout.lines[0].split('\n')).toHaveLength(2);
 expect(stdout.lines[0]).not.toContain('\r');expect(stdout.lines[0]).not.toContain('\x1b');
 expect(stdout.lines[0]).toContain('username');
});
it('does not take usernames from failed login input',()=>{
 const {root,logger}=fixture();logger.close();const next=logging.configure({dataRoot:root,stdout:stream(),stderr:stream()});
 const req={method:'POST',url:'/api/auth/login',body:{login:'SECRET',username:'SECRET'}};
 const res=new EventEmitter();res.setHeader=()=>{};res.writableFinished=true;res.statusCode=401;
 logging.httpMiddleware(req,res,()=>{});res.emit('finish');next.flush();
 expect(records(root)[0]).not.toHaveProperty('username');expect(JSON.stringify(records(root))).not.toContain('SECRET');
});

it('uses the verified session username on other requests and omits even valid user IDs',()=>{
 const {root,logger}=fixture();logger.close();const next=logging.configure({dataRoot:root,level:'debug',stdout:stream(),stderr:stream()});
 const req={method:'GET',url:'/api/vault/list',auth:{user:{id:'00000000-0000-4000-8000-000000000001',login:'mario'}},body:{username:'SECRET'}};
 const res=new EventEmitter();res.setHeader=()=>{};res.writableFinished=true;res.statusCode=200;
 logging.httpMiddleware(req,res,()=>{});res.emit('finish');
 logging.emit('info','server.started',{userId:req.auth.user.id});next.flush();
 expect(records(root)[0].username).toBe('mario');
 for(const record of records(root))expect(record).not.toHaveProperty('userId');
 expect(JSON.stringify(records(root))).not.toContain('SECRET');
});

it.each([[200,'shares.mounts','debug'],[404,'shares.mounts','warn'],[503,'shares.mounts','error'],[200,'shares.create','info'],[200,'shares.revoke','info'],[200,undefined,'info']])('classifies sharing polling separately: %s %s', (status,operation,level)=>{
 const {root,logger}=fixture();logger.close();const next=logging.configure({dataRoot:root,level:'debug',stdout:stream(),stderr:stream()});
 const req={method:'POST',url:'/api/shares',body:{operation:'mounts'}};
 const res=new EventEmitter();res.setHeader=()=>{};res.writableFinished=true;res.statusCode=status;
 logging.httpMiddleware(req,res,()=>{req.ignisLogOperation=operation;});res.emit('finish');next.flush();
 expect(records(root)[0].level).toBe(level);expect(records(root)[0].operation).toBe(operation || 'shares.manage');
});

it.each(['text','json'])('records escaped vault names for lifecycle operations in %s',format=>{
 const {logger,stdout}=fixture({format});
 logger.emit('info','http.request',{operation:'vault.rename',vaultName:'New "notes"\n',previousVaultName:'Old notes'});logger.close();
 expect(stdout.lines[0]).toContain('previousVaultName');expect(stdout.lines[0]).toContain('vaultName');
 expect(stdout.lines[0].split('\n')).toHaveLength(2);
 if(format==='json')expect(JSON.parse(stdout.lines[0])).toMatchObject({vaultName:'New "notes"\n',previousVaultName:'Old notes'});
});

it.each([['GET',200,'users.list',undefined],['POST',201,'users.create','mario'],['POST',400,'users.create',undefined]])('distinguishes user listing and creation: %s %s',(method,status,operation,target)=>{
 const {root,logger}=fixture();logger.close();const next=logging.configure({dataRoot:root,level:'debug',stdout:stream(),stderr:stream()});
 const req={method,url:'/api/auth/users',body:{login:'UNVERIFIED'}};
 const res=new EventEmitter();res.setHeader=()=>{};res.writableFinished=true;res.statusCode=status;
 logging.httpMiddleware(req,res,()=>{req.ignisLogUsername='admin';req.ignisLogTargetUsername=target;});res.emit('finish');next.flush();
 const record=records(root)[0];expect(record.operation).toBe(operation);expect(record.username).toBe('admin');expect(record.targetUsername).toBe(target);expect(JSON.stringify(record)).not.toContain('UNVERIFIED');
});

it('records only typed account changes and distinguishes HTTP status from account status',()=>{
 const {root,logger}=fixture();
 logger.emit('info','http.request',{operation:'users.status',username:'admin',targetUsername:'mario',status:200,previousAccountStatus:'active',accountStatus:'disabled',changed:true,emailChanged:true,previousRole:'user',role:'admin',email:'SECRET',previousEmailVerification:'unverified',emailVerification:'admin_confirmed',passwordChangeRequired:true});
 logger.emit('info','http.request',{operation:'users.status',accountStatus:'SECRET',role:'SECRET',changed:'SECRET'});logger.close();
 expect(records(root)[0]).toMatchObject({targetUsername:'mario',status:200,previousAccountStatus:'active',accountStatus:'disabled',changed:true,emailChanged:true,role:'admin',passwordChangeRequired:true});
 expect(JSON.stringify(records(root))).not.toContain('SECRET');
});

it.each(['text','json'])('logs unverified failed-login names distinctly and safely in %s',format=>{
 const {logger,stdout,stderr}=fixture({format});
 logger.emit('warn','http.request',{operation:'auth.login',status:401,attemptedUsername:'wrong\nFORGED\x1b"'});
 logger.emit('info','http.request',{operation:'auth.login',status:200,attemptedUsername:'MUST_NOT_APPEAR'});logger.close();
 const output=stdout.lines.concat(stderr.lines).join('');expect(output).toContain('attemptedUsername');expect(output).not.toContain('MUST_NOT_APPEAR');
 expect(output.split('\n')).toHaveLength(3);expect(output).not.toContain('\x1b');
 if(format==='json')expect(JSON.parse(stdout.lines[0])).not.toHaveProperty('username');
});

it.each(['users.delete','users.reset-password','users.set-password','users.revoke-sessions','users.unlink-oidc','vault.members','vault.transfer-ownership','shares.create','shares.validateGrant'])('retains actor and target for %s',operation=>{
 const {root,logger}=fixture();logger.emit('info','http.request',{operation,username:'admin',targetUsername:'mario'});logger.close();expect(records(root)[0]).toMatchObject({operation,username:'admin',targetUsername:'mario'});
});
it('attributes websocket lifecycle events without exposing the session token',()=>{
 const {root,logger}=fixture();logger.emit('info','core.ws.connected',{component:'websocket',username:'mario',vaultName:'Notes',token:'SECRET'});logger.close();expect(records(root)[0]).toMatchObject({username:'mario',vaultName:'Notes'});expect(JSON.stringify(records(root))).not.toContain('SECRET');
});

it('keeps a confirmed OIDC callback visible at info despite its GET redirect',()=>{
 const {root,logger}=fixture();logger.close();const next=logging.configure({dataRoot:root,stdout:stream(),stderr:stream()});
 const req={method:'GET',url:'/api/auth/oidc/callback?code=SECRET'};
 const res=new EventEmitter();res.setHeader=()=>{};res.writableFinished=true;res.statusCode=303;
 logging.httpMiddleware(req,res,()=>{req.ignisLogUsername='mario';});res.emit('finish');next.flush();
 expect(records(root)[0]).toMatchObject({level:'info',operation:'oidc.callback',username:'mario'});expect(JSON.stringify(records(root))).not.toContain('SECRET');
});

it.each([
 ['Europe/Madrid','2026-11-01T08:21:23.121Z','2026-11-01T09:21:23.121+01:00'],
 ['Europe/Madrid','2026-07-01T08:21:23.121Z','2026-07-01T10:21:23.121+02:00'],
 ['UTC','2026-11-01T08:21:23.121Z','2026-11-01T08:21:23.121+00:00'],
 ['Asia/Kolkata','2026-11-01T23:21:23.121Z','2026-11-02T04:51:23.121+05:30'],
 ['America/New_York','2026-07-01T02:21:23.121Z','2026-06-30T22:21:23.121-04:00'],
])('formats log dates using TZ=%s', (zone, input, expected) => {
 const script = `const {formatLogTime}=require(${JSON.stringify(require.resolve('./logger'))});process.stdout.write(formatLogTime(new Date(${JSON.stringify(input)})));`;
 const output=execFileSync(process.execPath,['-e',script],{env:{...process.env,TZ:zone},encoding:'utf8'});
 expect(output).toBe(expected);
 expect(Date.parse(output)).toBe(Date.parse(input));
});

it('persists distinct fork, upstream and Obsidian versions without arbitrary metadata',()=>{
 const {root,logger}=fixture();logger.emit('info','server.started',{version:'1.0.0',upstreamVersion:'0.9.0',obsidianVersion:'1.14.4',commit:'secret-path'});logger.close();
 expect(records(root)[0]).toMatchObject({version:'1.0.0',upstreamVersion:'0.9.0',obsidianVersion:'1.14.4'});
 expect(records(root)[0]).not.toHaveProperty('commit');
});
