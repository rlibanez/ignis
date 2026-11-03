import {it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./web/events.js',import.meta.url),'utf8');
async function fixture(pathname="/account",initialStatus=200,control={}){
 const handlers={},docHandlers={},timers=[],delays=[],messages=[],sockets=[],replaced=[];let status=initialStatus;
 class Socket{
   constructor(url){this.url=url;sockets.push(this);}
   close(){this.closed=true;this.onclose?.();}
 }
 const window={addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),dispatchEvent:event=>{messages.push(event.detail);for(const fn of handlers[event.type]||[])fn(event);}};
 const document={visibilityState:'visible',addEventListener:(name,fn)=>docHandlers[name]=fn};
 const location={protocol:'https:',host:'example.test',pathname,replace:value=>replaced.push(value)};
 const fetch=async()=>{const response={status,ok:status===200,json:async()=>control.payload??({sessionId:'session'})};if(control.wait)await control.wait();return response;};
 vm.runInNewContext(source,{window,document,location,WebSocket:Socket,fetch,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},setTimeout:(fn,delay)=>{delays.push(delay);timers.push(fn);return timers.length;},clearTimeout:()=>{}});
 await new Promise(resolve=>setTimeout(resolve,0));
 return {window,document,sockets,messages,handlers,docHandlers,timers,delays,replaced,status:value=>status=value};
}
it('opens an account-only socket and resynchronizes on every connection',async()=>{
 const f=await fixture();expect(f.sockets).toHaveLength(1);expect(f.sockets[0].url).toBe('wss://example.test/ws?events=1&context=session');
 f.sockets[0].onopen();expect(f.messages[0]).toEqual({account:true,shares:true,vaults:true,reconnected:true});
 f.sockets[0].onmessage({data:JSON.stringify({type:'ignis-state',shares:true,path:'must-not-propagate'})});expect(f.messages[1]).toEqual({account:false,shares:true,vaults:false});
});
it('resynchronizes after returning from mobile background and stops on confirmed revocation',async()=>{
 const f=await fixture();f.document.visibilityState='hidden';f.docHandlers.visibilitychange();expect(f.sockets).toHaveLength(1);
 f.document.visibilityState='visible';f.docHandlers.visibilitychange();await new Promise(resolve=>setTimeout(resolve,0));expect(f.sockets).toHaveLength(2);
 f.status(401);f.sockets[1].onclose();f.timers.at(-1)();await new Promise(resolve=>setTimeout(resolve,0));expect(f.replaced).toEqual(['/login']);
});
it('does not sign out on network outages or reconnect after auth loss',async()=>{
 const f=await fixture();f.status(503);f.sockets[0].onclose();await new Promise(resolve=>setTimeout(resolve,0));expect(f.replaced).toEqual([]);
 for(const fn of f.handlers['ignis:auth-lost'])fn();const count=f.sockets.length;for(const fn of f.timers)fn();expect(f.sockets).toHaveLength(count);
});
it('ignores late messages from the connection replaced after background suspension',async()=>{
 const f=await fixture(),old=f.sockets[0];f.docHandlers.visibilitychange();await new Promise(resolve=>setTimeout(resolve,0));
 const count=f.messages.length;old.onmessage({data:JSON.stringify({type:'ignis-state',account:true,shares:true})});old.onclose();expect(f.messages).toHaveLength(count);expect(f.sockets).toHaveLength(2);
});

it('does not connect or redirect on the anonymous login page before authentication',async()=>{
 const f=await fixture('/login');f.handlers.pageshow[0]();f.handlers.online[0]();f.docHandlers.visibilitychange();await new Promise(resolve=>setTimeout(resolve,0));
 expect(f.sockets).toEqual([]);expect(f.replaced).toEqual([]);
 f.window.IgnisEvents.connect('session');expect(f.sockets).toHaveLength(1);
});

it('retries an initial session lookup failure without requiring a focus event',async()=>{
 const f=await fixture('/account',503);expect(f.sockets).toEqual([]);expect(f.timers).toHaveLength(1);
 f.status(200);f.timers[0]();await new Promise(resolve=>setTimeout(resolve,0));
 expect(f.sockets).toHaveLength(1);expect(f.replaced).toEqual([]);
});
it('backs off repeated rejected upgrades instead of reconnecting in a hot loop',async()=>{
 const f=await fixture();f.sockets[0].onclose();
 expect(f.sockets).toHaveLength(1);expect(f.delays[0]).toBeGreaterThanOrEqual(800);expect(f.delays[0]).toBeLessThanOrEqual(1200);
 for(let i=0;i<8;i++){
  f.timers.at(-1)();await new Promise(resolve=>setTimeout(resolve,0));f.sockets.at(-1).onclose();
 }
 expect(f.delays.at(-1)).toBeGreaterThanOrEqual(24000);expect(f.delays.at(-1)).toBeLessThanOrEqual(30000);
 expect(f.replaced).toEqual([]);
});

it('ignores an old session response after authentication has stopped',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),control={};const f=await fixture('/account',200,control);
 control.wait=()=>new Promise(r=>{release=r;entered();});f.status(401);f.handlers.online[0]();await started;
 f.window.IgnisEvents.stop();release();await new Promise(resolve=>setTimeout(resolve,0));expect(f.replaced).toEqual([]);expect(f.sockets).toHaveLength(1);
});
it('does not schedule session or sharing lookups while its connection stays healthy',async()=>{
 const f=await fixture();f.sockets[0].onopen();await new Promise(resolve=>setTimeout(resolve,0));expect(f.timers).toEqual([]);
});

it('does not treat a malformed successful response as confirmed session replacement',async()=>{
 const control={},f=await fixture('/account',200,control);control.payload={};f.handlers.online[0]();
 await new Promise(resolve=>setTimeout(resolve,0));expect(f.replaced).toEqual([]);expect(f.sockets).toHaveLength(1);
});
