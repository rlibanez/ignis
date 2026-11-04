import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./web/login.js',import.meta.url),'utf8');
async function mount({oidcAvailable=true,session=null,intent='',initialized=true}={}){
 const submit={disabled:false},oidc={hidden:true,addEventListener:vi.fn()};
 const form={hidden:true,elements:{login:{value:''},password:{value:''}},
  querySelector:()=>submit,addEventListener:vi.fn()};
 const status={textContent:''};
 const nodes={'login-form':form,status,'oidc-sign-in':oidc,'login-error':{}};
 const location={href:'https://ignis.example/login'+intent,replace:vi.fn()};
 const fetch=vi.fn(async path=>path==='/api/auth/status'
  ? {ok:true,status:200,json:async()=>({initialized,oidcAvailable,oidcButtonText:'Authentik'})}
  : {ok:!!session,status:session?200:401,json:async()=>session});
 vm.runInNewContext(source,{document:{getElementById:id=>nodes[id],querySelectorAll:()=>[],querySelector:()=>({})},
  window:{addEventListener:vi.fn()},location,fetch,URL,
  sessionStorage:{getItem:()=>null,removeItem:vi.fn()}});
 await vi.waitFor(()=>expect(initialized?fetch.mock.calls.length:location.replace.mock.calls.length).toBe(initialized?2:1));
 // Drain the final session response and rendering continuation.
 await Promise.resolve();await Promise.resolve();
 return {form,oidc,location};
}
it.each([true,false])('shows local credentials with OIDC available=%s',async oidcAvailable=>{
 const {form,oidc,location}=await mount({oidcAvailable});
 expect(form.hidden).toBe(false);expect(oidc.hidden).toBe(!oidcAvailable);
 expect(location.replace).not.toHaveBeenCalled();
});
it('shows credentials for an administrator reauthenticating with a local password',async()=>{
 const {form,location}=await mount({session:{sessionId:'context',user:{id:'admin-id',login:'admin',role:'admin'}},intent:'?reauth=users'});
 expect(form.hidden).toBe(false);expect(form.elements.login.value).toBe('admin');
 expect(location.replace).not.toHaveBeenCalled();
});
it('redirects authenticated users instead of showing a new login',async()=>{
 const {form,location}=await mount({session:{sessionId:'context',user:{id:'admin-id',login:'admin'}}});
 expect(location.replace).toHaveBeenCalledWith('/');expect(form.hidden).toBe(true);
});
it('redirects an uninitialized installation to setup',async()=>{
 const {form,location}=await mount({initialized:false});
 expect(location.replace).toHaveBeenCalledWith('/setup');expect(form.hidden).toBe(true);
});
