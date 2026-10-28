const { createOidcLogin } = require("./login");
const { linkOidcAccount } = require("./accounts");

// Own transaction store separates linking attempts from normal login attempts.
// HTTP integration must enforce CSRF/origin on begin and obtain tokens from cookies.
async function createManualOidcLink(
  db,
  config,
  configuration,
  cookiePolicy,
  sessions,
  { now = Date.now } = {},
) {
  const login = await createOidcLogin(config, configuration, cookiePolicy, {
    now,
    freshAuthentication: true,
  });
  const pending = new Map();
  const failure = () => new Error("OIDC account linking failed");
  function recent(token) {
    const session = sessions.resolve(token);
    if (
      !session ||
      session.authenticatedAt > now() ||
      now() - session.authenticatedAt >= 300000
    )
      throw failure();
    return session;
  }
  function purge() {
    for (const [state, entry] of pending)
      if (entry.expiresAt <= now()) pending.delete(state);
  }
  return Object.freeze({
    async begin(sessionToken, oidcCookie) {
      try {
        const before = recent(sessionToken);
        purge();
        if (pending.size >= 1000) throw failure();
        const attempt = await login.begin(oidcCookie);
        const session = recent(sessionToken);
        if (
          session.id !== before.id ||
          session.user.authVersion !== before.user.authVersion
        )
          throw failure();
        const state = new URL(attempt.url).searchParams.get("state");
        pending.set(state, {
          sessionId: session.id,
          userId: session.user.id,
          authVersion: session.user.authVersion,
          expiresAt: now() + 300000,
        });
        return attempt;
      } catch {
        throw failure();
      }
    },
    async complete(callback, oidcCookie, sessionToken) {
      try {
        purge();
        const state = new URL(callback).searchParams.get("state");
        const entry = pending.get(state);
        const session = recent(sessionToken);
        if (
          !entry ||
          entry.sessionId !== session.id ||
          entry.userId !== session.user.id ||
          entry.authVersion !== session.user.authVersion
        )
          throw failure();
        pending.delete(state);
        const identity = await login.complete(callback, oidcCookie);
        const current = recent(sessionToken);
        if (
          entry.expiresAt <= now() ||
          current.id !== entry.sessionId ||
          current.user.authVersion !== entry.authVersion
        )
          throw failure();
        // Insertion atomically revokes existing sessions via the identity trigger.
        linkOidcAccount(db, config, identity, entry.userId, entry.authVersion);
        const authentication = sessions.issueForVerifiedOidcIdentity({
          issuer: identity.issuer,
          subject: identity.subject,
          authenticatedAt: now(),
        });
        if (!authentication) throw failure();
        return { userId: entry.userId, authentication };
      } catch {
        throw failure();
      }
    },
    clear() {
      pending.clear();
      login.clear();
    },
  });
}
module.exports = { createManualOidcLink };
