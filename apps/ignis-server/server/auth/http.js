const {sessionContext,matchesSession} = require('../../../../packages/contracts/src/session');
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
// A fixed public asset manifest; no user-controlled paths or source-tree serving.
const sharedBrowserAssets = new Map([
  ["ui-environment.js", "ui-environment.cjs"], ["resource-tree.js", "resource-tree.cjs"], ["resource-tree.css", "resource-tree.css"],
  ["password-visibility.js", "password-visibility.cjs"], ["oidc-start.js", "oidc-start.cjs"],
]);
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
    ["/auth/password-visibility.js", ["text/javascript", "password-visibility.js"]],
    ["/auth/login.js", ["text/javascript", "login.js"]],
    ["/auth/oidc-start.js", ["text/javascript", "oidc-start.js"]],
    ["/auth/events.js", ["text/javascript", "events.js"]],
    ["/auth/client.js", ["text/javascript", "client.js"]],
    ["/auth/setup.js", ["text/javascript", "setup.js"]],
    ["/auth/entry.css", ["text/css", "entry.css"]],
    ["/auth/entry.js", ["text/javascript", "entry.js"]],
    ["/auth/ui-environment.js", ["text/javascript", "ui-environment.js"]],
  ].map(([url, [type, file]]) => [
    url,
    { type, content: fs.readFileSync(sharedBrowserAssets.has(file)
      ? path.join(__dirname, "../../../../packages/management/src", sharedBrowserAssets.get(file))
      : path.join(__dirname, "web", file)) },
  ]),
);
// The installed stylesheet is supplied by composition; API-only fixtures need no assets.
setupAssets.set("/auth/native.css", {type:"text/css",content:""});
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
  nativeCssPath,
  now = Date.now,
  vaultRoot,
  services,
}) {
  const presentationAssets = require("./app-name").brandedAssets(setupAssets, config.appName);
  if (nativeCssPath && fs.existsSync(nativeCssPath)) presentationAssets.set("/auth/native.css", {type:"text/css",content:fs.readFileSync(nativeCssPath)});
  require('./incoming-share-config').configureIncomingShareAsset(presentationAssets,
    config.incomingShare || require('./incoming-share-config').readIncomingShareConfig({}));
  const cookies = createSessionCookies(config); // Validate before opening/listening.
  const rememberCookies = createSessionCookies({ ...config, purpose: "remember" });
  const resetCookies = createSessionCookies({ ...config, purpose: "reset" });
  const publicUrl = new URL(config.publicOrigin);
  const {db,sessions,sharesService,vaultAccess,vaults,vaultStore,content,sharingEventStore,identity,effects} = services;
  const importRouter=services.vaultImport ? require('../transport/http/vault-import').createImportRouter(services.vaultImport,{refresh:()=>require('../config').refreshVaults()}) : null;
  if(importRouter)require('../vault/lifecycle').trackRouterWork(importRouter);
  const sharesRouter = sharesService ? require("../transport/http/sharing/router.js").createResourceSharesRouter(sharesService) : null;
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
    if(vaultStore){const vault=vaultStore.resolve(reference);return {directory:vault.directory,id:vault.id};}
    const directory=require('../features/vaults/application/vault-selection').selectVaultReference({vault:reference},null);
    return {directory,id:null};
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
      if (matchesSession(entry.context,session) && initialized()) {
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
  let closed=false;
  const sharingEvents=require('../features/sharing/adapters/events').createSharingEvents({dataRoot,store:sharingEventStore,sessions,entries:socketEntries,valid:checkSocket,
    failed:reason=>require('@ignis/server-core/src/logger').emit('warn',reason==='watch'?'auth.state_watch.unavailable':'auth.state_events.failed'),
  });
  const scheduleStateEvents=sharingEvents.schedule;
  effects.sharingChanged=scheduleStateEvents;
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
        !sharingEvents.available() || !transportAllowed(req, { websocket: true }) ||
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
      if (!session || !sharingEvents.available()) {
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
        context:sessionContext(session),stateSnapshot:vault.events?sharingEvents.capture(token):null,sendState:message=>original(JSON.stringify(message)) });
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
          const projected = require("../features/vaults/application/events.js").projectVaultEvent(message, {
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
        ["/", "/index.html", "/login", "/setup", "/share-target"].includes(req.url.split("?")[0]) &&
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
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self'; manifest-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
      if (["/api/vault/import/select", "/api/vault/export", "/api/vault/plugin-trust", "/api/vault/members", "/api/vault/transfer-ownership", "/api/vault/rename", "/api/vault/remove"].includes(pathname) && !limits.vaultMembers(session.user.id))
        return safe(res, 429, "Too many access requests; try again in a minute.");
      if (["/api/vault/import/review","/api/vault/import/prepare"].includes(pathname)&&!limits.sharedResources(session.user.id))return safe(res,429,"Too many access requests; try again in a minute.");
      if (["/api/vault/create","/api/vault/import/start","/api/vault/import/zip","/api/vault/import/scan","/api/vault/import/scan-zip"].includes(pathname) && !limits.vaultCreation(session.user.id))
        return safe(res,429,"Too many vault creation requests; try again in a minute.");
      // Authorized resource requests extend inactivity; session/status polling and WS do not.
      req.auth = getSession(req, true);
      if (!req.auth) return safe(res, 401, "Authentication required");
      if(pathname.startsWith('/api/vault/import/')){
        if(!importRouter)return safe(res,503,'Import unavailable');
        req.importToken=cookies.read(req.headers.cookie);
        return importRouter(req,res,next);
      }
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
        try { require("../features/vaults/application/vault-selection.js").selectVaultReference(req.query, req.body); }
        catch { return safe(res, 400, "Invalid or conflicting vault selection"); }
      }
      if (current.user.role !== "admin" && !vaultRoot) return safe(res, 403, "Vault access unavailable");
      if (vaultRoot) {
        const scope=vaults.scope(cookies.read(req.headers.cookie));
        if (pathname?.startsWith("/vault-files/") &&
            !canReadVault(cookies.read(req.headers.cookie), pathname.split("/")[2])) return safe(res, 404, "Vault unavailable");
        if (pathname?.startsWith("/api/fs/") || pathname === "/api/bootstrap" ||
            ["/api/vault/info", "/api/vault/refresh"].includes(pathname)) {
          try {
            const directory = scope.resolveRequest(req.query, req.body);
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
        const pluginToggle = /^\/api\/plugins\/[^/]+\/(enable|disable)$/.test(pathname);
        const syncVault = /^\/api\/ext\/headless-sync\/(setup|config|start|stop|unlink|logs)$/.test(pathname);
        if (pluginToggle || syncVault) {
          const field = syncVault ? "vaultId" : "vault";
          try {
            const directory = scope.resolvePluginRequest(req.query, req.body, field);
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
        function rememberOperations(decision,operations){
          if(!operations.length)return;
          const reference=decision.vaultId;
          if(!fileChecks.has(reference))fileChecks.set(reference,new Map());
          for(const operation of operations)fileChecks.get(reference).set(JSON.stringify([operation.capability,operation.path]),operation);
          req.revalidateVaultFile=()=>scope.revalidateView() && [...fileChecks].every(([id,items])=>{
            const currentDecision=vaultAccess.checkMany(cookies.read(req.headers.cookie),id,[...items.values()]);
            return currentDecision.allowed && currentDecision.sessionId===current.id;
          });
        }
        req.authorizeVaultFile=(directory,capability,relativePath)=>{
          const decision=scope.authorize(directory,capability,relativePath);
          if(!decision.allowed)return false;
          rememberOperations(decision,[{capability,path:relativePath}]);return true;
        };
        req.authorizeVaultFiles=(directory,operations)=>{
          if(!operations.length)return [];
          const decision=scope.project(directory,operations);
          if(!decision.allowed)return operations.map(()=>false);
          rememberOperations(decision,operations.filter((_,index)=>decision.permittedOperations[index]));
          return decision.permittedOperations;
        };
        req.renameVaultResource = (directory,oldPath,newPath) => {
          const reference=scope.resolve(directory).id;
          return sharesService.renameOriginal(cookies.read(req.headers.cookie),reference,oldPath,newPath);
        };
        req.appendVaultContent=(reference,relative,bytes)=>content.appendOriginal(cookies.read(req.headers.cookie),reference,relative,bytes);
        req.copyVaultContent=(reference,source,destination)=>content.copyOriginal(cookies.read(req.headers.cookie),reference,source,destination);
        req.writeVaultContent = (reference, relative, bytes, expectedHash) =>
          content.writeOriginal(cookies.read(req.headers.cookie), reference, relative, bytes, expectedHash);
        if (["/api/vault/plugin-trust", "/api/settings"].includes(pathname)) {
          req.resolveVaultPluginTrust = reference => {
            const decision = scope.authorize(reference,"plugins.trust");
            return decision.allowed ? decision.directory : null;
          };
        }
        req.vaultMembers = async (operation, input) => {
          const result=await scope.members(operation,input,require("../vault/deletion-lifecycle").deletionLifecycle());
          if(operation==='transfer')require("../config").refreshVaults();
          const details=scope.logDetails(operation,input);
          req.ignisLogVaultName=details.directory;
          if(details.username)req.ignisLogTargetUsername=normalizeLogin(details.username);
          req.revalidateVaultFile=operation==='transfer'
            ? ()=>scope.check(input.vault)
            : ()=>{scope.members('list',operation==='list'?input:input.vault);return true;};
          if(operation!=='list')sweepSockets();
          return result;
        };
        req.exportVault=(reference,configuration,signal,plugins)=>services.vaultExport.prepare(cookies.read(req.headers.cookie),reference,configuration,signal,plugins);
        req.vaultView=scope.view;
        req.canReadVault=directory=>req.authorizeVaultFile(directory,"content.list","");
        req.vaultOwners=scope.owners;
        req.vaultUUID=scope.uuid;
        if(['/api/vault/rename','/api/vault/remove'].includes(pathname)){
          const reference=require('../features/vaults/application/vault-selection').selectVaultReference(req.query,req.body);
          const state=scope.state(reference);
          if(state.registered && !scope.check(state.registered,pathname.endsWith('/remove')?'vault.delete':'vault.rename'))
            return safe(res,404,'Vault unavailable');
          if(!state.registered && !state.deletion)return safe(res,404,'Vault unavailable');
          if(pathname.endsWith('/remove')){
            if(state.deletion && state.deletion!=='pending')return safe(res,410,'Vault already removed');
            if(state.registered)req.deleteRegisteredVault=lifecycle=>scope.delete(reference,lifecycle);
          }else if(state.registered)req.renameRegisteredVault=(name,lifecycle)=>scope.rename(reference,name,lifecycle);
        }
        req.createRegisteredVault=scope.create;
        req.revalidateVaultFile ||= scope.revalidateView;
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
          !req.ignisLogOperation?.startsWith("shares."))scheduleStateEvents();
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
    closed=true;sharingEvents.close();
    clearInterval(cleanup);
    for (const ws of socketEntries.keys()) ws.terminate();
    effects.sessionsChanged=()=>{};effects.sharingChanged=()=>{};
    services.close();
  }
  return {
    drain: () => Promise.all(pendingAuth),
    initialize,
    install,
    revalidate,
    errorHandler,
    wsSecurity,
    observeSharedSources:sharingEvents.observeSources,
    sharedContentChanged:sharingEvents.contentChanged,
    resolveVaultDirectory: reference => vaultStore.resolve(reference).directory,
    close,
    staticRoots,
    vaultDirectoryAvailable: directory => {
      try { return vaultStore.resolve(directory).status==='active'; } catch { return false; }
    },
    registeredVaults: () => vaultStore.catalog(),
  };
}

module.exports = { createAuthBoundary };
