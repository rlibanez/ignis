// Inventory of data APIs. This classifies surfaces; it does NOT grant vault access.
// The HTTP/WS boundary continues to require an active administrator for data.
const groups = [
  { mount: "/api/fs", source: "routes/fs.js", surface: "vault-content", routes: [
    ...["stat", "readFile", "access", "tree", "download", "download-zip"].map(name => ["GET", `/${name}`, "read"]),
    ...["writeFile", "appendFile", "mkdir", "rename", "copyFile", "utimes"].map(name => ["POST", `/${name}`, "write"]),
    ["POST", "/batch-read", "read"],
    ...["unlink", "rmdir", "rm"].map(name => ["DELETE", `/${name}`, "write"]),
  ] },
  { mount: "/api/vault", source: "routes/vault.js", surface: "vault-lifecycle", routes: [
    ["GET", "/list", "list"], ["GET", "/info", "read"],
    ["POST", "/refresh", "manage"], ["POST", "/create", "manage"],
    ["POST", "/rename", "manage"], ["DELETE", "/remove", "manage"],
    ["GET", "/owners", "read"], ["GET", "/registration", "read"], ["POST", "/register", "manage"],
  ] },
  { mount: "/api/bootstrap", source: "routes/bootstrap.js", surface: "mixed-bootstrap", routes: [["GET", "/", "read"]] },
  { mount: "/api/proxy", source: "routes/proxy/index.js", surface: "external-network", routes: [["POST", "/", "network"]] },
  { mount: "/api/version", source: "routes/version.js", surface: "instance", routes: [["GET", "/", "read"]] },
  { mount: "/api/settings", source: "routes/settings.js", surface: "instance", routes: [["GET", "/", "read"], ["POST", "/", "manage"]] },
  { mount: "/api/plugins", source: "routes/plugins.js", surface: "shared-code", routes: [
    ["GET", "/", "read"], ["POST", "/headless-sync/enable", "manage", "/:pluginId/enable"],
    ["POST", "/headless-sync/disable", "manage", "/:pluginId/disable"],
  ] },
  { mount: "/api/ext/headless-sync", source: "plugins/headless-sync/routes.js", surface: "sync", routes: [
    ...["status", "logs", "vaults", "remote-vaults"].map(name => ["GET", `/${name}`, "read"]),
    ...["login", "logout", "setup", "config", "start", "stop", "unlink", "create-remote-vault"].map(name => ["POST", `/${name}`, "manage"]),
  ] },
];
const routes = Object.freeze(groups.flatMap(group => group.routes.map(([method, suffix, operation, sourcePath]) => Object.freeze({
  method, path: group.mount + (suffix === "/" ? "" : suffix), mount: group.mount,
  source: group.source, sourcePath: sourcePath || suffix,
  surface: group.surface, operation, currentAccess: "admin",
}))));
const byRoute = new Map(routes.map(route => [`${route.method} ${route.path}`, route]));
if (byRoute.size !== routes.length) throw new Error("Duplicate route policy");
function dataRoutePolicy(method, pathname) {
  return byRoute.get(`${method === "HEAD" ? "GET" : method} ${pathname}`) || null;
}
module.exports = { routes, dataRoutePolicy };
