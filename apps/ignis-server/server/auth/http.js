const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { createInitialAdminSetup } = require("./initial-admin");
const setupAssets = new Map(
  [
    ["/setup", ["text/html", "setup.html"]],
    ["/login", ["text/html", "login.html"]],
    ["/account", ["text/html", "login.html"]],
    ["/admin/users", ["text/html", "users.html"]],
    ["/auth/users.js", ["text/javascript", "users.js"]],
    ["/auth/users.css", ["text/css", "users.css"]],
    ["/auth/login.js", ["text/javascript", "login.js"]],
    ["/auth/account.css", ["text/css", "account.css"]],
    ["/auth/client.js", ["text/javascript", "client.js"]],
    ["/auth/setup.js", ["text/javascript", "setup.js"]],
    ["/auth/setup.css", ["text/css", "setup.css"]],
  ].map(([url, [type, file]]) => [
    url,
    { type, content: fs.readFileSync(path.join(__dirname, "web", file)) },
  ]),
);
setupAssets.set("/favicon.png", {
  type: "image/png",
  content: fs.readFileSync(path.join(__dirname, "../../../../images/favicon.png")),
});
const { openDatabase } = require("./database");
const { createSessionService } = require("./sessions");
const { createSessionCookies } = require("./session-cookies");
const { createCsrf } = require("./csrf");
const { createRequestLimits } = require("./request-limits");
const { canonicalRequestPath, permittedResource } = require("./http-policy");
const { normalizeLogin } = require("./store");
const { createLocalUser, listUsers, changeUserStatus, revokeUserSessions } = require("./users");

