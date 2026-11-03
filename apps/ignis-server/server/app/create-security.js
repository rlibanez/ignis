const {openDatabase} = require('../platform/persistence/database');
const {createSessionService} = require('../auth/sessions');
const {createAuthBoundary} = require('../auth/http');

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
    const services = {
      db, sessions, close,
      sharesService:vaultRoot ? require('../auth/resource-shares').createResourceSharesService(db,vaultRoot,sessions,config.sharedResourceLimits) : null,
      vaultConfig:vaultRoot ? require('../auth/vault-config').createVaultConfigService(db,vaultRoot,sessions) : null,
      vaultAccess:vaultRoot ? require('../auth/vault-access').createVaultAccessService(db,vaultRoot,sessions) : null,
      initialize() {
        if (closed) return Promise.reject(new Error('Security services are closed'));
        return initialization ||= Promise.resolve().then(async () => {
          if (closed) throw new Error("Security services are closed");
          if (vaultRoot) {
            require('../auth/vault-creation').quarantinePendingVaults(db);
            await require('../auth/vault-deletion').purgeRetiredVaults(db,vaultRoot);
          }
          if (closed) throw new Error('Security services are closed');
          const provider = await require('../auth/oidc/runtime').createOidcRuntime(db,config,sessions,oidcEnv,oidcDependencies);
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
