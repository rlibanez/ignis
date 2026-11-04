import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
const {sessionContext,matchesSession,recentlyAuthenticated}=createRequire(import.meta.url)('./session');
const session={id:'s',user:{id:'u',role:'user',authVersion:1},authenticatedAt:100};
it('captures identity without retaining the mutable session or its secrets',()=>{
  const value={...session,user:{...session.user},token:'secret'};
  const context=sessionContext(value);
  value.user.id='another';
  expect(context).toEqual({sessionId:'s',userId:'u',role:'user',authVersion:1});
  expect(Object.isFrozen(context)).toBe(true);
  expect(matchesSession(context,value)).toBe(false);
  expect(matchesSession(context,session)).toBe(true);
  expect(matchesSession(context,null)).toBe(false);
  expect(matchesSession(context,{...session,user:{...session.user,authVersion:2}})).toBe(false);
});
it('rejects missing identity and treats the five-minute boundary and clock reversal explicitly',()=>{
  expect(()=>sessionContext(null)).toThrow();
  expect(()=>sessionContext({...session,user:{...session.user,authVersion:0}})).toThrow();
  expect(recentlyAuthenticated(session,99)).toBe(false);
  expect(recentlyAuthenticated(session,300099)).toBe(true);
  expect(recentlyAuthenticated(session,300100)).toBe(false);
  expect(recentlyAuthenticated({},100)).toBe(false);
});
