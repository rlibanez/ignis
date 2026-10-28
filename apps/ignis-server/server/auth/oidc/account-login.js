const { createOidcLogin } = require("./login");
const { resolveOidcAccount } = require("./accounts");

// Trusted HTTP adapter receives a new opaque session; provider tokens never escape login.
async function createOidcAccountLogin(
  db,
  config,
  configuration,
  cookiePolicy,
  sessions,
) {
  const login = await createOidcLogin(config, configuration, cookiePolicy);
  return Object.freeze({
    begin: login.begin,
    async complete(callback, cookieHeader, { isCurrent = () => true } = {}) {
      try {
        const identity = await login.complete(callback, cookieHeader);
        if (!isCurrent()) throw new Error();
        resolveOidcAccount(db, config, identity);
        const authentication = sessions.issueForVerifiedOidcIdentity({
          issuer: identity.issuer,
          subject: identity.subject,
          authenticatedAt: Date.now(),
        });
        if (!authentication) throw new Error();
        return authentication;
      } catch {
        throw new Error("OIDC authentication failed");
      }
    },
    clear: login.clear,
  });
}
module.exports = { createOidcAccountLogin };
