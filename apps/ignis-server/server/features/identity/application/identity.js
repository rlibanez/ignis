const {sessionContext,matchesSession,recentlyAuthenticated}=require('../../../../../../packages/contracts/src/session');

const fail=code=>{throw Object.assign(new Error('Identity operation rejected'),{code});};
function changes(before,after) {
  const result={};
  if(before.status!==after.status)Object.assign(result,{previousAccountStatus:before.status,accountStatus:after.status});
  if(before.role!==after.role)Object.assign(result,{previousRole:before.role,role:after.role});
  if(before.email!==after.email)result.emailChanged=true;
  if(before.email_trust!==after.email_trust)Object.assign(result,{previousEmailVerification:before.email_trust,emailVerification:after.email_trust});
  if(before.password_change_required!==after.password_change_required)Object.assign(result,{previousPasswordChangeRequired:!!before.password_change_required,passwordChangeRequired:!!after.password_change_required});
  if(before.community_plugins_allowed!==after.community_plugins_allowed)result.communityPluginsAllowed=!!after.community_plugins_allowed;
  return {...result,changed:Object.keys(result).length>0};
}

// Cases of use receive ports, not SQL or HTTP request/response objects.
function createIdentity({store,sessions,getOidc,config,now,verifyPassword}) {
  function capture(token,id,{admin=false,recent=false}={}) {
    const initial=sessions.resolve(token);
    if(!initial || initial.id!==id)return {session:null,isCurrent:()=>false};
    const context=sessionContext(initial);
    const session=Object.freeze({...initial,user:Object.freeze({...initial.user})});
    const isCurrent=(withinTransaction=false)=>{
      const current=sessions.resolve(token,{withinTransaction});
      return matchesSession(context,current) && (!admin || current.user.role==='admin') &&
        (!recent || recentlyAuthenticated(current,now()));
    };
    return {session,isCurrent};
  }
  const guard=(token,id,options)=>capture(token,id,options).isCurrent;
  function authorized(token,id,options) {
    if(!store.initialized())fail('SETUP_REQUIRED');
    const access=capture(token,id,options);
    if(!access.isCurrent())fail('SESSION_CHANGED');
    return access;
  }
  const admin=(token,id)=>authorized(token,id,{admin:true,recent:true});
  const provider=()=>getOidc() || fail('OIDC_UNAVAILABLE');
  function remember(authentication,previous,enabled) {
    sessions.forget(previous);
    if(!enabled)return null;
    const grant=sessions.remember(authentication.token);
    if(!grant)throw new Error('Persistent session unavailable');
    return grant;
  }
  return Object.freeze({
    initialized:store.initialized,
    setupAvailable:()=>store.setup.available(),
    setup:body=>store.setup.create(body),
    guard,
    currentSession:token=>sessions.resolve(token),
    oidcAvailable:()=>!!getOidc(),
    username(token,id,target) {authorized(token,id,{admin:true,recent:true});return store.username(target);},
    account(token,id) {
      const {session}=authorized(token,id);
      return {user:session.user,...store.account(session.user.id),passwordPolicy:config.passwordPolicy,
        sessionId:session.id,expiresAt:session.expiresAt,oidcLinked:!!getOidc()?.linked(session.user.id),
        recentAuthentication:recentlyAuthenticated(session,now()),
        canLinkOidc:!!getOidc() && !getOidc().linked(session.user.id) && recentlyAuthenticated(session,now())};
    },
    listUsers(token,id) {
      const {session}=authorized(token,id,{admin:true});
      return store.listUsers(session.user.id).map(user=>({...user,oidcLinked:getOidc()?!!getOidc().linked(user.id):null}));
    },
    createUser(token,id,input) {const {session,isCurrent}=admin(token,id);return store.createUser(session.user.id,input,isCurrent);},
    changeUser(token,id,input) {
      const {session,isCurrent}=admin(token,id),before=store.status(input.userId);
      const user=store.changeUser(session.user.id,input,isCurrent),after=store.status(user.id);
      return {user,signedOut:input.userId===session.user.id && !sessions.resolve(token),changes:changes(before,after)};
    },
    revokeSessions(token,id,target) {const {session,isCurrent}=admin(token,id);return store.revokeSessions(session.user.id,target,isCurrent);},
    unlinkUser(token,id,target) {const {session,isCurrent}=admin(token,id);return provider().unlink(session.user.id,target,{isCurrent});},
    setUserPassword(token,id,input) {const {session,isCurrent}=admin(token,id);return store.setUserPassword(session.user.id,input,isCurrent);},
    issueReset(token,id,target) {const {session,isCurrent}=admin(token,id);return store.issueReset(session.user.id,target,isCurrent);},
    deletePlan(token,id,target) {const {session,isCurrent}=admin(token,id);return store.deletion.plan(session.user.id,target,isCurrent);},
    deleteUser(token,id,input) {const {session,isCurrent}=admin(token,id);return store.deletion.remove(session.user.id,input,isCurrent);},
    readReset:store.readReset,
    completeReset:store.completeReset,
    changeEmail(token,id,input) {
      const {session,isCurrent}=authorized(token,id,{recent:true});
      if(!input || Object.keys(input).some(key=>!['email','expectedEmail','expectedEmailTrust'].includes(key)))fail('INVALID_EMAIL');
      const result=store.changeEmail(session.user.id,input,isCurrent);
      return {...result,signedOut:!sessions.resolve(token)};
    },
    async unlinkOwn(token,id,password) {
      const {session,isCurrent:sessionCurrent}=authorized(token,id),actor=session.user.id,credential=store.credentials(actor);
      const credentialHash=credential?.password_hash;
      if(!credentialHash || !await verifyPassword(password,credentialHash))fail('INVALID_PASSWORD');
      const isCurrent=within=>sessionCurrent(within) && store.credentials(actor)?.password_hash===credentialHash;
      if(!isCurrent())fail('SESSION_CHANGED');
      return provider().unlink(actor,actor,{isCurrent,self:true});
    },
    reauthenticate:(token,id,password)=>sessions.reauthenticateLocal(token,id,password),
    changePassword(token,id,input) {
      const {session,isCurrent}=authorized(token,id);
      if(input.currentPassword!==undefined)return store.changePassword(session.user.id,input,isCurrent);
      return store.setOwnPassword(session.user.id,input.newPassword,withinTransaction=>{
        if(!isCurrent(withinTransaction))return null;
        const current=sessions.resolve(token,{withinTransaction}),oidc=getOidc();
        return oidc?.linked(current.user.id) && oidc.passwordAuthorized(current.id,current.user.id)?current:null;
      });
    },
    async login(login,password) {
      if(!store.initialized())fail('SETUP_REQUIRED');
      const result=await sessions.loginLocal(login,password);
      if(result && !result.passwordChange)return {authentication:result};
      const reset=result?.passwordChange || store.beginReset(login,password);
      return reset?{reset}:null;
    },
    revoke:token=>sessions.revoke(token),
    forget:token=>sessions.forget(token),
    logout(token,rememberToken) {sessions.forget(rememberToken);sessions.revoke(token);},
    remembered:token=>sessions.remembered(token),
    remember,
    async beginOidc(kind,token,binding,{sessionId,rememberMe=false,clientInfo}={}) {
      if(!store.initialized())fail('OIDC_UNAVAILABLE');
      if(!['login','link','reauth','password','email'].includes(kind))fail('OIDC_UNAVAILABLE');
      const oidc=provider(),session=sessions.resolve(token);
      if(['password','email','reauth'].includes(kind) && (!session || session.id!==sessionId || !oidc.linked(session.user.id) || (kind==='reauth' && session.user.role!=='admin')))fail('REAUTH_UNAVAILABLE');
      if(kind==='link') {
        if(!session || oidc.linked(session.user.id))fail('LINK_UNAVAILABLE');
        if(!recentlyAuthenticated(session,now()))fail('REAUTH_REQUIRED');
      }
      const isCurrent=session?guard(token,session.id,{admin:kind==='reauth',recent:kind==='link'}):null;
      const result=await oidc.begin(kind,token,binding,{rememberMe:kind==='login' && rememberMe===true,clientInfo});
      if(isCurrent && !isCurrent())fail('SESSION_CHANGED');
      return result;
    },
    async completeOidc(callback,token,binding,{rememberToken}={}) {
      if(!store.initialized())fail('OIDC_UNAVAILABLE');
      const wasRemembered=sessions.remembered(token);
      const result=await provider().complete(callback,token,binding);
      sessions.revoke(token);
      const keep=result.kind==='login'?result.rememberMe===true:wasRemembered;
      const rememberGrant=remember(result.authentication,rememberToken,keep);
      store.recordOidcLogin(result.authentication.session.user.id);
      return {...result,rememberGrant};
    },
  });
}
module.exports = {createIdentity};