function createAuthBoundary({
  dataRoot,
  config,
  staticRoots = [],
  now = Date.now,
  sessionOptions = {},
  oidcEnv = process.env,
  oidcDependencies,
}) {
  const cookies = createSessionCookies(config); // Validate before opening/listening.
  const publicUrl = new URL(config.publicOrigin);
  const db = openDatabase(dataRoot);
  const sessions = createSessionService(db, { ...sessionOptions, now });
  const csrf = createCsrf(config, { now });
  let oidc = null;
  let initialization;
  function initialize() {
    initialization ||= require("./oidc/runtime")
      .createOidcRuntime(db, config, sessions, oidcEnv, oidcDependencies)
      .then((value) => {
        oidc = value;
      });
    return initialization;
  }
  const limits = createRequestLimits({ now });
  const socketEntries = new Map();
  let trustProxy = () => false;
  const json = express.json({ limit: "8kb", strict: true });
  const safe = (res, status, error) => res.status(status).json({
    error,
    ...(status === 429 ? {
      message: res.getHeader("Retry-After") === "60"
        ? "Temporary request limit reached. Wait one minute before trying again. Avoid repeatedly reloading the page."
        : "Too many requests or authentication attempts. Access is temporarily limited. Wait before trying again; repeated attempts will not bypass this limit.",
    } : {}),
  });
  function initialized() {
    const marked = !!db.prepare("SELECT 1 FROM bootstrap_state").get();
    const users = db.prepare("SELECT count(*) n FROM users").get().n;
    const admins = db
      .prepare(
        "SELECT count(*) n FROM users WHERE role = 'admin' AND status = 'active'",
      )
      .get().n;
    if ((!marked && users) || (marked && !admins))
      throw new Error("Invalid initialization state");
    return marked;
  }
  try {
    initialized();
  } catch (error) {
    db.close();
    throw error;
  }

  const setup = createInitialAdminSetup(db, {
    keyDigest: config.initialAdminKeyDigest,
    passwordPolicy: config.passwordPolicy,
    initialized,
  });

  function transportAllowed(req) {
    if (req.headers.host?.toLowerCase() !== publicUrl.host.toLowerCase())
      return false;
    if (publicUrl.protocol === "https:") {
      return (
        !!req.socket.encrypted ||
        (trustProxy(req.socket.remoteAddress, 0) &&
          req.headers["x-forwarded-proto"] === "https")
      );
    }
    // Docker NAT makes even host-loopback clients appear as a bridge IP.
    // The explicit development exception requires a loopback public origin and loopback port binding.
    return config.allowHttpLoopback;
  }
  function originAllowed(req, required = false) {
    return (
      req.headers["sec-fetch-site"] !== "cross-site" &&
      (req.headers.origin ? req.headers.origin === publicUrl.origin : !required)
    );
  }
  function getSession(req, touch = false) {
    return sessions.resolve(cookies.read(req.headers.cookie), { touch });
  }
  function checkSocket(ws) {
    const entry = socketEntries.get(ws);
    if (!entry) return false;
    try {
      const session = sessions.resolve(entry.token);
      if (session && session.user.role === "admin" && initialized())
        return true;
    } catch {
      /* Fail closed on storage errors. */
    }
    ws.terminate();
    return false;
  }
  function sweepSockets() {
    for (const ws of socketEntries.keys()) checkSocket(ws);
  }
  const poll = setInterval(sweepSockets, 1000);
  poll.unref();
  const cleanup = setInterval(() => {
    try {
      sessions.purgeExpired();
    } catch {
      sweepSockets();
    }
  }, 60000);
  cleanup.unref();

  const wsSecurity = {
    verify(req) {
      if (
        !transportAllowed(req) ||
        !originAllowed(req, true) ||
        !limits.upgrade(req.socket.remoteAddress)
      )
        return false;
      const url = new URL(req.url, publicUrl.origin);
      if (
        [...url.searchParams.keys()].some(
          (key) => !["vault", "context"].includes(key),
        ) ||
        url.searchParams.getAll("vault").length !== 1 ||
        url.searchParams.getAll("context").length > 1
      )
        return false;
      const token = cookies.read(req.headers.cookie);
      if (
        socketEntries.size >= 256 ||
        [...socketEntries.values()].filter((entry) => entry.token === token)
          .length >= 8
      )
        return false;
      const session = getSession(req);
      return (
        initialized() &&
        session?.user.role === "admin" &&
        (!url.searchParams.has("context") ||
          url.searchParams.get("context") === session.id)
      );
    },
    attach(ws, req) {
      const token = cookies.read(req.headers.cookie);
      const session = sessions.resolve(token);
      if (!session || session.user.role !== "admin") {
        ws.terminate();
        return;
      }
      socketEntries.set(ws, { token, window: now(), messages: 0 });
      const original = ws.send.bind(ws);
      ws.send = (...args) => {
        if (!checkSocket(ws)) return;
        let message;
        try {
          message = JSON.parse(String(args[0]));
        } catch {
          return;
        }
        const allowed =
          message &&
          (message.channel === "metadata"
            ? ["revision", "replaced"].includes(message.type)
            : message.channel === "plugin:headless-sync"
              ? ["sync-log", "sync-status"].includes(message.type)
              : !message.channel &&
                [
                  "created",
                  "modified",
                  "deleted",
                  "folder-created",
                  "rename",
                  "write-giveup",
                  "virtual-plugin-enable",
                  "virtual-plugin-disable",
                ].includes(message.type));
        if (allowed) return original(...args);
      };
      let timer;
      function expire() {
        try {
          if (!checkSocket(ws)) return;
          const current = sessions.resolve(token);
          timer = setTimeout(
            expire,
            Math.max(
              1,
              Math.min(current.expiresAt, current.idleExpiresAt) - now(),
            ),
          );
          timer.unref();
        } catch {
          ws.terminate();
        }
      }
      expire();
      ws.once("close", () => {
        clearTimeout(timer);
        socketEntries.delete(ws);
      });
    },
    receive(ws) {
      if (!checkSocket(ws)) return false;
      const entry = socketEntries.get(ws);
      const at = now();
      if (at >= entry.window + 1000) {
        entry.window = at;
        entry.messages = 0;
      }
      return ++entry.messages <= 32;
    },
    message(ws, message) {
      if (
        !checkSocket(ws) ||
        !message ||
        typeof message !== "object" ||
        Array.isArray(message)
      )
        return false;
      return (
        ["subscribe-channel", "unsubscribe-channel"].includes(message.type) &&
        ["metadata", "plugin:headless-sync"].includes(message.channel)
      );
    },
  };

  async function authEndpoint(req, res, pathname) {
    const session = getSession(req);
    if (["/api/auth/users", "/api/auth/users/status", "/api/auth/users/revoke-sessions", "/api/auth/users/unlink-oidc"].includes(pathname)) {
      const changingStatus = pathname.endsWith("/status");
      const unlinkingOidc = pathname.endsWith("/unlink-oidc");
      const revokingSessions = pathname.endsWith("/revoke-sessions");
      if (!["GET", "POST"].includes(req.method) || ((changingStatus || revokingSessions || unlinkingOidc) && req.method !== "POST"))
        return safe(res, 404, "Not found");
      if (!session) return safe(res, 401, "Authentication required");
      if (!initialized() || session.user.role !== "admin")
        return safe(res, 403, "Administrator access required");
      if (req.headers["x-ignis-context"] &&
          req.headers["x-ignis-context"] !== session.id)
        return safe(res, 409, "Session changed");
      if (req.method === "GET")
        return res.json({
          users: listUsers(db, session.user.id).map((user) => ({
            ...user,
            oidcLinked: oidc ? !!oidc.linked(user.id) : null,
          })),
          oidcAvailable: !!oidc,
          passwordPolicy: config.passwordPolicy,
        });
      if (!originAllowed(req, true) || !csrf.valid(req, session))
        return safe(res, 403, "Request rejected");
      const isCurrent = (withinTransaction = false) => {
        const current = sessions.resolve(cookies.read(req.headers.cookie), {
          withinTransaction,
        });
        return current?.id === session.id &&
          current.user.role === "admin" &&
          now() >= current.authenticatedAt &&
          now() - current.authenticatedAt < 300000;
      };
      if (!isCurrent()) return res.status(403).json({
        error: "Sign in again before managing users", code: "REAUTH_REQUIRED",
      });
      if (!limits.createUser(session.user.id))
        return safe(res, 429, "Too many requests");
      const body = req.body;
      if (revokingSessions || unlinkingOidc) {
        if (!body || Array.isArray(body) || Object.keys(body).some((key) => key !== "userId") ||
            typeof body.userId !== "string" || !body.userId || body.userId.length > 64)
          return safe(res, 400, "Expected userId only");
        try {
          if (unlinkingOidc && !oidc) return safe(res, 404, "OpenID Connect unavailable");
          const result = unlinkingOidc
            ? oidc.unlink(session.user.id, body.userId, { isCurrent })
            : revokeUserSessions(db, session.user.id, body.userId, { isCurrent });
          const signedOut = body.userId === session.user.id;
          csrf.consume(req);
          if (signedOut) res.append("Set-Cookie", cookies.clear());
          sweepSockets();
          return res.json({ ...result, signedOut });
        } catch (error) {
          if (error.code === "USER_NOT_FOUND") return safe(res, 404, "User not found");
          if (error.code === "LOCAL_PASSWORD_REQUIRED")
            return res.status(400).json({ error: "A local password is required before unlinking.", code: error.code });
          if (error.code === "OIDC_NOT_LINKED")
            return res.status(409).json({ error: "Account is no longer linked. Reload the list.", code: error.code });
          throw error;
        }
      }
      if (changingStatus) {
        if (!body || Array.isArray(body) ||
            Object.keys(body).some((key) => !["userId", "status", "expectedStatus"].includes(key)) ||
            typeof body.userId !== "string" || body.userId.length > 64 ||
            !["active", "disabled"].includes(body.status) ||
            !["active", "disabled"].includes(body.expectedStatus))
          return safe(res, 400, "Invalid user status request");
        try {
          const user = changeUserStatus(
            db, session.user.id, body.userId, body.status, body.expectedStatus, { isCurrent },
          );
          csrf.consume(req);
          sweepSockets();
          return res.json({ user });
        } catch (error) {
          const messages = {
            USER_NOT_FOUND: [404, "User not found"],
            USER_STATE_CHANGED: [409, "Account changed. Reload the list and try again."],
            LAST_ADMIN: [400, "The last active administrator cannot be disabled."],
            SELF_DISABLE: [400, "You cannot disable your own account."],
          };
          if (Object.hasOwn(messages, error.code)) {
            const [status, message] = messages[error.code];
            return res.status(status).json({ error: message, code: error.code });
          }
          throw error;
        }
      }
      if (!body || Array.isArray(body) ||
          Object.keys(body).some((key) => !["login", "password"].includes(key)) ||
          typeof body.login !== "string" || typeof body.password !== "string")
        return safe(res, 400, "Expected login and password only");
      try {
        const user = await createLocalUser(
          db, session.user.id, body.login, body.password,
          config.passwordPolicy, { isCurrent },
        );
        csrf.consume(req);
        return res.status(201).json({ user });
      } catch (error) {
        if (!isCurrent()) return safe(res, 403, "Administrator session required");
        return safe(res, error.code === "AUTH_BUSY" ? 429 : 400,
          "User creation failed; check login availability and password policy");
      }
    }
    if (req.method === "GET" && pathname === "/api/auth/status") {
      return res.json({
        initialized: initialized(),
        ...(oidc && initialized() ? { oidcAvailable: true, oidcButtonText: config.oidcButtonText } : {}),
        setupAvailable: setup.available(),
        ...(setup.available() ? { passwordPolicy: config.passwordPolicy } : {}),
      });
    }
    if (req.method === "GET" && pathname === "/api/auth/csrf") {
      const token = csrf.issue(req, res, session);
      return token
        ? res.json({ csrfToken: token })
        : safe(res, 429, "Too many requests");
    }
    if (req.method === "GET" && pathname === "/api/auth/session") {
      return session
        ? res.json({
            user: session.user,
            sessionId: session.id,
            expiresAt: session.expiresAt,
            oidcLinked: !!oidc?.linked(session.user.id),
            recentAuthentication: now() >= session.authenticatedAt &&
              now() - session.authenticatedAt < 300000,
            canLinkOidc:
              !!oidc &&
              !oidc.linked(session.user.id) &&
              now() - session.authenticatedAt < 300000,
          })
        : safe(res, 401, "Authentication required");
    }
    if (pathname === "/api/auth/oidc/callback" && req.method === "GET") {
      if (!oidc || !initialized()) return safe(res, 404, "Not found");
      if (!limits.oidcCallback(req.ip))
        return safe(res, 429, "Too many requests");
      try {
        const previous = cookies.read(req.headers.cookie);
        const result = await oidc.complete(
          config.publicOrigin + req.url,
          previous,
          req.headers.cookie,
        );
        sessions.revoke(previous);
        csrf.consume(req);
        const authentication = result.authentication;
        db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
          require("node:crypto").randomUUID(),
          authentication.session.user.id,
          "oidc-login",
          authentication.session.user.id,
          now(),
        );
        res.append(
          "Set-Cookie",
          cookies.serialize(
            authentication.token,
            authentication.session.expiresAt,
            now(),
          ),
        );
        sweepSockets();
        return res.redirect(
          303,
          result.kind === "link"
            ? "/account?oidc=linked"
            : "/login?oidc=success",
        );
      } catch {
        // Never render provider errors, code, state, URLs or claims.
        return res.redirect(303, "/login?oidc=failed");
      }
    }
    if (
      pathname === "/api/auth/oidc/start" ||
      pathname === "/api/auth/oidc/link"
    ) {
      if (!oidc || !initialized() || req.method !== "POST")
        return safe(res, 404, "Not found");
      if (!originAllowed(req, true) || !csrf.valid(req, session))
        return safe(res, 403, "Request rejected");
      if (!limits.oidcStart(req.ip)) return safe(res, 429, "Too many requests");
      const kind = pathname.endsWith("/link") ? "link" : "login";
      if (kind === "link" && (!session || oidc.linked(session.user.id)))
        return safe(res, 403, "Account linking unavailable");
      if (kind === "link" && now() - session.authenticatedAt >= 300000)
        return res.status(403).json({
          error: "Sign in again before linking an account", code: "REAUTH_REQUIRED",
        });
      try {
        const result = await oidc.begin(
          kind,
          cookies.read(req.headers.cookie),
          req.headers.cookie,
        );
        csrf.consume(req);
        res.append("Set-Cookie", result.cookie);
        return res.json({ authorizationUrl: result.url });
      } catch (error) {
        if (error.code === "OIDC_UNAVAILABLE")
          return safe(res, 503, "OpenID Connect is unavailable; try again later");
        return safe(
          res,
          403,
          "OIDC request unavailable; sign in again if linking an account",
        );
      }
    }
    if (
      req.method !== "POST" ||
      !["/api/auth/login", "/api/auth/logout", "/api/auth/setup"].includes(
        pathname,
      )
    )
      return safe(res, 404, "Not found");
    if (!originAllowed(req, true) || !csrf.valid(req, session))
      return safe(res, 403, "Request rejected");
    if (pathname === "/api/auth/setup") {
      if (!limits.setup(req.ip)) {
        res.set("Retry-After", "900");
        return safe(res, 429, "Too many requests");
      }
      const result = await setup.create(req.body);
      if (result.error) return safe(res, result.status, result.error);
      csrf.consume(req);
      return res.status(201).json({ initialized: true });
    }
    if (pathname === "/api/auth/logout") {
      sessions.revoke(cookies.read(req.headers.cookie));
      csrf.consume(req);
      res.append("Set-Cookie", cookies.clear());
      sweepSockets();
      return res.status(204).end();
    }
    let login = null;
    try {
      login = normalizeLogin(req.body?.login);
    } catch {
      /* Account-independent failure. */
    }
    if (!limits.login(req.ip, login)) {
      res.set("Retry-After", "60");
      return safe(res, 429, "Too many requests");
    }
    if (!initialized()) return safe(res, 403, "Initial administrator required");
    const result = await sessions.loginLocal(login, req.body?.password);
    if (!result) return safe(res, 401, "Invalid credentials");
    // End the browser's previous identity only after successful authentication.
    sessions.revoke(cookies.read(req.headers.cookie));
    csrf.consume(req);
    res.append(
      "Set-Cookie",
      cookies.serialize(result.token, result.session.expiresAt, now()),
    );
    sweepSockets();
    return res.json({
      user: result.session.user,
      expiresAt: result.session.expiresAt,
    });
  }

  function middleware(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Frame-Options", "DENY");
    try {
      // Redirect chains retain cross-site Fetch Metadata. Allow only top-level
      // navigation to the public auth HTML; API and mutation checks remain strict.
      const callback =
        req.method === "GET" &&
        req.url.split("?")[0] === "/api/auth/oidc/callback";
      const authNavigation =
        req.method === "GET" &&
        ["/login", "/account"].includes(req.url.split("?")[0]) &&
        req.headers["sec-fetch-mode"] === "navigate" &&
        req.headers["sec-fetch-dest"] === "document";
      if (!transportAllowed(req) || (!callback && !authNavigation && !originAllowed(req)))
        return safe(res, 403, "Request rejected");
      const pathname = canonicalRequestPath(req);
      if (!pathname) return safe(res, 400, "Invalid request");
      if (["GET", "HEAD"].includes(req.method) && setupAssets.has(pathname)) {
        if (!limits.staticRequest(req.ip)) {
          res.set("Retry-After", "60");
          return safe(res, 429, "Too many requests");
        }
        const asset = setupAssets.get(pathname);
        res.set(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        return res.type(asset.type).send(asset.content);
      }
      if (
        ["GET", "HEAD"].includes(req.method) &&
        pathname === "/" &&
        !initialized()
      )
        return res.redirect(303, "/setup");
      if (pathname.startsWith("/api/auth/")) {
        const authRead = req.method === "GET" &&
          ["/api/auth/status", "/api/auth/session", "/api/auth/csrf"].includes(pathname);
        if (!(authRead ? limits.authRead(req.ip) : limits.publicRequest(req.ip))) {
          res.set("Retry-After", "60");
          return safe(res, 429, "Too many requests");
        }
        if (req.method === "POST" && !req.is("application/json"))
          return safe(res, 415, "JSON required");
        return json(req, res, (error) => {
          if (error)
            return safe(
              res,
              error.status === 413 ? 413 : 400,
              "Invalid request body",
            );
          authEndpoint(req, res, pathname).catch((failure) => {
            safe(
              res,
              failure.code === "AUTH_BUSY" ? 429 : 503,
              "Authentication unavailable",
            );
          });
        });
      }
      if (!initialized())
        return safe(res, 401, "Initial administrator required");
      const session = getSession(req);
      if (!session) {
        if (
          ["GET", "HEAD"].includes(req.method) &&
          ["/", "/index.html"].includes(pathname)
        )
          return res.redirect(303, "/login");
        return safe(res, 401, "Authentication required");
      }
      if (
        req.headers["x-ignis-context"] &&
        req.headers["x-ignis-context"] !== session.id
      )
        return res
          .status(409)
          .json({ error: "Session changed", code: "AUTH_CONTEXT_CHANGED" });
      if (session.user.role !== "admin")
        return safe(res, 403, "Administrator access required");
      if (!permittedResource(req.method, pathname, staticRoots))
        return safe(res, 404, "Not found");
      if (
        !["GET", "HEAD"].includes(req.method) &&
        (!originAllowed(req, true) || !csrf.valid(req, session))
      ) {
        return safe(res, 403, "Request rejected");
      }
      // Authorized resource requests extend inactivity; session/status polling and WS do not.
      req.auth = getSession(req, true);
      if (!req.auth) return safe(res, 401, "Authentication required");
      next();
    } catch {
      return safe(res, 503, "Authentication unavailable");
    }
  }
  // Body parsing may await a slow client. Check again immediately before routing.
  function revalidate(req, res, next) {
    try {
      const current = getSession(req);
      if (!current || current.id !== req.auth?.id)
        return safe(res, 401, "Authentication required");
      if (!initialized() || current.user.role !== "admin")
        return safe(res, 403, "Administrator access required");
      req.auth = current;
      // A download may outlive its session. Do not emit further chunks after revocation.
      for (const method of ["write", "end"]) {
        const original = res[method].bind(res);
        res[method] = (...args) => {
          try {
            const active = getSession(req);
            if (
              active?.id === current.id &&
              active.user.role === "admin" &&
              initialized()
            )
              return original(...args);
          } catch {
            /* Storage failure must not release response bytes. */
          }
          res.destroy();
          return method === "write" ? false : res;
        };
      }
      next();
    } catch {
      safe(res, 503, "Authentication unavailable");
    }
  }
  function install(app) {
    app.disable("x-powered-by");
    app.set("trust proxy", config.trustedProxies);
    trustProxy = app.get("trust proxy fn");
    app.use((req, res, next) => {
      const start = Date.now();
      // Never log URL, query, body, cookies or authorization headers (including OIDC callbacks).
      res.once("finish", () =>
        console.log(
          `[http] ${["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method) ? req.method : "OTHER"} ${res.statusCode} ${Date.now() - start}ms`,
        ),
      );
      next();
    });
    app.use(middleware);
  }
  function errorHandler(error, _req, res, _next) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    safe(
      res,
      error.status === 413 ? 413 : error.status === 400 ? 400 : 500,
      "Request failed",
    );
  }
  function close() {
    clearInterval(poll);
    clearInterval(cleanup);
    for (const ws of socketEntries.keys()) ws.terminate();
    oidc?.clear();
    db.close();
  }
  return {
    initialize,
    install,
    revalidate,
    errorHandler,
    wsSecurity,
    close,
    staticRoots,
  };
}

module.exports = { createAuthBoundary };
