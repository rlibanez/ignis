import {it,expect,vi} from 'vitest';
import {MetadataCache} from './metadata-cache.js';
import {createSharedFiles,SHARED_ROOT} from './shared-files.js';
function fixture(role='editor',initial={},mountPath='Project') {
 const id='12345678-1234-1234-1234-123456789abc',folder=mountPath,file=folder+'/note.md';
 const ctx={sessionId:'session',vault:'vault'},cache=new MetadataCache(),failure=vi.fn(),watch={_dispatch:vi.fn()},ordinary={readFile:vi.fn(),writeFile:vi.fn(),rename:vi.fn(),readdir:vi.fn(),stat:vi.fn(),mkdir:vi.fn(),unlink:vi.fn()};
 let outgoing=[],content='original',etag='first',revoked=false,sharedId=id,localPath=folder,notePath='note.md';
 const calls=[];
 const serve=body=>{const {operation,input}=JSON.parse(body);calls.push({operation,input});
  if(operation==='mounts')return {status:200,data:{limits:{maxFileBytes:1000},outgoing,mounts:revoked?[]:[{id:sharedId,localPath,name:'Project',kind:'directory',role,tree:{'':{type:'directory'},[notePath]:{type:'file',size:content.length,mtime:1}}}]}};
  if(revoked)return {status:404,data:{}};
  if(operation==='destination'){localPath=input.localPath;return {status:200,data:{ok:true}};}
  if(operation==='rename'){if(input.path==='')localPath=input.to;else notePath=input.to;return {status:200,data:{ok:true}};}
  if(operation==='read')return {status:200,data:{kind:'file',content:btoa(content),etag}};
  if(operation==='write'){if(input.etag!==etag)return {status:409,data:{code:'SHARE_CONFLICT'}};content=atob(input.content);etag='next';return {status:200,data:{etag}};}
 };
 const shared=createSharedFiles({metadataCache:cache,watch,currentContext:()=>ctx,onFailure:failure,request:async(url,options)=>{const r=serve(options.body);return {status:r.status,json:async()=>r.data};},createXHR:()=>({open(){},setRequestHeader(){},send(body){const r=serve(body);this.status=r.status;this.responseText=JSON.stringify(r.data);}})});
 cache.populate(shared.configure(initial));
 return {setOutgoing:value=>outgoing=value,shared,fs:shared.wrap(ordinary),ordinary,cache,ctx,calls,file,folder,failure,watch,revoke:()=>revoked=true,replace:()=>{sharedId='87654321-1234-1234-1234-123456789abc';},change:()=>{content='remote';etag='remote';}};
}
it('mounts metadata without ordinary filesystem reads or copies',async()=>{const f=fixture();expect(await f.fs.readdir(f.folder)).toEqual(['note.md']);expect(await f.fs.readFile(f.file,'utf8')).toBe('original');expect(f.ordinary.readFile).not.toHaveBeenCalled();expect(f.calls.at(-1).input).toEqual({id:'12345678-1234-1234-1234-123456789abc',path:'note.md'});});
it('writes the original with an etag and does not forward into the active vault',async()=>{const f=fixture();await f.fs.readFile(f.file);await f.fs.writeFile(f.file,'edited');expect(await f.fs.readFile(f.file,'utf8')).toBe('edited');expect(f.ordinary.writeFile).not.toHaveBeenCalled();});
it('keeps the first read baseline despite indexing reads and stops conflicting saves',async()=>{const f=fixture();await f.fs.readFile(f.file);f.change();await f.fs.readFile(f.file);await expect(f.fs.writeFile(f.file,'stale')).rejects.toMatchObject({code:'SHARE_CONFLICT'});expect(f.failure).toHaveBeenCalled();const count=f.calls.length;await expect(f.fs.writeFile(f.file,'again')).rejects.toThrow();expect(f.calls).toHaveLength(count);});
it('rejects reader writes and never falls back to the ordinary vault',async()=>{const f=fixture('reader');await expect(f.fs.writeFile(f.file,'bad')).rejects.toMatchObject({code:'EACCES'});expect(f.ordinary.writeFile).not.toHaveBeenCalled();});
it('removes revoked metadata and denies reads without fallback',async()=>{const f=fixture();f.revoke();await f.shared.refresh();expect(f.cache.has(f.file)).toBe(false);await expect(f.fs.readFile(f.file)).rejects.toMatchObject({code:'ENOENT'});expect(f.ordinary.readFile).not.toHaveBeenCalled();expect(f.watch._dispatch).toHaveBeenCalledWith('rename',f.file);});
it('denies cross-boundary moves and descriptor access',async()=>{const f=fixture();await expect(f.fs.rename('local.md',f.file)).rejects.toMatchObject({code:'ENOTSUP'});expect(()=>f.shared.assertOrdinary(f.file,f.file)).toThrow();expect(f.ordinary.rename).not.toHaveBeenCalled();});
it('rejects traversal and changed sessions',()=>{const f=fixture();expect(()=>f.fs.readFile(f.folder+'/../secret')).toThrow();f.ctx.sessionId='other';expect(()=>f.fs.readFile(f.file)).toThrow();});
it('provides session-bound attachment URLs only for shared paths',()=>{const f=fixture();expect(f.shared.resourceUrl('local.png')).toBe(null);expect(f.shared.resourceUrl(f.file)).toContain('context=session');});
it('leaves ordinary files with their existing implementation',async()=>{const f=fixture();await f.fs.readFile('local.md');expect(f.ordinary.readFile).toHaveBeenCalledWith('local.md');});

