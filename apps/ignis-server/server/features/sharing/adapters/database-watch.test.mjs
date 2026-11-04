import {it,expect,vi,afterEach} from 'vitest';import {EventEmitter} from 'node:events';import {createRequire} from 'node:module';
const {observeIdentityDatabase}=createRequire(import.meta.url)('./database-watch');
afterEach(()=>vi.useRealTimers());
it('watches commits without polling and rearms on errors with bounded backoff',async()=>{
 vi.useFakeTimers();const observers=[],callbacks=[],changed=vi.fn(),unavailable=vi.fn();let broken=false;
 const watch=vi.fn((_path,fn)=>{if(broken)throw Error('offline');callbacks.push(fn);const observer=new EventEmitter();observer.close=vi.fn(()=>observer.emit('close'));observers.push(observer);return observer;});
 const close=observeIdentityDatabase({dataRoot:'/data',changed,unavailable,watch});
 expect(vi.getTimerCount()).toBe(0);callbacks[0]('change','identity.sqlite-wal');expect(changed).toHaveBeenCalledTimes(1);
 callbacks[0]('change','unrelated');expect(changed).toHaveBeenCalledTimes(1);
 broken=true;observers[0].emit('error',Error('watch failed'));expect(unavailable).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1000);expect(watch).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(1999);expect(watch).toHaveBeenCalledTimes(2);
 broken=false;await vi.advanceTimersByTimeAsync(1);expect(watch).toHaveBeenCalledTimes(3);expect(changed).toHaveBeenCalledTimes(2);
 callbacks[0]('change','identity.sqlite');expect(changed).toHaveBeenCalledTimes(2);
 expect(vi.getTimerCount()).toBe(0);close();close();await vi.advanceTimersByTimeAsync(60000);expect(watch).toHaveBeenCalledTimes(3);
});
it('cancels recovery when closed while the directory is unavailable',async()=>{
 vi.useFakeTimers();const watch=vi.fn(()=>{throw Error('missing');});
 const close=observeIdentityDatabase({dataRoot:'/data',changed:vi.fn(),unavailable:vi.fn(),watch});close();
 await vi.advanceTimersByTimeAsync(60000);expect(watch).toHaveBeenCalledTimes(1);
});
