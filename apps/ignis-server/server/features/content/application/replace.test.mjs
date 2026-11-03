import {it,expect,vi} from 'vitest';import {createRequire} from 'node:module';
const {createContentReplacement}=createRequire(import.meta.url)('./replace');
function fixture(change){
 let selected={item:{filename:'/vault/a.md'},vaultId:'v',actorId:'u'};
 const publisher={replace:vi.fn(()=>({outcome:'committed'}))};
 const queue={flushPending:vi.fn(async()=>{if(change)selected=change(selected);}),supersedePending:(_path,run)=>run(),getPending:()=>null};
 return {service:createContentReplacement({queue,publisher}),publisher,queue,select:()=>selected};
}
it.each(['path','actor','vault'])('does not publish under a stale queue key after %s changes',async kind=>{
 const f=fixture(value=>kind==='path'?{...value,item:{filename:'/other/a.md'}}:kind==='actor'?{...value,actorId:'other'}:{...value,vaultId:'other'});
 await expect(f.service.replace({select:f.select,bytes:new Uint8Array(),expectedHash:null})).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 expect(f.publisher.replace).not.toHaveBeenCalled();
});
it('rejects a missing version precondition syntax before flushing other writes',async()=>{
 const f=fixture();await expect(f.service.replace({select:f.select,bytes:new Uint8Array(),expectedHash:'*'})).rejects.toMatchObject({code:'CONTENT_VERSION_REQUIRED'});
 expect(f.queue.flushPending).not.toHaveBeenCalled();expect(f.publisher.replace).not.toHaveBeenCalled();
});
