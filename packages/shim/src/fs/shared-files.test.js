import {contentHash} from "./content-versions.js";
import {it,expect,vi} from 'vitest';
import {MetadataCache} from './metadata-cache.js';
import {createSharedFiles,SHARED_ROOT} from './shared-files.js';
function fixture(role='editor',initial={},mountPath='Project') {
 const id='12345678-1234-1234-1234-123456789abc',folder=mountPath,file=folder+'/note.md';
 const ctx={sessionId:'session',vault:'vault'},cache=new MetadataCache(),failure=vi.fn(),removed=vi.fn(),watch={_dispatch:vi.fn()},ordinary={readFile:vi.fn(),writeFile:vi.fn(),rename:vi.fn(),readdir:vi.fn(),stat:vi.fn(),mkdir:vi.fn(),unlink:vi.fn(),appendFile:vi.fn()};
 let offline=false,loseResponse=false,outgoing=[],content='original',etag=contentHash('original'),revoked=false,sharedId=id,localPath=folder,notePath='note.md';
 const calls=[];
 const serve=body=>{const {operation,input}=JSON.parse(body);calls.push({operation,input});
  if(operation==='mounts')return {status:200,data:{limits:{maxFileBytes:1000},outgoing,mounts:revoked?[]:[{id:sharedId,localPath,name:'Project',kind:'directory',role,tree:{'':{type:'directory'},[notePath]:{type:'file',size:content.length,mtime:1}}}]}};
  if(revoked)return {status:404,data:{}};
  if(operation==='destination'){localPath=input.localPath;return {status:200,data:{ok:true}};}
  if(operation==='rename'){if(input.path==='')localPath=input.to;else notePath=input.to;return {status:200,data:{ok:true}};}
  if(operation==='read')return {status:200,data:{kind:'file',content:btoa(content),etag}};
  if(operation==='write'){if(input.etag!==etag)return {status:409,data:{code:'SHARE_CONFLICT'}};content=atob(input.content);etag=contentHash(content);return {status:200,data:{etag}};}
 };
 const shared=createSharedFiles({metadataCache:cache,watch,currentContext:()=>ctx,onFailure:failure,onRemoved:removed,request:async(url,options)=>{if(offline)throw new Error("Network unavailable");const r=serve(options.body);if(loseResponse && JSON.parse(options.body).operation==='write')throw new Error("Response lost");return {status:r.status,json:async()=>r.data};},createXHR:()=>({open(){},setRequestHeader(){},send(body){const r=serve(body);this.status=r.status;this.responseText=JSON.stringify(r.data);}})});
 cache.populate(shared.configure(initial));
 return {removed,setRole:value=>role=value,setOffline:value=>offline=value,loseResponse:()=>loseResponse=true,setOutgoing:value=>outgoing=value,shared,fs:shared.wrap(ordinary),ordinary,cache,ctx,calls,file,folder,failure,watch,revoke:()=>revoked=true,replace:()=>{sharedId='87654321-1234-1234-1234-123456789abc';},change:()=>{content='remote';etag=contentHash('remote');}};
}
it('mounts metadata without ordinary filesystem reads or copies',async()=>{const f=fixture();expect(await f.fs.readdir(f.folder)).toEqual(['note.md']);expect(await f.fs.readFile(f.file,'utf8')).toBe('original');expect(f.ordinary.readFile).not.toHaveBeenCalled();expect(f.calls.at(-1).input).toEqual({id:'12345678-1234-1234-1234-123456789abc',path:'note.md'});});
it('writes the original with an etag and does not forward into the active vault',async()=>{const f=fixture();await f.fs.readFile(f.file);await f.fs.writeFile(f.file,'edited');expect(await f.fs.readFile(f.file,'utf8')).toBe('edited');expect(f.ordinary.writeFile).not.toHaveBeenCalled();});
it('separates a stale editor baseline from a plugin intentional replacement',async()=>{
 const f=fixture();await f.fs.readFile(f.file);f.change();await f.fs.readFile(f.file);
 await expect(f.shared.writeEditor(f.file,'stale','a'.repeat(64))).rejects.toMatchObject({code:'SHARE_CONFLICT'});
 await f.fs.writeFile(f.file,'intentional plugin replacement');expect(await f.fs.readFile(f.file,'utf8')).toBe('intentional plugin replacement');
 expect(f.ordinary.writeFile).not.toHaveBeenCalled();
});
it('requires Write permission and a valid baseline for explicit editor saves',async()=>{
 const reader=fixture('reader');await expect(reader.shared.writeEditor(reader.file,'no','a'.repeat(64))).rejects.toMatchObject({code:'EACCES'});
 const f=fixture();for(const version of [undefined,null,'*'])await expect(f.shared.writeEditor(f.file,'no',version)).rejects.toThrow();
 expect(f.calls.some(c=>c.operation==='write')).toBe(false);
});
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

