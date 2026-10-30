import {it,expect,vi,afterEach} from 'vitest';
import {createRequire} from 'node:module';
const {start}=createRequire(import.meta.url)('./web/oidc-start');
afterEach(()=>vi.useRealTimers());
it('waits for cleanup before requesting a redirect and decodes its response',async()=>{
 const order=[];
 const result=await start({clear:async()=>{order.push('clear');},request:async signal=>{
  expect(signal.aborted).toBe(false);order.push('request');return {status:200,ok:true,json:async()=>({authorizationUrl:'https://id.example/authorize'})};
 }});
 expect(order).toEqual(['clear','request']);expect(result.body.authorizationUrl).toBe('https://id.example/authorize');
});
it('times out stuck storage without contacting the server, even after late completion',async()=>{
 vi.useFakeTimers();let finish;const request=vi.fn();
 const pending=start({timeoutMs:15000,clear:()=>new Promise(resolve=>{finish=resolve;}),request});
 const assertion=expect(pending).rejects.toMatchObject({code:'OIDC_START_TIMEOUT',stage:'storage'});
 await vi.advanceTimersByTimeAsync(15000);await assertion;
 finish();await Promise.resolve();expect(request).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('aborts network waits and rejects a late redirect',async()=>{
 vi.useFakeTimers();let signal,finish;
 const pending=start({clear:async()=>{},request:s=>{signal=s;return new Promise(resolve=>{finish=resolve;});}});
 const assertion=expect(pending).rejects.toMatchObject({code:'OIDC_START_TIMEOUT',stage:'network'});
 await vi.advanceTimersByTimeAsync(15000);await assertion;expect(signal.aborted).toBe(true);
 const json=vi.fn();finish({json});await Promise.resolve();expect(json).not.toHaveBeenCalled();
});
it('bounds response body decoding too',async()=>{
 vi.useFakeTimers();
 const pending=start({clear:async()=>{},request:async()=>({json:()=>new Promise(()=>{})})});
 const assertion=expect(pending).rejects.toMatchObject({code:'OIDC_START_TIMEOUT',stage:'network'});
 await vi.advanceTimersByTimeAsync(15000);await assertion;
});
it('reports storage errors without leaking browser data or proceeding',async()=>{
 const request=vi.fn();
 await expect(start({clear:async()=>{throw {secret:'private storage name'};},request})).rejects.toMatchObject({message:'OIDC start failed',stage:'storage'});
 expect(request).not.toHaveBeenCalled();
});
it.each([403,429,503])('preserves HTTP %i outcomes for the UI',async status=>{
 expect(await start({clear:async()=>{},request:async()=>({status,ok:false,json:async()=>({code:'REAUTH_REQUIRED'})})})).toEqual({status,ok:false,body:{code:'REAUTH_REQUIRED'}});
});
