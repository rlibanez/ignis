import {it,expect,afterEach,vi} from 'vitest';
import {createFsPromises} from './promises.js';
import {createFsSync} from './sync.js';
import {createFdOps} from './fd.js';
import {ContentCache} from './content-cache.js';
import {MetadataCache} from './metadata-cache.js';
import {_reset as resetWrites} from './write-coalescer.js';
import {_reset as resetDurability} from './write-durability.js';
afterEach(()=>{resetWrites();resetDurability();});
it.each(['async','sync','descriptor'])('allows %s plugin reads followed by intentional replacement without a pinned editor baseline',async mode=>{
 const cache=new ContentCache(),meta=new MetadataCache();
 meta.set('note.md',{type:'file',size:4,mtime:1});cache.set('note.md','base');
 const transport={writeFile:vi.fn(async(path,data)=>{
   return {mtime:2,size:data.length};
 })};
 const async=createFsPromises(meta,cache,transport),sync=createFsSync(meta,cache,transport);
 if(mode==='async')expect(await async.readFile('note.md','utf8')).toBe('base');
 if(mode==='sync')expect(sync.readFileSync('note.md','utf8')).toBe('base');
 if(mode==='descriptor'){const fd=createFdOps(meta,cache,transport),id=fd.openSync('note.md','r');fd.closeSync(id);}
 cache.invalidate('note.md');cache.setFromServer('note.md','new remote',cache.pathUpdates('note.md'));
 expect(await async.readFile('note.md','utf8')).toBe('new remote');
 await async.writeFile('note.md','my old draft','utf8');expect(transport.writeFile).toHaveBeenCalledTimes(1);
});
it('preserves synchronous plugin writes and coalesced delivery',async()=>{
 const cache=new ContentCache(),meta=new MetadataCache();
 const transport={writeFile:vi.fn(async(path,data)=>{return {mtime:1,size:data.length};})};
 createFsPromises(meta,cache,transport);const sync=createFsSync(meta,cache,transport);
 sync.writeFileSync('new.md','draft','utf8');expect(sync.readFileSync('new.md','utf8')).toBe('draft');
 await vi.waitFor(()=>expect(transport.writeFile).toHaveBeenCalledTimes(1));
});