it('renames a writable descendant through the content API and retains its write baseline',async()=>{const f=fixture();await f.fs.readFile(f.file);await f.fs.rename(f.file,'Project/Renamed.md');expect(f.calls.find(c=>c.operation==='rename').input).toEqual({id:'12345678-1234-1234-1234-123456789abc',path:'note.md',to:'Renamed.md',etag:contentHash('original')});await f.fs.writeFile('Project/Renamed.md','renamed content');expect(f.ordinary.rename).not.toHaveBeenCalled();});
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

it('preserves open editors on downgrade and blocks stale saves even after write access returns',async()=>{
 const f=fixture();await f.fs.readFile(f.file);f.setRole('reader');await f.shared.refresh();expect(f.removed).toHaveBeenCalledWith(f.file,"read-only");
 await expect(f.fs.writeFile(f.file,'draft')).rejects.toMatchObject({code:'EACCES'});expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({content:'draft'}));
 f.setRole('editor');await f.shared.refresh();await expect(f.fs.writeFile(f.file,'old draft')).rejects.toMatchObject({code:'SHARE_CONFLICT'});
});
it('retains disconnected writes and never retries stale content automatically on reconnection',async()=>{
 const f=fixture();await f.fs.readFile(f.file);f.setOffline(true);await expect(f.fs.writeFile(f.file,'offline draft')).rejects.toThrow('Network');
 expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({content:'offline draft'}));f.setOffline(false);f.change();await f.shared.refresh();
 await expect(f.fs.writeFile(f.file,'offline draft')).rejects.toMatchObject({code:'SHARE_CONFLICT'});expect(f.calls.filter(c=>c.operation==='write')).toHaveLength(0);
});
it('treats a lost successful write response as uncertain and retains a recovery copy without replay',async()=>{
 const f=fixture();await f.fs.readFile(f.file);f.loseResponse();await expect(f.fs.writeFile(f.file,'published')).rejects.toThrow('Response lost');
 expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({content:'published'}));expect(await f.fs.readFile(f.file,'utf8')).toBe('published');
 await expect(f.fs.writeFile(f.file,'published')).rejects.toMatchObject({code:'SHARE_CONFLICT'});expect(f.calls.filter(c=>c.operation==='write')).toHaveLength(1);
});

it('saves a received resource using the editor baseline and advances only after acknowledgement',async()=>{
 const f=fixture();await f.shared.writeEditor(f.file,'draft',contentHash('original'));
 expect(await f.fs.readFile(f.file,'utf8')).toBe('draft');
 await f.shared.writeEditor(f.file,'next draft',contentHash('draft'));
 expect(await f.fs.readFile(f.file,'utf8')).toBe('next draft');expect(f.ordinary.writeFile).not.toHaveBeenCalled();
});
it('does not acquire a fresh remote version on behalf of an outdated editor',async()=>{
 const f=fixture();f.change();await f.fs.readFile(f.file,'utf8');
 const reads=f.calls.filter(c=>c.operation==='read').length;
 await expect(f.shared.writeEditor(f.file,'old draft',contentHash('original'))).rejects.toMatchObject({code:'SHARE_CONFLICT'});
 expect(f.calls.filter(c=>c.operation==='read')).toHaveLength(reads);
 expect(await f.fs.readFile(f.file,'utf8')).toBe('remote');
});

it('keeps append bound to the content it read instead of fetching a newer replacement baseline',async()=>{
 const f=fixture();await f.fs.appendFile(f.file,' appended');
 expect(await f.fs.readFile(f.file,'utf8')).toBe('original appended');
 const operations=f.calls.map(c=>c.operation);expect(operations.filter(x=>x==='read')).toHaveLength(2);
 expect(f.calls.find(c=>c.operation==='write').input.etag).toBe(contentHash('original'));
});
it('routes a move inside one received folder through the shared API and preserves the write baseline',async()=>{
 const f=fixture();await f.fs.readFile(f.file);
 f.cache.set('Project/Sub',{type:'directory'});
 await f.fs.rename(f.file,'Project/Sub/note.md');
 expect(f.calls.find(c=>c.operation==='rename').input).toMatchObject({path:'note.md',to:'Sub/note.md',etag:contentHash('original')});
 expect(f.cache.has(f.file)).toBe(false);
 await f.fs.writeFile('Project/Sub/note.md','moved content');
 expect(f.ordinary.rename).not.toHaveBeenCalled();expect(f.ordinary.writeFile).not.toHaveBeenCalled();
});
