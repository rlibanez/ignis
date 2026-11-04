import {it,expect,vi,afterEach} from 'vitest';import {createRequire} from 'node:module';
const {createSharingEvents}=createRequire(import.meta.url)('./events');
afterEach(()=>vi.useRealTimers());
it('resolves content recipients at delivery and never sends a queued event to a revoked user',async()=>{
 vi.useFakeTimers();let revoked=false;
 const ws={readyState:1,terminate:vi.fn()},entry={token:'recipient',events:true,sendState:vi.fn(),stateSnapshot:'{}'};
 const store={snapshot:()=>({}),sources:()=>new Set(),affectedUsers:vi.fn(()=>new Set(revoked?[]:['recipient']))};
 const events=createSharingEvents({dataRoot:'/data',store,sessions:{resolve:()=>({user:{id:'recipient'}})},entries:new Map([[ws,entry]]),valid:()=>true,failed:vi.fn(),observeDatabase:()=>()=>{}});
 events.contentChanged('Source',{path:'note.md'});revoked=true;await vi.advanceTimersByTimeAsync(50);
 expect(store.affectedUsers).toHaveBeenCalledTimes(1);expect(entry.sendState).not.toHaveBeenCalled();events.close();
});
it('bounds pending path bursts and drops every scheduled task on close',async()=>{
 vi.useFakeTimers();const affectedUsers=vi.fn(()=>new Set()),store={snapshot:()=>({}),sources:()=>new Set(),affectedUsers};
 const stop=vi.fn(),events=createSharingEvents({dataRoot:'/data',store,sessions:{resolve:()=>null},entries:new Map(),valid:()=>true,failed:vi.fn(),observeDatabase:()=>stop});
 for(let i=0;i<1000;i++)events.contentChanged('Source',{path:'note'+i+'.md'});
 await vi.advanceTimersByTimeAsync(50);expect(affectedUsers.mock.calls[0][1]).toEqual(new Set(['']));
 expect(vi.getTimerCount()).toBe(0);events.schedule();events.contentChanged('Source',{path:'later.md'});events.close();events.close();await vi.advanceTimersByTimeAsync(1000);
 expect(affectedUsers).toHaveBeenCalledTimes(1);expect(stop).toHaveBeenCalledTimes(1);
});

it('closes sockets and rejects new subscriptions until its database observer recovers',()=>{
 vi.useFakeTimers();let observer;const ws={terminate:vi.fn()};
 const events=createSharingEvents({dataRoot:'/data',store:{snapshot:()=>({}),sources:()=>new Set()},sessions:{resolve:()=>null},entries:new Map([[ws,{}]]),valid:()=>true,failed:vi.fn(),observeDatabase:options=>{observer=options;return ()=>{};}});
 expect(events.available()).toBe(true);observer.unavailable();expect(events.available()).toBe(false);expect(ws.terminate).toHaveBeenCalledTimes(1);
 observer.recovered();expect(events.available()).toBe(true);events.close();expect(events.available()).toBe(false);expect(vi.getTimerCount()).toBe(0);
});
