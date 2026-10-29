const { dataRoutePolicy } = require("./route-manifest");
// New upstream APIs remain closed until explicitly reviewed.
function memberResource(method, pathname) {
  const verb = method === "HEAD" ? "GET" : method;
  const route = dataRoutePolicy(verb, pathname);
  if (route) return route.currentAccess === "owner";
  return !pathname.startsWith("/api/") && verb === "GET";
}
module.exports = { memberResource };
