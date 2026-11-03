import {expect,it,vi} from 'vitest';
import {clearSessionStorage} from './session-transition.js';
it('preserves only the chosen language after clearing local session storage and databases',async()=>{
 const host={localStorage:{clear:vi.fn()},sessionStorage:{clear:vi.fn()},IgnisI18n:{rememberLanguage:vi.fn()},caches:{keys:async()=>['old'],delete:vi.fn()},indexedDB:{databases:async()=>[{name:'editor'}],deleteDatabase:vi.fn(()=>{const request={};queueMicrotask(()=>request.onsuccess());return request;})}};
 await clearSessionStorage(host,undefined,{forSignIn:true});
 expect(host.localStorage.clear).toHaveBeenCalledOnce();expect(host.sessionStorage.clear).toHaveBeenCalledOnce();
 expect(host.IgnisI18n.rememberLanguage).toHaveBeenCalledWith({forSignIn:true});expect(host.caches.delete).toHaveBeenCalledWith('old');expect(host.indexedDB.deleteDatabase).toHaveBeenCalledWith('editor');
});
it('does not continue deleting browser state after an aborted transition',async()=>{
 const abort=new AbortController(),host={localStorage:{clear:vi.fn()}};abort.abort();
 await expect(clearSessionStorage(host,abort.signal)).rejects.toThrow();expect(host.localStorage.clear).not.toHaveBeenCalled();
});
