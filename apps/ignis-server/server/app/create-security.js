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
  let vaultImport;
  const close = () => {
    if (closed) return;
    closed = true;
    vaultImport?.close();
    try {oidc?.clear();} finally {db.close();}
  };
  try {
    const sessions = createSessionService(db, {rememberDays:config.rememberDays,...sessionOptions,now});
    vaultImport=vaultRoot ? require('../features/vaults/adapters/vault-import').createVaultImport({db,root:vaultRoot,dataRoot,sessions,now}) : null;
    const effects={sessionsChanged:()=>{},sharingChanged:()=>{}};
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
    const vaultExport=vaults ? require('../features/vaults/adapters/vault-export').createVaultExport({vaults,dataRoot,
      flush:directory=>require('@ignis/server-core').writeCoalescer.flushPendingSubtree(directory),
    }) : null;
    const content=vaultRoot ? require('../features/content/adapters/runtime').createContentRuntime({db,root:vaultRoot,sessions}) : null;
    const shareStore=vaultRoot ? require('../features/sharing/adapters/resource-shares').createResourceSharesService(db,vaultRoot,sessions,config.sharedResourceLimits,content) : null;
    const sharesService=shareStore ? require('../features/sharing/application/sharing').createSharing({store:shareStore,sessions,
      onChanged:()=>effects.sharingChanged(),onNotificationError:()=>require('@ignis/server-core/src/logger').emit('warn','auth.state_events.failed'),
    }) : null;
    const sharingEventStore=require('../features/sharing/adapters/event-store').createSharingEventStore(db,sessions,sharesService);
    const services = {vaultExport,vaultImport,vaults,vaultStore,vaultAccess,content,sharesService,sharingEventStore,
      identity,effects,
      db, sessions, close,
      initialize() {
        if (closed) return Promise.reject(new Error('Security services are closed'));
        return initialization ||= Promise.resolve().then(async () => {
          if (closed) throw new Error("Security services are closed");
          if (vaultRoot) {
            await vaultImport.cleanup();
            await vaultExport.cleanup();
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
    const schemaVersion = db.prepare("SELECT version FROM schema_info WHERE singleton=1").get().version;
    return {...createAuthBoundary({...options,services}),schemaVersion};
  } catch (error) { close(); throw error; }
}
module.exports = {createSecurity};
