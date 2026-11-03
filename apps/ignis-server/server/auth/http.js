const {sessionContext,matchesSession} = require('../../../../packages/contracts/src/session');
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const setupAssets = new Map(
  [
    ["/share-target", ["text/html", "share-target.html"]],
    ["/auth/resource-tree.js", ["text/javascript", "resource-tree.js"]],
    ["/auth/resource-tree.css", ["text/css", "resource-tree.css"]],
    ["/auth/share-target.js", ["text/javascript", "share-target.js"]],
    ["/auth/share-target.css", ["text/css", "share-target.css"]],
    ["/auth/share-store.js", ["text/javascript", "share-store.js"]],
    ["/share-worker.js", ["text/javascript", "share-worker.js"]],
    ["/manifest.webmanifest", ["application/manifest+json", "manifest.webmanifest"]],
    ["/pwa/icon-192.svg", ["image/svg+xml", "icon-192.svg"]],
    ["/pwa/icon-maskable.svg", ["image/svg+xml", "icon-maskable.svg"]],
    ["/auth/i18n.js", ["text/javascript", "i18n.js"]],
    ["/auth/pwa.js", ["text/javascript", "pwa.js"]],
    ["/setup", ["text/html", "setup.html"]],
    ["/reset-password", ["text/html", "reset-password.html"]],
    ["/auth/reset-password.js", ["text/javascript", "reset-password.js"]],
    ["/login", ["text/html", "login.html"]],
    ["/auth/components.css", ["text/css", "components.css"]],
    ["/auth/password-visibility.js", ["text/javascript", "password-visibility.js"]],
    ["/auth/login.js", ["text/javascript", "login.js"]],
    ["/auth/oidc-start.js", ["text/javascript", "oidc-start.js"]],
    ["/auth/account.css", ["text/css", "account.css"]],
    ["/auth/events.js", ["text/javascript", "events.js"]],
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
setupAssets.set("/pwa/icon-512.png", {type:"image/png",content:fs.readFileSync(path.join(__dirname,"../../../../images/ignis.png"))});
const { createSessionCookies } = require("./session-cookies");
const { createCsrf } = require("./csrf");
const { createRequestLimits } = require("./request-limits");
const { canonicalRequestPath, permittedResource } = require("./http-policy");
const { normalizeLogin } = require("../features/identity/adapters/store.js");

function createAuthBoundary({
  dataRoot,
  config,
  staticRoots = [],
  now = Date.now,
  vaultRoot,
  services,
}) {
  const presentationAssets = require("./app-name").brandedAssets(setupAssets, config.appName);
  require('./incoming-share-config').configureIncomingShareAsset(presentationAssets,
    config.incomingShare || require('./incoming-share-config').readIncomingShareConfig({}));
  const cookies = createSessionCookies(config); // Validate before opening/listening.
  const rememberCookies = createSessionCookies({ ...config, purpose: "remember" });
  const resetCookies = createSessionCookies({ ...config, purpose: "reset" });
  const publicUrl = new URL(config.publicOrigin);
  const {db,sessions,sharesService,vaultConfig,vaultAccess,identity,effects} = services;
  const sharesRouter = sharesService ? require("../routes/resource-shares").createResourceSharesRouter(sharesService) : null;
  if (sharesRouter) require("../vault/lifecycle").trackRouterWork(sharesRouter);
  const pendingAuth = new Set();
  const csrf = createCsrf(config, {now,db});
  const initialize=services.initialize;
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
  const initialized=identity.initialized;
  initialized();

  function transportAllowed(req, { websocket = false } = {}) {
    if (req.headers.host?.toLowerCase() !== publicUrl.host.toLowerCase())
      return false;
    if (publicUrl.protocol === "https:") {
      return (
        !!req.socket.encrypted ||
        (trustProxy(req.socket.remoteAddress, 0) &&
          (req.headers["x-forwarded-proto"] === "https" ||
            // Traefik uses wss for TLS WebSocket upgrades. Never accept it
            // on ordinary HTTP routes or from an untrusted forwarding peer.
            (websocket && req.headers["x-forwarded-proto"] === "wss")))
      );
    }
    // Docker NAT makes even host-loopback clients appear as a bridge IP.
    // Cookie policy validates the configured development origin; Host remains exact.
    return config.allowHttpLoopback ||
      (config.allowHttpPrivateNetwork && require("./session-cookies").isPrivateLanHost(publicUrl.hostname));
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
  const socketVaults = new WeakMap();
  function socketVault(reference) {
    const directory = vaultRoot
      ? require("./vault-request").resolveVaultRequest(db, vaultRoot, { vault: reference }, null)
      : require("./vault-selection").selectVaultReference({ vault: reference }, null);
    const id = vaultRoot ? db.prepare("SELECT id FROM vaults WHERE directory=? AND status='active'").get(directory)?.id : null;
    return { directory, id: id || null };
  }
  function sameSocketVault(left, right) {
    return left.directory === right.directory && left.id === right.id;
  }
  function canReadVault(token, directory) {
    if (!vaultAccess || !directory) return false;
    const decision = vaultAccess.check(token, { reference: directory, capability: "content.list", path: "" });
    return decision.allowed;
  }
  function checkSocket(ws) {
    const entry = socketEntries.get(ws);
    if (!entry) return false;
    try {
      const session = sessions.resolve(entry.token);
      if (session && initialized()) {
        if (entry.vault) {
          try {
            if (!sameSocketVault(entry.vault, socketVault(entry.vault.id || entry.vault.directory)))
              throw new Error("Vault changed");
          } catch {
            ws.close(4002, "Vault changed");
            return false;
          }
        }
        if (!entry.events && !canReadVault(entry.token, entry.vault?.id)) { ws.terminate(); return false; }
        return true;
      }
    } catch {
      /* Fail closed on storage errors. */
    }
    ws.terminate();
    return false;
  }
  function sweepSockets() {
    for (const ws of socketEntries.keys()) checkSocket(ws);
  }
  const stateEvents=require("./state-events").createStateEvents({
    resolve:token=>sessions.resolve(token),valid:checkSocket,entries:socketEntries,
    snapshot:token=>{
      const session=sessions.resolve(token);
      if(!session)return null;
      const user=session.user;
      return {user,shares:sharesService?.catalog(token),vaults:db.prepare("SELECT v.*,m.role AS membership FROM vaults v JOIN memberships m ON m.vault_id=v.id WHERE m.user_id=? ORDER BY v.id").all(user.id)};
    },
  });
  let contentTimer;const contentUsers=new Set();
  let stateTimer,closed=false,updateSharedWatchers=()=>{},stopSharedWatchers=()=>{};
  function scheduleStateEvents(){
    if(closed || stateTimer)return;
    stateTimer=setTimeout(()=>{
      stateTimer=null;if(closed)return;
      try{stateEvents.reconcile();updateSharedWatchers();}
      catch{require("@ignis/server-core/src/logger").emit("warn","auth.state_events.failed");sweepSockets();}
    },25);
    stateTimer.unref();
  }
  // Covers changes from the CLI too, which uses another SQLite connection.
  const identityWatch=fs.watch(path.join(dataRoot,"auth"),(_event,name)=>{
    if(!name || ["identity.sqlite","identity.sqlite-wal","identity.sqlite-journal"].includes(String(name)))scheduleStateEvents();
  });
  identityWatch.on("error",()=>{
    require("@ignis/server-core/src/logger").emit("warn","auth.state_watch.unavailable");
    sweepSockets();
  });
  const cleanup = setInterval(() => {
    try {
      sessions.purgeExpired();
    } catch {
      sweepSockets();
    }
  }, 60000);
  cleanup.unref();

  const wsSecurity = {
    accountEvents(req) { return socketVaults.get(req)?.events === true; },
    vaultId(req) { return socketVaults.get(req)?.directory; },
    verify(req) {
      if (
        !transportAllowed(req, { websocket: true }) ||
        !originAllowed(req, true) ||
        !limits.upgrade(req.socket.remoteAddress)
      )
        return false;
      const url = new URL(req.url, publicUrl.origin);
      if (
        [...url.searchParams.keys()].some(
          (key) => !["vault", "context", "events"].includes(key),
        ) ||
        (url.searchParams.has("events")
          ? url.searchParams.getAll("events").length!==1 || url.searchParams.get("events")!=="1" || url.searchParams.has("vault") || url.searchParams.getAll("context").length!==1
          : url.searchParams.getAll("vault").length !== 1) ||
        url.searchParams.getAll("context").length > 1
      )
        return false;
      const token = cookies.read(req.headers.cookie);
      if (
        socketEntries.size >= 256 ||
        [...socketEntries.values()].filter((entry) => entry.token === token && entry.events === url.searchParams.has("events"))
          .length >= 8
      )
        return false;
      const session = getSession(req);
      if (!(initialized() && session &&
          (!url.searchParams.has("context") || url.searchParams.get("context") === session.id))) return false;
      try {
        if(url.searchParams.get("events")==="1") {socketVaults.set(req,{events:true});return true;}
        const vault = socketVault(url.searchParams.get("vault"));
        if (!canReadVault(token, vault.id)) return false;
        socketVaults.set(req, vault);
        return true;
      } catch { return false; }
    },
    attach(ws, req) {
      const token = cookies.read(req.headers.cookie);
      const session = sessions.resolve(token);
      if (!session) {
        ws.terminate();
        return;
      }
      const vault = socketVaults.get(req);
      if (!vault || (!vault.events && ((!canReadVault(token, vault.id)) || !sameSocketVault(vault, socketVault(vault.id || vault.directory))))) {
        ws.close(4002, "Vault changed");
        return;
      }
      req.ignisLogUsername = session.user.login;
      req.ignisLogVaultName = vault.directory;
      const original = ws.send.bind(ws);
      socketEntries.set(ws, { token, vault:vault.events?null:vault,events:!!vault.events,window:now(),messages:0,
        stateSnapshot:stateEvents.capture(token),sendState:message=>original(JSON.stringify(message)) });
      ws.send = (...args) => {
        if (!checkSocket(ws)) return;
        let message;
        try {
          message = JSON.parse(String(args[0]));
        } catch {
          return;
        }
        try {
          if(vault.events)return; // Only trusted per-account invalidations use sendState.
          const permitted = (capability, path) => {
            if (!vault.id) return false;
            return vaultAccess.check(socketEntries.get(ws)?.token, { reference: vault.id, capability, path }).allowed;
          };
          const projected = require("./vault-events").projectVaultEvent(message, {
            canRead: path => permitted("content.read", path),
            canAdmin: capability => permitted(capability),
          });
          if (projected) return original(JSON.stringify(projected), ...args.slice(1));
        } catch {
          ws.terminate();
        }
      };
      let timer;
      function expire() {
        try {
          if (!checkSocket(ws)) return;
          const current = sessions.resolve(socketEntries.get(ws)?.token);
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
      // Reuse heartbeat acknowledgements as a reconciliation fallback if an
      // operating-system file notification was lost. No session polling loop.
      ws.on("pong",scheduleStateEvents);
      scheduleStateEvents();
      ws.once("close", () => {
        clearTimeout(timer);
        socketEntries.delete(ws);scheduleStateEvents();
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
      if(socketEntries.get(ws)?.events)return false;
      return (
        ["subscribe-channel", "unsubscribe-channel"].includes(message.type) &&
        (message.channel === "metadata" || (message.channel === "plugin:headless-sync" && sessions.resolve(socketEntries.get(ws).token)?.user.role === "admin"))
      );
    },
  };


  effects.sessionsChanged=sweepSockets;
  const authEndpoint=require("../transport/http/identity/router").createIdentityRouter({
    identity,config,csrf,limits,cookies,rememberCookies,resetCookies,safe,originAllowed,now,normalizeLogin,sweepSockets,
    rebindSession(previous,next) {for(const entry of socketEntries.values())if(entry.token===previous)entry.token=next;},
  });

  function middleware(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Frame-Options", "DENY");
    try {
      // Redirect chains retain cross-site Fetch Metadata. Allow only top-level
      // navigation to entry documents (including installed PWA launches).
      // Session, transport, API and mutation checks remain strict.
      const callback =
        req.method === "GET" &&
        req.url.split("?")[0] === "/api/auth/oidc/callback";
      const entryNavigation =
        req.method === "GET" &&
        ["/", "/index.html", "/login", "/share-target"].includes(req.url.split("?")[0]) &&
        req.headers["sec-fetch-mode"] === "navigate" &&
        req.headers["sec-fetch-dest"] === "document";
      if (!transportAllowed(req) || (!callback && !entryNavigation && !originAllowed(req)))
        return safe(res, 403, "Request rejected");
      const pathname = canonicalRequestPath(req);
      if (!pathname) return safe(res, 400, "Invalid request");
      if (!setupAssets.has(pathname) || pathname === "/login") {
        const restored=sessions.resume(rememberCookies.read(req.headers.cookie),cookies.read(req.headers.cookie));
        if(restored){
          res.append("Set-Cookie",cookies.serialize(restored.token,restored.session.expiresAt,now()));
          res.append("Set-Cookie",rememberCookies.serialize(restored.remember.token,restored.remember.expiresAt,now()));
          const other=(req.headers.cookie || "").split(";").filter(part=>part.trim().split("=")[0]!==cookies.name);
          req.headers.cookie=[...other,`${cookies.name}=${restored.token}`].join("; ");
        }
      }
      if (["GET", "HEAD"].includes(req.method) && setupAssets.has(pathname)) {
        if (!limits.staticRequest(req.ip)) {
          res.set("Retry-After", "60");
          return safe(res, 429, "Too many requests");
        }
        const asset = presentationAssets.get(pathname);
        res.set(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        // Static PWA SVGs embed the existing logo; only these images need data URLs.
        if (asset.type === "image/svg+xml") res.set("Content-Security-Policy", "default-src 'none'; img-src data:; frame-ancestors 'none'; base-uri 'none'");
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
          const operation = authEndpoint(req, res, pathname).catch((failure) => {
            safe(
              res,
              failure.code === "AUTH_BUSY" ? 429 : 503,
              "Authentication unavailable",
            );
          });
          pendingAuth.add(operation);
          void operation.then(() => pendingAuth.delete(operation),() => pendingAuth.delete(operation));
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
      req.ignisLogUsername = session.user.login;
      if (
        req.headers["x-ignis-context"] &&
        req.headers["x-ignis-context"] !== session.id
      )
        return res
          .status(409)
          .json({ error: "Session changed", code: "AUTH_CONTEXT_CHANGED" });
      if (["/api/shares", "/api/shares/content"].includes(pathname)) {
        if (!sharesRouter || !["GET","POST"].includes(req.method)) return safe(res,404,"Not found");
        if ((pathname === "/api/shares/content" ? req.query.context : req.headers["x-ignis-context"]) !== session.id ||
            (req.method === "POST" && (!originAllowed(req,true) || !csrf.valid(req,session)))) return safe(res,403,"Request rejected");
        if (!limits.sharedResourceReads(session.user.id)) {res.set("Retry-After","60");return safe(res,429,"Too many requests");}
        if(pathname === "/api/shares/content" && req.method !== "GET") return safe(res,404,"Not found");
        req.ignisLogUsername = session.user.login;
        req.shareOperationAllowed = read => read || limits.sharedResources(session.user.id);
        req.shareToken = cookies.read(req.headers.cookie);
        return sharesRouter(req,res,()=>safe(res,404,"Not found"));
      }
      if (session.user.role !== "admin" && !require("./member-routes").memberResource(req.method, pathname))
        return safe(res, 403, "Administrator access required");
      if (!permittedResource(req.method, pathname, staticRoots))
        return safe(res, 404, "Not found");
      if (
        !["GET", "HEAD"].includes(req.method) &&
        (!originAllowed(req, true) || !csrf.valid(req, session))
      ) {
        return safe(res, 403, "Request rejected");
      }
      if (pathname === "/api/proxy" && session.user.role === "user" && !limits.publicRequest(req.ip))
        return safe(res, 429, "Too many network requests");
      if (["/api/vault/members", "/api/vault/transfer-ownership", "/api/vault/rename", "/api/vault/remove"].includes(pathname) && !limits.vaultMembers(session.user.id))
        return safe(res, 429, "Too many access requests; try again in a minute.");
      if (pathname === "/api/vault/create" && !limits.vaultCreation(session.user.id))
        return safe(res,429,"Too many vault creation requests; try again in a minute.");
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
      if (!initialized() || (current.user.role !== "admin" && !require("./member-routes").memberResource(req.method, canonicalRequestPath(req))))
        return safe(res, 403, "Administrator access required");
      const pathname = canonicalRequestPath(req);
      if (!vaultRoot || ["/api/vault/rename", "/api/vault/remove"].includes(pathname)) {
        try { require("./vault-selection").selectVaultReference(req.query, req.body); }
        catch { return safe(res, 400, "Invalid or conflicting vault selection"); }
      }
      if (current.user.role !== "admin" && !vaultRoot) return safe(res, 403, "Vault access unavailable");
      if (vaultRoot) {
        if (pathname?.startsWith("/vault-files/") &&
            !canReadVault(cookies.read(req.headers.cookie), pathname.split("/")[2])) return safe(res, 404, "Vault unavailable");
        if (pathname?.startsWith("/api/fs/") || pathname === "/api/bootstrap" ||
            ["/api/vault/info", "/api/vault/refresh"].includes(pathname)) {
          try {
            const directory = require("./vault-request").resolveVaultRequest(db, vaultRoot, req.query, req.body);
            if ((directory !== null ? !canReadVault(cookies.read(req.headers.cookie), directory) : pathname !== "/api/vault/info"))
              return safe(res, 404, "Vault unavailable");
            if (directory !== null) {
              req.query.vault = directory;
              if (req.body && Object.hasOwn(req.body, "vault")) req.body.vault = directory;
            }
          } catch (error) {
            return safe(res, error.code === "INVALID_VAULT_SELECTION" ? 400 : 404,
              error.code === "INVALID_VAULT_SELECTION" ? "Invalid or conflicting vault selection" : "Vault unavailable");
          }
        }
        if (pathname === "/api/vault-config") {
          let reference;
          try { reference = require("./vault-selection").selectVaultReference(req.query, req.body); }
          catch { return safe(res, 400, "Invalid vault selection"); }
          if (!canReadVault(cookies.read(req.headers.cookie), reference)) return safe(res, 404, "Vault unavailable");
        }
        const pluginToggle = /^\/api\/plugins\/[^/]+\/(enable|disable)$/.test(pathname);
        const syncVault = /^\/api\/ext\/headless-sync\/(setup|config|start|stop|unlink|logs)$/.test(pathname);
        if (pluginToggle || syncVault) {
          const field = syncVault ? "vaultId" : "vault";
          try {
            const directory = require("./vault-request").resolvePluginVaultRequest(db, vaultRoot, req.query, req.body, field);
            const capability = syncVault && pathname.endsWith("/logs") ? "content.list" : "vault.refresh";
            if (!vaultAccess.check(cookies.read(req.headers.cookie), { reference: directory, capability, path: "" }).allowed)
              return safe(res, 404, "Vault unavailable");
            req.query[field] = directory;
            if (req.body) req.body[field] = directory;
          } catch (error) {
            if (!["INVALID_VAULT_SELECTION", "VAULT_UNAVAILABLE"].includes(error.code)) throw error;
            return safe(res, error.code === "INVALID_VAULT_SELECTION" ? 400 : 404,
              error.code === "INVALID_VAULT_SELECTION" ? "Invalid or conflicting vault selection" : "Vault unavailable");
          }
        }
        if (pathname === "/api/vault/refresh" && !vaultAccess.check(cookies.read(req.headers.cookie), {
          reference: req.query.vault || req.body?.vault, capability: "vault.refresh", path: "",
        }).allowed) return safe(res, 404, "Vault unavailable");
        const fileChecks = new Map();
        req.authorizeVaultFile = (directory, capability, relativePath) => {
          const identity = db.prepare("SELECT id FROM vaults WHERE directory=?").get(directory);
          // No content access before registration and explicit membership.
          if (!identity) return false;
          const reference = identity.id;
          const check = () => {
            const decision = vaultAccess.check(cookies.read(req.headers.cookie), {
              reference, capability, path: relativePath,
            });
            return decision.allowed && decision.sessionId === current.id;
          };
          if (!check()) return false;
          if (!fileChecks.has(reference)) fileChecks.set(reference, new Map());
          fileChecks.get(reference).set(JSON.stringify([capability, relativePath]), { capability, path: relativePath });
          req.revalidateVaultFile = () => [...fileChecks].every(([id, operations]) => {
            const decision = vaultAccess.checkMany(cookies.read(req.headers.cookie), id, [...operations.values()]);
            return decision.allowed && decision.sessionId === current.id;
          });
          return true;
        };
        req.renameVaultResource = (directory,oldPath,newPath) => {
          const reference=db.prepare("SELECT id FROM vaults WHERE directory=? AND status='active'").get(directory)?.id;
          return sharesService.renameOriginal(cookies.read(req.headers.cookie),reference,oldPath,newPath);
        };
        req.vaultConfiguration = (operation, input) => {
          const reference = require("./vault-selection").selectVaultReference(req.query, req.body);
          if (!reference) throw Object.assign(new Error("Configuration unavailable"), {code:"INVALID_VAULT_SELECTION"});
          const token = cookies.read(req.headers.cookie);
          if (!canReadVault(token, reference)) throw new Error("Configuration unavailable");
          const result = vaultConfig[operation](token, { reference, path: input.path,
            content: input.content, expectedRevision: input.expectedRevision });
          // Preserve a response-time authorization check as well as the service check.
          req.revalidateVaultFile = () => {
            try { vaultConfig.read(token, { reference, path: input.path }); return canReadVault(token, reference); }
            catch { return false; }
          };
          return result;
        };
        req.privateVaultConfiguration = directory => {
          const reference = db.prepare("SELECT id FROM vaults WHERE directory=? AND status='active'").get(directory)?.id;
          // Unregistered administrator vaults retain their existing behavior.
          if (!reference) return undefined;
          if (!req.authorizeVaultFile(directory, "content.list", ""))
            throw new Error("Configuration unavailable");
          return vaultConfig.snapshot(cookies.read(req.headers.cookie), reference);
        };
        req.writeVaultContent = (reference, relative, bytes, expectedHash) =>
          sharesService.writeOriginal(cookies.read(req.headers.cookie), reference, relative, bytes, expectedHash);
        req.vaultMembers = (operation, input) => {
          const service = require("./vault-members").createVaultMembersService(db, vaultRoot, sessions);
          const token = cookies.read(req.headers.cookie);
          const result = service[operation](token, input);
          const reference = operation === "list" ? input : input.vault;
          req.ignisLogVaultName = db.prepare("SELECT directory FROM vaults WHERE id=? OR directory=?").get(reference, reference)?.directory;
          if (operation === "transfer") req.ignisLogTargetUsername = db.prepare("SELECT login FROM users WHERE id=?").get(input.userId)?.login;
          if (operation === "update") req.ignisLogTargetUsername = normalizeLogin(input.login);
          req.revalidateVaultFile = operation === "transfer"
            ? () => canReadVault(token, reference)
            : () => { service.list(token, reference); return true; };
          if (operation !== "list") sweepSockets();
          return result;
        };
        req.vaultView = require("./vault-view").createVaultView({
          administrator: current.user.role === "admin",
          authorize: directory => req.authorizeVaultFile(directory, "content.list", ""),
          uuid: directory => req.vaultUUID(directory),
          membership: directory => db.prepare("SELECT m.role FROM memberships m JOIN vaults v ON v.id=m.vault_id WHERE v.directory=? AND m.user_id=?").get(directory,current.user.id)?.role,
        });
        req.canReadVault = directory => req.authorizeVaultFile(directory, "content.list", "");
        req.vaultOwners = () => db.prepare("SELECT id,login FROM users WHERE status='active' ORDER BY login,id").all();
        req.vaultRegistrationOptions = () => require("./vault-registration").registrationOptions(db, vaultRoot);
        req.registerExistingVault = (directory, ownerId, expectedIdentity) => require("./vault-registration").registerExistingVault(db, vaultRoot, directory, ownerId, {
          actorId: current.user.id, expectedIdentity,
          isCurrent: withinTransaction => {
            const session = sessions.resolve(cookies.read(req.headers.cookie), { withinTransaction });
            return session?.id === current.id && session.user.role === "admin";
          },
        });
        req.vaultUUID = directory => db.prepare("SELECT id FROM vaults WHERE directory=? AND status='active'").get(directory)?.id;
        if (["/api/vault/rename", "/api/vault/remove"].includes(pathname)) {
          const reference = require("./vault-selection").selectVaultReference(req.query, req.body);
          const registered=db.prepare("SELECT id FROM vaults WHERE id=? OR directory=?").get(reference,reference);
          if(registered && !db.prepare("SELECT 1 FROM memberships WHERE vault_id=? AND user_id=? AND role='owner'").get(registered.id,current.user.id))
            return safe(res,404,"Vault unavailable");
          if (!db.prepare("SELECT 1 FROM vaults WHERE id=? OR directory=?").get(reference, reference) &&
              !db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=?").get(reference))
            return safe(res, 409, "Register this vault before renaming or deleting it");
        }
        if (pathname === "/api/vault/remove") {
          const reference = require("./vault-selection").selectVaultReference(req.query, req.body);
          if (db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=? AND state!='pending'").get(reference))
            return safe(res, 410, "Vault already removed");
          if (db.prepare("SELECT 1 FROM vaults WHERE id=? OR directory=?").get(reference, reference)) {
            req.deleteRegisteredVault = lifecycle => require("./vault-deletion").deleteRegisteredVault(db, vaultRoot, current.user.id, reference, {
              ...lifecycle,
              isCurrent: withinTransaction => {
                const session = sessions.resolve(cookies.read(req.headers.cookie), { withinTransaction });
                return session?.id === current.id && session.user.id === current.user.id;
              },
            });
          }
        }
        if (pathname === "/api/vault/rename") {
          const reference = require("./vault-selection").selectVaultReference(req.query, req.body);
          if (db.prepare("SELECT 1 FROM vaults WHERE id=? OR directory=?").get(reference, reference)) {
            req.renameRegisteredVault = (name, lifecycle) => require("./vault-rename").renameRegisteredVault(db, vaultRoot, current.user.id, reference, name, {
              ...lifecycle,
              isCurrent: withinTransaction => {
                const session = sessions.resolve(cookies.read(req.headers.cookie), { withinTransaction });
                return session?.id === current.id && session.user.id === current.user.id;
              },
            });
          }
        }
        req.createRegisteredVault = name => require("./vault-creation").createRegisteredVault(db, vaultRoot, current.user.id, name, {
          isCurrent: withinTransaction => {
            const session = sessions.resolve(cookies.read(req.headers.cookie), { withinTransaction });
            return session?.id === current.id && session.user.id === current.user.id;
          },
        });
      }
      req.auth = current;
      req.context = sessionContext(current);
      const context = req.context;
      // A download may outlive its session. Do not emit further chunks after revocation.
      for (const method of ["write", "end"]) {
        const original = res[method].bind(res);
        res[method] = (...args) => {
          try {
            const active = getSession(req);
            if (
              matchesSession(context,active) &&
              (active.user.role === "admin" || require("./member-routes").memberResource(req.method, pathname)) &&
              initialized() &&
              (!req.revalidateVaultFile || req.revalidateVaultFile())
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
    app.use(require("@ignis/server-core/src/logger").httpMiddleware);
    app.use((req,res,next)=>{
      res.once("finish",()=>{
        if(res.statusCode<400 && !["GET","HEAD","OPTIONS"].includes(req.method) &&
          !["shares.mounts","shares.browse","shares.read","shares.validateGrant"].includes(req.ignisLogOperation))scheduleStateEvents();
      });
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
    if (closed) return;
    closed=true;clearTimeout(stateTimer);clearTimeout(contentTimer);contentUsers.clear();identityWatch.close();stopSharedWatchers();
    clearInterval(cleanup);
    for (const ws of socketEntries.keys()) ws.terminate();
    effects.sessionsChanged=()=>{};
    services.close();
  }
  return {
    drain: () => Promise.all(pendingAuth),
    initialize,
    install,
    revalidate,
    errorHandler,
    wsSecurity,
    observeSharedSources(watcher,getVaultPath){
      const watched=new Map();
      updateSharedWatchers=()=>{
        const users=new Set([...socketEntries.values()].filter(e=>e.events).map(e=>sessions.resolve(e.token)?.user.id).filter(Boolean));
        const wanted=new Set();
        for(const row of db.prepare(`SELECT DISTINCT v.directory,g.user_id FROM shared_resources r
          JOIN vaults v ON v.id=r.vault_id JOIN resource_grants g ON g.resource_id=r.id WHERE v.status='active'`).all())
          if(users.has(row.user_id))wanted.add(row.directory);
        for(const [directory,listener] of watched)if(!wanted.has(directory)){watcher.removeListener(directory,listener);watched.delete(directory);}
        for(const directory of wanted)if(!watched.has(directory)){
          const root=getVaultPath(directory);if(!root)continue;
          const listener=()=>{};watcher.startWatching(directory,root);watcher.addListener(directory,listener);watched.set(directory,listener);
        }
      };
      const rebuilt=directory=>{if(watched.delete(directory))scheduleStateEvents();};
      watcher.onWatcherRebuild(rebuilt);
      stopSharedWatchers=()=>{watcher.offWatcherRebuild(rebuilt);for(const [directory,listener] of watched)watcher.removeListener(directory,listener);watched.clear();};
    },
    sharedContentChanged(directory,event){
      if(closed)return;
      if(!event?.path || event.path.split("/").some(part=>part.startsWith(".")))return;
      const users=new Set();
      for(const row of db.prepare(`SELECT r.path,m.user_id AS owner_id,g.user_id FROM shared_resources r
        JOIN vaults v ON v.id=r.vault_id JOIN memberships m ON m.vault_id=v.id AND m.role='owner' LEFT JOIN resource_grants g ON g.resource_id=r.id WHERE v.directory=?`).all(directory)){
        if(event.path===row.path || event.path.startsWith(row.path+"/") || row.path.startsWith(event.path+"/")){
          users.add(row.owner_id);if(row.user_id)users.add(row.user_id);
        }
      }
      for(const user of users)contentUsers.add(user);
      if(!contentUsers.size || contentTimer)return;
      contentTimer=setTimeout(()=>{contentTimer=null;const pending=new Set(contentUsers);contentUsers.clear();if(!closed)stateEvents.sharedContent(pending);},50);
      contentTimer.unref();
    },
    resolveVaultDirectory: reference => require("./vault-request").resolveVaultRequest(db, vaultRoot, { vault: reference }, null),
    close,
    staticRoots,
    vaultDirectoryAvailable: directory => require("./vault-creation").directoryAvailable(db, directory, vaultRoot),
  };
}

module.exports = { createAuthBoundary };
