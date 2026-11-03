import {it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const {createIdentity}=createRequire(import.meta.url)('./identity');
function fixture(role='user',at=0) {
  let session={id:'s',user:{id:'actor',role,authVersion:1},authenticatedAt:0},credential={password_hash:'original'};
  const store={initialized:()=>true,credentials:()=>credential,changeEmail:vi.fn(()=>({emailTrust:'unverified'})),
    createUser:vi.fn(),setUserPassword:vi.fn(),issueReset:vi.fn(),revokeSessions:vi.fn(),
    deletion:{plan:vi.fn(),remove:vi.fn()},setup:{available:()=>false}};
  const sessions={resolve:()=>session};
  const oidc={linked:()=>true,unlink:vi.fn(()=>({unlinked:true})),begin:vi.fn(async()=>({url:'https://provider'}))};
  const verifyPassword=vi.fn(async()=>true);
  const identity=createIdentity({store,sessions,getOidc:()=>oidc,config:{passwordPolicy:{}},now:()=>at,verifyPassword});
  return {identity,store,sessions,oidc,verifyPassword,setSession:value=>session=value,setCredential:value=>credential=value};
}
it('rejects direct administrative calls from a normal user without relying on HTTP',()=>{
  const f=fixture();
  for(const invoke of [()=>f.identity.createUser('token','s',{}),()=>f.identity.issueReset('token','s','target'),
    ()=>f.identity.setUserPassword('token','s',{}),()=>f.identity.revokeSessions('token','s','target'),
    ()=>f.identity.deletePlan('token','s','target'),()=>f.identity.unlinkUser('token','s','target')])
    expect(invoke).toThrow(expect.objectContaining({code:'SESSION_CHANGED'}));
  expect(f.store.createUser).not.toHaveBeenCalled();expect(f.oidc.unlink).not.toHaveBeenCalled();
});
it('checks the five-minute boundary and rejects verification or target fields on own email changes',()=>{
  const expired=fixture('admin',300000);
  expect(()=>expired.identity.issueReset('token','s','target')).toThrow();
  expect(()=>expired.identity.changeEmail('token','s',{email:'new@example.com'})).toThrow();
  expect(expired.store.changeEmail).not.toHaveBeenCalled();
  const recent=fixture('user',299999),input={email:'new@example.com',expectedEmail:null,expectedEmailTrust:'unverified'};
  expect(()=>recent.identity.changeEmail('token','s',{...input,userId:'other'})).toThrow(expect.objectContaining({code:'INVALID_EMAIL'}));
  expect(()=>recent.identity.changeEmail('token','s',{...input,emailVerified:true})).toThrow();
  recent.identity.changeEmail('token','s',input);
  expect(recent.store.changeEmail).toHaveBeenCalledWith('actor',input,expect.any(Function));
});
it.each(['session','credential'])('rejects own unlink when %s changes during password verification',async changed=>{
  const f=fixture();let release;f.verifyPassword.mockImplementation(()=>new Promise(resolve=>release=resolve));
  const pending=f.identity.unlinkOwn('token','s','password');
  if(changed==='session')f.setSession(null);else f.setCredential({password_hash:'replacement'});
  release(true);
  await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
  expect(f.oidc.unlink).not.toHaveBeenCalled();
});
it('binds unlink to the original actor even if a port returns a mutable session',async()=>{
  const f=fixture();let release;f.verifyPassword.mockImplementation(()=>new Promise(resolve=>release=resolve));
  const pending=f.identity.unlinkOwn('token','s','password');
  f.sessions.resolve().user.id='other';release(true);
  await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(f.oidc.unlink).not.toHaveBeenCalled();
});
it('rechecks the captured administrative grant after asynchronous user creation',async()=>{
  const f=fixture('admin');
  f.store.createUser.mockImplementation(async(_actor,_input,isCurrent)=>{
    await Promise.resolve();if(!isCurrent(true))throw Object.assign(new Error('revoked'),{code:'SESSION_CHANGED'});
  });
  const pending=f.identity.createUser('token','s',{login:'new'});f.setSession(null);
  await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
});
it('rejects a session revoked between capture and authorization without using a null actor',()=>{
  const f=fixture('admin'),initial=f.sessions.resolve();let reads=0;
  f.sessions.resolve=()=>++reads===1?initial:null;
  expect(()=>f.identity.createUser('token','s',{})).toThrow(expect.objectContaining({code:'SESSION_CHANGED'}));
  expect(f.store.createUser).not.toHaveBeenCalled();
});
it('rejects non-admin OIDC admin reauthentication and stale identity after provider preparation',async()=>{
  const f=fixture();
  await expect(f.identity.beginOidc('reauth','token','cookie',{sessionId:'s'})).rejects.toMatchObject({code:'REAUTH_UNAVAILABLE'});
  let release;f.oidc.begin.mockImplementation(()=>new Promise(resolve=>release=resolve));
  const pending=f.identity.beginOidc('email','token','cookie',{sessionId:'s'});f.setSession(null);
  release({url:'https://provider'});
  await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
});
