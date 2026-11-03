const {openDatabase} = require('../platform/persistence/database');
const {createSessionService} = require('../features/identity/adapters/sessions.js');
const {createAuthBoundary} = require('../auth/http');
const {createIdentityStore} = require('../features/identity/adapters/identity-store');
const {createIdentity} = require('../features/identity/application/identity');

// Composition owns infrastructure; the HTTP adapter receives ready services.
function createSecurity(options) {
  const {dataRoot, vaultRoot, config, now = Date.now, sessionOptions = {},
    oidcEnv = process.env, oidcDependencies} = options;
  const db = openDatabase(dataRoot);
  let oidc, initialization, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {oidc?.clear();} finally {db.close();}
  };
  try {
    const sessions = createSessionService(db, {rememberDays:config.rememberDays,...sessionOptions,now});
    const effects={sessionsChanged:()=>{}};
    const deletion=require('../auth/user-deletion').createUserDeletionService(db,vaultRoot,{
      ...require('../vault/deletion-lifecycle').deletionLifecycle(),sessionsChanged:()=>effects.sessionsChanged(),
    });
    const store=createIdentityStore({db,config,now,deletion});
    const identity=createIdentity({store,sessions,getOidc:()=>oidc,config,now,verifyPassword:require('../features/identity/adapters/password').verifyPassword});
    const vaultAccess=vaultRoot ? require('../features/vaults/adapters/vault-access').createVaultAccessService(db,vaultRoot,sessions) : null;
    const vaultStore=vaultRoot ? require('../features/vaults/adapters/vault-store').createVaultStore(db,vaultRoot,sessions) : null;
    const vaults=vaultRoot ? require('../features/vaults/application/vaults').createVaults({
      store:vaultStore,sessions,access:vaultAccess,createView:require('../features/vaults/adapters/vault-view').createVaultView,
    }) : null;
    const services = {vaults,vaultStore,vaultAccess,
      identity,effects,
      db, sessions, close,
      sharesService:vaultRoot ? require('../auth/resource-shares').createResourceSharesService(db,vaultRoot,sessions,config.sharedResourceLimits) : null,
      initialize() {
        if (closed) return Promise.reject(new Error('Security services are closed'));
        return initialization ||= Promise.resolve().then(async () => {
          if (closed) throw new Error("Security services are closed");
          if (vaultRoot) {
            require("../features/vaults/adapters/vault-creation.js").quarantinePendingVaults(db);
            await require("../features/vaults/adapters/vault-deletion.js").purgeRetiredVaults(db,vaultRoot);
          }
          if (closed) throw new Error('Security services are closed');
          const provider = await require('../features/identity/adapters/oidc/runtime.js').createOidcRuntime(db,config,sessions,oidcEnv,oidcDependencies);
          if (closed) { provider?.clear(); throw new Error('Security services are closed'); }
          oidc = provider;
          return provider;
        });
      },
    };
    return createAuthBoundary({...options,services});
  } catch (error) { close(); throw error; }
}
module.exports = {createSecurity};
