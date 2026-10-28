const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { createInitialAdminSetup } = require("./initial-admin");
const setupAssets = new Map(
  [
    ["/setup", ["text/html", "setup.html"]],
    ["/auth/setup.js", ["text/javascript", "setup.js"]],
    ["/auth/setup.css", ["text/css", "setup.css"]],
  ].map(([url, [type, file]]) => [
    url,
    { type, content: fs.readFileSync(path.join(__dirname, "web", file)) },
  ]),
);
const { openDatabase } = require("./database");
const { createSessionService } = require("./sessions");
const { createSessionCookies } = require("./session-cookies");
const { createCsrf } = require("./csrf");
const { createRequestLimits } = require("./request-limits");
const { canonicalRequestPath, permittedResource } = require("./http-policy");
const { normalizeLogin } = require("./store");

function createAuthBoundary({
  dataRoot,
  config,
  staticRoots = [],
  now = Date.now,
  sessionOptions = {},
}) {
  const cookies = createSessionCookies(config); // Validate before opening/listening.
  const publicUrl = new URL(config.publicOrigin);
  const db = openDatabase(dataRoot);
  const sessions = createSessionService(db, { ...sessionOptions, now });
  const csrf = createCsrf(config, { now });
  const limits = createRequestLimits({ now });
  const socketEntries = new Map();
  let trustProxy = () => false;
  const json = express.json({ limit: "8kb", strict: true });
  const safe = (res, status, error) => res.status(status).json({ error });
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
        [...url.searchParams.keys()].some((key) => key !== "vault") ||
        url.searchParams.getAll("vault").length !== 1
      )
        return false;
      const token = cookies.read(req.headers.cookie);
      if (
        socketEntries.size >= 256 ||
        [...socketEntries.values()].filter((entry) => entry.token === token)
          .length >= 8
      )
        return false;
      return initialized() && getSession(req)?.user.role === "admin";
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
    if (req.method === "GET" && pathname === "/api/auth/status") {
      return res.json({
        initialized: initialized(),
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
        ? res.json({ user: session.user, expiresAt: session.expiresAt })
        : safe(res, 401, "Authentication required");
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
      if (!transportAllowed(req) || !originAllowed(req))
        return safe(res, 403, "Request rejected");
      const pathname = canonicalRequestPath(req);
      if (!pathname) return safe(res, 400, "Invalid request");
      if (["GET", "HEAD"].includes(req.method) && setupAssets.has(pathname)) {
        if (!limits.publicRequest(req.ip))
          return safe(res, 429, "Too many requests");
        const asset = setupAssets.get(pathname);
        res.set(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
        if (!limits.publicRequest(req.ip))
          return safe(res, 429, "Too many requests");
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
      if (!session) return safe(res, 401, "Authentication required");
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
    db.close();
  }
  return { install, revalidate, errorHandler, wsSecurity, close, staticRoots };
}

module.exports = { createAuthBoundary };