it('preserves a real folder with the reserved name instead of hiding it',async()=>{const f=fixture('editor',{[SHARED_ROOT]:{type:'directory'}});expect(f.shared.owns(SHARED_ROOT)).toBe(false);await f.fs.readdir(SHARED_ROOT);expect(f.ordinary.readdir).toHaveBeenCalled();});
it('routes synchronous reads and writes through the same guarded API',()=>{const f=fixture();const sync=f.shared.wrap({readFileSync:vi.fn(),writeFileSync:vi.fn()},true);expect(sync.readFileSync(f.file,'utf8')).toBe('original');sync.writeFileSync(f.file,'sync edit');expect(sync.readFileSync(f.file,'utf8')).toBe('sync edit');});

it('requests mounts for the current vault UUID',()=>{const f=fixture();expect(f.calls[0]).toEqual({operation:'mounts',input:{vault:'vault'}});});

it('moves a received root personally without changing its real name, even with Read',async()=>{const f=fixture('reader');await f.fs.rename(f.folder,'Work/Project');expect(f.calls.find(c=>c.operation==='destination').input).toEqual({id:'12345678-1234-1234-1234-123456789abc',vault:'vault',localPath:'Work/Project'});expect(f.shared.owns('Work/Project/note.md')).toBe(true);});
it.each(['reader','editor'])('renames a root locally with %s without mutating the source',async role=>{const f=fixture(role);await f.fs.rename(f.folder,'Alias');expect(f.calls.find(c=>c.operation==='destination').input).toMatchObject({localPath:'Alias'});expect(f.calls.some(c=>c.operation==='rename')).toBe(false);expect(f.shared.owns('Alias/note.md')).toBe(true);});

it('renames a writable descendant through the content API and retains its write baseline',async()=>{const f=fixture();await f.fs.readFile(f.file);await f.fs.rename(f.file,'Project/Renamed.md');expect(f.calls.find(c=>c.operation==='rename').input).toEqual({id:'12345678-1234-1234-1234-123456789abc',path:'note.md',to:'Renamed.md',etag:'first'});await f.fs.writeFile('Project/Renamed.md','renamed content');expect(f.ordinary.rename).not.toHaveBeenCalled();});
it('rejects descendant rename for readers and occupied local names',async()=>{const f=fixture('reader');await expect(f.fs.rename(f.file,'Project/Other.md')).rejects.toMatchObject({code:'EACCES'});f.cache.set('Taken',{type:'directory'});await expect(f.fs.rename(f.folder,'Taken')).rejects.toMatchObject({code:'EEXIST'});});
it('stops configuration if the initial mount map cannot be loaded',()=>{
 const shared=createSharedFiles({metadataCache:new MetadataCache(),watch:{_dispatch(){}},currentContext:()=>({sessionId:'s',vault:'v'}),createXHR:()=>({open(){},setRequestHeader(){},send(){this.status=503;this.responseText='{}';}})});
 expect(()=>shared.configure({})).toThrow();
});

it('treats prototype-like local names as ordinary mount names',async()=>{const f=fixture('editor',{},'__proto__');expect((await f.fs.stat(f.folder)).isDirectory()).toBe(true);expect(await f.fs.readFile(f.file,'utf8')).toBe('original');});

it('does not reuse an open editor save baseline for a different grant at the same local path',async()=>{const f=fixture();await f.fs.readFile(f.file);f.replace();await f.shared.refresh();await expect(f.fs.writeFile(f.file,'old editor')).rejects.toMatchObject({code:'SHARE_CONFLICT'});});

it('decorates only explicit outgoing roots without mounting them or changing their filesystem route',async()=>{
 const f=fixture();f.setOutgoing([{path:'Sent',kind:'directory'},{path:'Only.md',kind:'file'}]);await f.shared.refresh();
 expect(f.shared.describe('Sent')).toMatchObject({direction:'outgoing'});expect(f.shared.describe('Sent/child.md')).toBe(null);
 expect(f.shared.describe('SentOther/child.md')).toBe(null);expect(f.shared.describe('Only.md')).toMatchObject({direction:'outgoing'});expect(f.shared.describe('Only.md/child')).toBe(null);
 expect(f.shared.describe(f.file)).toMatchObject({direction:'incoming'});expect(f.shared.owns('Sent/child.md')).toBe(false);
 await f.fs.readFile('Sent/child.md');expect(f.ordinary.readFile).toHaveBeenCalledWith('Sent/child.md');
 f.setOutgoing([]);await f.shared.refresh();expect(f.shared.describe('Sent')).toBe(null);
 f.setOutgoing([{path:'Sent',kind:'directory'}]);await f.shared.refresh();f.shared.stop();expect(f.shared.describe('Sent')).toBe(null);
});
