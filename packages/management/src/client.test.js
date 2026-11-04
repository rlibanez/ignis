import {afterEach,expect,it,vi} from "vitest";
import {createManagementClient,createComponentScope} from "./client.js";
afterEach(()=>vi.unstubAllGlobals());

it("does not issue a request after its host closes",async()=>{
  const abort=new AbortController(),request=vi.fn();abort.abort();
  const fetch=createManagementClient({signal:abort.signal,request});
  await expect(fetch("/api/shares")).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
it("rejects a response which arrives after closing even if fetch ignores cancellation",async()=>{
  const abort=new AbortController();let complete;
  const fetch=createManagementClient({signal:abort.signal,request:()=>new Promise(resolve=>{complete=resolve;})});
  const pending=fetch("/api/shares");abort.abort();complete(new Response('{}'));
  await expect(pending).rejects.toThrow();
});
it("also fences a slow JSON body and cloned responses",async()=>{
  const abort=new AbortController();let complete;
  const response={ok:true,status:200,headers:new Headers(),json:()=>new Promise(resolve=>{complete=resolve;})};
  response.clone=()=>response;
  const fetch=createManagementClient({signal:abort.signal,request:async()=>response});
  const result=await fetch('/api/auth/users');const pending=result.clone().json();
  abort.abort();complete({users:[{login:'private'}]});await expect(pending).rejects.toThrow();
});
it("rechecks the caller's identity after reading JSON",async()=>{
  const abort=new AbortController();let current=true;
  const fetch=createManagementClient({signal:abort.signal,assertContext:()=>{if(!current)throw Error('changed');},request:async()=>new Response('{}')});
  const response=await fetch('/api/shares');current=false;await expect(response.json()).rejects.toThrow('changed');
});
it("combines request and host cancellation and forces same-origin uncached requests",async()=>{
  const abort=new AbortController(),other=new AbortController();let options;
  const fetch=createManagementClient({signal:abort.signal,request:async(_,config)=>{options=config;return new Response('{}');}});
  const response=await fetch('/api/shares',{signal:other.signal});expect(await response.json()).toEqual({});
  expect(options).toMatchObject({credentials:'same-origin',cache:'no-store'});other.abort();expect(options.signal.aborted).toBe(true);
});
it("binds global listeners to the component lifetime without impersonating the document",()=>{
  const abort=new AbortController(),root={ownerDocument:{defaultView:{}}};const listener=vi.fn(),target=new EventTarget();
  const scope=createComponentScope(root,{signal:abort.signal,cleanups:[],channels:[]});
  scope.listen(target,'update',listener);target.dispatchEvent(new Event('update'));abort.abort();target.dispatchEvent(new Event('update'));
  expect(listener).toHaveBeenCalledOnce();expect(scope.root).toBe(root);expect(scope.document).toBeUndefined();
});

it("captures the reauthentication return intent before the shell removes the query",()=>{
  const location={href:'https://ignis.example/?manage=users&reauth=success'};vi.stubGlobal('location',location);
  const scope=createComponentScope({ownerDocument:{defaultView:{}}},{signal:new AbortController().signal,cleanups:[],channels:[]});
  location.href='https://ignis.example/';
  expect(new URL(scope.returnUrl).searchParams.get('reauth')).toBe('success');expect(scope.location).toBe(location);
});
