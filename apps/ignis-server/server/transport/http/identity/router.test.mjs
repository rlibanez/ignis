import {it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const {createIdentityRouter,definitions}=createRequire(import.meta.url)('./router');
it('registers unique method/path pairs and rejects unknown operations before resolving identity',async()=>{
  const keys=definitions.map(route=>`${route.method} ${route.path}`);
  expect(new Set(keys).size).toBe(keys.length);
  const identity={initialized:()=>true,currentSession:vi.fn()},safe=vi.fn();
  const router=createIdentityRouter({identity,cookies:{},rememberCookies:{},safe});
  for(const [method,path] of [['GET','/api/auth/unknown'],['GET','/api/auth/users/delete'],['POST','/api/auth/oidc/callback'],['PUT','/api/auth/email']])
    await router({method},{},path);
  expect(identity.currentSession).not.toHaveBeenCalled();expect(safe).toHaveBeenCalledTimes(4);
  for(const call of safe.mock.calls)expect(call.slice(1)).toEqual([404,'Not found']);
});
