const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { readOidcConfig } = require("./config");
const { initializeOidcClient } = require("./discovery");
const { createOidcAccountLogin } = require("./account-login");
const { createManualOidcLink } = require("./manual-link");
function readNetworkOptions(env) {
  try {
    const parse = (name, fallback) => {
      const raw = env[name] || fallback;
      if (raw.length > 16384) throw new Error();
      return JSON.parse(raw);
    };
    const allowedOrigins = parse("IGNIS_OIDC_ALLOWED_ORIGINS", "[]");
    const privateAddresses = parse("IGNIS_OIDC_PRIVATE_ADDRESSES", "{}");
    if (
      !Array.isArray(allowedOrigins) ||
      !privateAddresses ||
      typeof privateAddresses !== "object" ||
      Array.isArray(privateAddresses)
    )
      throw new Error();
    let ca;
    const file = env.IGNIS_OIDC_CA_FILE;
    if (file) {
      if (!path.isAbsolute(file)) throw new Error();
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size < 1 || stat.size > 1048576)
          throw new Error();
        const buffer = Buffer.alloc(1048577);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (!length || length > 1048576) throw new Error();
        ca = buffer.subarray(0, length);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { allowedOrigins, privateAddresses, ca };
  } catch {
    throw new Error("Invalid OIDC network configuration");
  }
}
async function createOidcRuntime(
  db,
  cookiePolicy,
  sessions,
  env,
  dependencies,
) {
  const config = readOidcConfig(env, cookiePolicy);
  if (!config) return null;
  const network = readNetworkOptions(env);
  // Validate local policy now, without contacting the provider.
  require("./transport").createOidcTransport({
    ...network,
    origins: [new URL(config.issuer).origin, ...network.allowedOrigins],
  }, dependencies);
  let login, manual, reauth, initializing, closed = false;
  const ready = async () => {
    if (closed) throw new Error("OIDC unavailable");
    if (login) return;
    if (!initializing) {
      initializing = (async () => {
        const configuration = await initializeOidcClient(config, network, dependencies);
        const nextLogin = await createOidcAccountLogin(db, config, configuration, cookiePolicy, sessions);
        const nextManual = await createManualOidcLink(db, config, configuration, cookiePolicy, sessions);
        const nextReauth = await require("./login").createOidcLogin(config, configuration, cookiePolicy, { freshAuthentication: true });
        if (closed) {
          nextReauth.clear();
          nextLogin.clear();
          nextManual.clear();
          throw new Error("OIDC unavailable");
        }
        login = nextLogin;
        manual = nextManual;
        reauth = nextReauth;
      })().catch(() => {
        const error = new Error("OpenID Connect is unavailable; try again later");
        error.code = "OIDC_UNAVAILABLE";
        throw error;
      }).finally(() => { initializing = null; });
    }
    await initializing;
  };
  const bindingCookie = require("../session-cookies").createSessionCookies({
    ...cookiePolicy,
    purpose: "oidc",
  });
  const pending = new Map();
  const key = (state) => createHash("sha256").update(state).digest("hex");
  const purge = () => {
    for (const [id, entry] of pending)
      if (entry.until <= Date.now()) pending.delete(id);
  };
  return {
    unlink(actorId, userId, options) {
      return require("../users").unlinkUserOidc(db, actorId, userId, config.issuer, options);
    },
    linked(userId) {
      return !!db
        .prepare("SELECT 1 FROM oidc_identities WHERE user_id=? AND issuer=?")
        .get(userId, config.issuer);
    },
    async begin(kind, sessionToken, cookie) {
      purge();
      if (pending.size >= 1000 || !["login", "link", "reauth"].includes(kind))
        throw new Error("OIDC unavailable");
      const original = sessions.resolve(sessionToken);
      const sessionId = original?.id ?? null;
      if (kind === "reauth" && original?.user.role !== "admin") throw new Error("OIDC unavailable");
      await ready();
      if ((sessions.resolve(sessionToken)?.id ?? null) !== sessionId)
        throw new Error("OIDC unavailable");
      const result =
        kind === "link"
          ? await manual.begin(sessionToken, cookie)
          : kind === "reauth" ? await reauth.begin(cookie) : await login.begin(cookie);
      if (
        closed ||
        pending.size >= 1000 ||
        (sessions.resolve(sessionToken)?.id ?? null) !== sessionId
      )
        throw new Error("OIDC unavailable");
      pending.set(key(new URL(result.url).searchParams.get("state")), {
        kind,
        sessionId,
        browser: key(bindingCookie.read(result.cookie)),
        until: Date.now() + 300000,
      });
      return result;
    },
    async complete(callback, sessionToken, cookie) {
      purge();
      const params = new URL(callback).searchParams;
      if (
        params.getAll("state").length !== 1 ||
        !/^[A-Za-z0-9_-]{43}$/.test(params.get("state"))
      )
        throw new Error("OIDC authentication failed");
      const id = key(params.get("state"));
      const entry = pending.get(id);
      if (
        !entry ||
        !bindingCookie.read(cookie) ||
        entry.browser !== key(bindingCookie.read(cookie)) ||
        entry.sessionId !== (sessions.resolve(sessionToken)?.id ?? null)
      )
        throw new Error("OIDC authentication failed");
      pending.delete(id);
      if (entry.kind === "reauth") {
        const identity = await reauth.complete(callback, cookie);
        const current = sessions.resolve(sessionToken);
        const linked = db.prepare("SELECT user_id FROM oidc_identities WHERE issuer=? AND subject=?").get(identity.issuer, identity.subject);
        if (closed || entry.until <= Date.now() || !current || current.id !== entry.sessionId ||
            current.user.role !== "admin" || linked?.user_id !== current.user.id)
          throw new Error("OIDC authentication failed");
        const authentication = sessions.issueForVerifiedOidcIdentity({ issuer: identity.issuer, subject: identity.subject, authenticatedAt: Date.now() });
        if (!authentication) throw new Error("OIDC authentication failed");
        return { authentication, kind: "reauth" };
      }
      const result =
        entry.kind === "link"
          ? (await manual.complete(callback, cookie, sessionToken))
              .authentication
          : await login.complete(callback, cookie, {
              isCurrent: () =>
                entry.until > Date.now() &&
                entry.sessionId ===
                  (sessions.resolve(sessionToken)?.id ?? null),
            });
      return { authentication: result, kind: entry.kind };
    },
    clear() {
      closed = true;
      pending.clear();
      login?.clear();
      manual?.clear();
      reauth?.clear();
    },
  };
}
module.exports = { createOidcRuntime, readNetworkOptions };
