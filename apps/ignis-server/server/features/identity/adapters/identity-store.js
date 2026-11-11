const {randomUUID} = require('node:crypto');
const users = require('./users');
const passwords = require('./change-password');
const resets = require('./password-reset');
const {createInitialAdminSetup} = require('./initial-admin');
const {changeOwnEmail} = require('./email');

// Storage-facing operations retain transaction-time checks and database invariants.
// Neither Express nor a browser controller may receive this adapter or its DB.
function createIdentityStore({db,config,now,deletion}) {
  function initialized() {
    const marked=!!db.prepare('SELECT 1 FROM bootstrap_state').get();
    const count=db.prepare('SELECT count(*) n FROM users').get().n;
    const admins=db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND status='active'").get().n;
    if ((!marked && count) || (marked && !admins)) throw new Error('Invalid initialization state');
    return marked;
  }
  const setup=createInitialAdminSetup(db,{keyDigest:config.initialAdminKeyDigest,passwordPolicy:config.passwordPolicy,initialized});
  const credentials=id=>db.prepare('SELECT password_hash FROM local_credentials WHERE user_id=?').get(id);
  const status=id=>db.prepare('SELECT status,role,email,email_trust,password_change_required,community_plugins_allowed FROM users WHERE id=?').get(id);
  return Object.freeze({
    initialized,setup,credentials,status,
    username:id=>db.prepare('SELECT login FROM users WHERE id=?').get(id)?.login,
    account:id=>({...db.prepare('SELECT email,email_trust AS emailTrust FROM users WHERE id=?').get(id),hasLocalPassword:!!credentials(id)}),
    listUsers:actor=>users.listUsers(db,actor).map(user=>({...user,hasLocalPassword:!!credentials(user.id),
      canSetLocalPassword:!credentials(user.id) && !!db.prepare('SELECT 1 FROM oidc_identities WHERE user_id=?').get(user.id)})),
    createUser:(actor,input,isCurrent)=>users.createLocalUser(db,actor,input.login,input.password,config.passwordPolicy,{isCurrent,
      requirePasswordChange:input.requirePasswordChange ?? false,allowCommunityPlugins:input.allowCommunityPlugins ?? false,email:input.email ?? null,emailVerified:input.emailVerified ?? false}),
    changeUser:(actor,input,isCurrent)=>users.changeUserStatus(db,actor,input.userId,input.status,input.expectedStatus,{isCurrent,
      pluginUpdate:Object.hasOwn(input,'allowCommunityPlugins')?input:undefined,
      passwordUpdate:Object.hasOwn(input,'requirePasswordChange')?input:undefined,
      emailUpdate:Object.hasOwn(input,'email')?input:undefined,roleUpdate:Object.hasOwn(input,'role')?input:undefined}),
    revokeSessions:(actor,target,isCurrent)=>users.revokeUserSessions(db,actor,target,{isCurrent}),
    setUserPassword:(actor,input,isCurrent)=>users.setInitialLocalPassword(db,actor,input.userId,input.password,config.passwordPolicy,{isCurrent}),
    issueReset:(actor,target,isCurrent)=>resets.issuePasswordReset(db,actor,target,{isCurrent,now}),
    beginReset:(login,password)=>resets.beginPasswordReset(db,login,password,{now}),
    readReset:token=>resets.readPasswordResetGrant(db,token,{now}),
    completeReset:(token,context,password)=>resets.completePasswordResetGrant(db,token,context,password,config.passwordPolicy,{now}),
    changeEmail:(actor,input,isCurrent)=>changeOwnEmail(db,actor,input.email,input.expectedEmail,input.expectedEmailTrust,isCurrent),
    changePassword:(actor,input,isCurrent)=>passwords.changePassword(db,actor,input.currentPassword,input.newPassword,config.passwordPolicy,{isCurrent}),
    setOwnPassword:(actor,password,resolveSession)=>passwords.setOwnLocalPassword(db,actor,password,config.passwordPolicy,{resolveSession,now}),
    deletion,
    recordOidcLogin:actor=>db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(),actor,'oidc-login',actor,now()),
  });
}
module.exports = {createIdentityStore};
