import {it,expect,vi} from 'vitest';import {createRequire} from 'node:module';
const {createSharing}=createRequire(import.meta.url)('./sharing');
function fixture(store={}){
 let session={id:'s',user:{id:'u',role:'user',authVersion:1}};const changed=vi.fn();
 const service=createSharing({store:{limits:{},...store},sessions:{resolve:()=>session},onChanged:changed});
 return {service,changed,swap:()=>session={...session,id:'other'}};
}
it('pins internal credentials without accepting actor identity from input and notifies only after success',()=>{
 const create=vi.fn(()=>({id:'resource'})),catalog=vi.fn(()=>({resources:[]}));const f=fixture({create,catalog});
 expect(f.service.create('secret',{userId:'attacker'})).toEqual({id:'resource'});
 expect(create.mock.calls[0][0]).toEqual({token:'secret',context:{sessionId:'s',userId:'u',role:'user',authVersion:1}});
 expect(Object.isFrozen(create.mock.calls[0][0].context)).toBe(true);expect(f.changed).toHaveBeenCalledTimes(1);
 f.service.catalog('secret');expect(f.changed).toHaveBeenCalledTimes(1);
 expect(()=>f.service.execute('secret','constructor',{})).toThrow();
});
it('does not release a delayed read to a substituted session',async()=>{
 let release;const f=fixture({read:()=>new Promise(r=>release=r)});const read=f.service.read('secret',{});f.swap();release({content:'private'});
 await expect(read).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});expect(f.changed).not.toHaveBeenCalled();
});
it('notifies confirmed mutations even if their caller loses its session before the response',async()=>{
 let release;const f=fixture({grants:()=>new Promise(r=>release=r)});const grant=f.service.grants('secret',{});f.swap();release({ok:true});
 await expect(grant).rejects.toThrow();expect(f.changed).toHaveBeenCalledTimes(1);
});
it('does not turn a notification failure into a failed committed command',()=>{
 const service=createSharing({store:{limits:{},grants:()=>({ok:true})},sessions:{resolve:()=>({id:'s',user:{id:'u',role:'user',authVersion:1}})},onChanged:()=>{throw Error('watcher');},onNotificationError:()=>{throw Error('logger');}});
 expect(service.grants('secret',{})).toEqual({ok:true});
});
it('invalidates uncertain publications but not rejected commands',async()=>{
 const f=fixture({mutate:async()=>{throw Object.assign(Error('unknown'),{code:'SHARE_WRITE_UNCERTAIN'});},grants:()=>{throw Error('denied');}});
 await expect(f.service.mutate('secret',{})).rejects.toThrow();expect(f.changed).toHaveBeenCalledTimes(1);
 expect(()=>f.service.grants('secret',{})).toThrow();expect(f.changed).toHaveBeenCalledTimes(1);
});

it('treats bulk grants as a mutation and rejects the retired single-grant command',()=>{
 const f=fixture({grants:()=>({ok:true}),validateGrant:()=>({ok:true})});
 f.service.validateGrant('secret',{});expect(f.changed).not.toHaveBeenCalled();
 f.service.grants('secret',{});expect(f.changed).toHaveBeenCalledOnce();
 expect(()=>f.service.execute('secret','grant',{})).toThrow();
});
