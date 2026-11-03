const {createRoutes:createAccessRoutes}=require('./access-routes');
const {createRoutes:createAccountRoutes}=require('./account-routes');
const {createRoutes:createUserRoutes}=require('./users-routes');
const {createRoutes:createOidcRoutes}=require('./oidc-routes');

// Exact method/path inventory; unknown authentication operations stay closed.
const definitions=Object.freeze([
  ...['status','csrf','session'].map(name=>['GET',`/api/auth/${name}`,'access']),
  ...['login','logout','setup'].map(name=>['POST',`/api/auth/${name}`,'access']),
  ['GET','/api/auth/reset-password','account'],['POST','/api/auth/reset-password','account'],
  ...['email','reauth','password','oidc/unlink'].map(name=>['POST',`/api/auth/${name}`,'account']),
  ['GET','/api/auth/users','users'],['POST','/api/auth/users','users'],
  ...['status','revoke-sessions','unlink-oidc','set-password','reset-password','delete'].map(name=>['POST',`/api/auth/users/${name}`,'users']),
  ['GET','/api/auth/oidc/callback','oidc'],
  ...['start','link','reauth'].map(name=>['POST',`/api/auth/oidc/${name}`,'oidc']),
].map(([method,path,group])=>Object.freeze({method,path,group})));

function createIdentityRouter(dependencies) {
  const {identity,cookies,rememberCookies,now,safe}=dependencies;
  const initialized=identity.initialized;
  const finishRemember=(req,res,authentication,enabled)=>{
    const grant=identity.remember(authentication,rememberCookies.read(req.headers.cookie),enabled);
    res.append('Set-Cookie',grant?rememberCookies.serialize(grant.token,grant.expiresAt,now()):rememberCookies.clear());
  };
  const ports={...dependencies,initialized,finishRemember};
  const groups={access:createAccessRoutes(ports),account:createAccountRoutes(ports),users:createUserRoutes(ports),oidc:createOidcRoutes(ports)};
  const routes=new Map(definitions.map(route=>[`${route.method} ${route.path}`,groups[route.group]]));
  return async (req,res,pathname)=>{
    const handle=routes.get(`${req.method} ${pathname}`);
    if(!handle)return safe(res,404,'Not found');
    const session=identity.currentSession(cookies.read(req.headers.cookie));
    if(session && !['/api/auth/login','/api/auth/oidc/callback','/api/auth/setup','/api/auth/reset-password'].includes(pathname))req.ignisLogUsername=session.user.login;
    return handle(req,res,pathname,session);
  };
}
module.exports = {createIdentityRouter,definitions};
