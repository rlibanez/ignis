import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parse } = require("acorn");
const { routes, dataRoutePolicy } = require("./route-manifest");
const { permittedResource } = require("./http-policy");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}
function calls(source, receiver) {
  const result = [];
  walk(parse(source, { ecmaVersion: "latest", sourceType: "script" }), node => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression" || node.callee.object.name !== receiver) return;
    const method = node.callee.computed ? node.callee.property.value : node.callee.property.name;
    // Unknown registration forms must be reviewed instead of silently skipped.
    expect(typeof method).toBe("string");
    const argument = node.arguments[0];
    if (receiver === "app" && method === "use" && node.arguments.length === 1) return;
    const paths = argument?.type === "ArrayExpression" ? argument.elements : [argument];
    for (const item of paths) {
      expect(item?.type).toBe("Literal");
      expect(typeof item.value).toBe("string");
      result.push({ method, path: item.value });
    }
  });
  return result;
}
it("classifies every router registration, including POST reads and concrete plugin restrictions", () => {
  for (const source of new Set(routes.map(route => route.source))) {
    const actual = calls(fs.readFileSync(path.join(serverRoot, source), "utf8"), "router")
      .map(call => `${call.method.toUpperCase()} ${call.path}`).sort();
    const expected = [...new Set(routes.filter(route => route.source === source).map(route => `${route.method} ${route.sourcePath}`))].sort();
    expect(actual, source).toEqual(expected);
  }
  expect(dataRoutePolicy("POST", "/api/fs/batch-read").operation).toBe("read");
  expect(dataRoutePolicy("POST", "/api/fs/copyFile").operation).toBe("write");
  expect(dataRoutePolicy("POST", "/api/plugins/unreviewed/enable")).toBeNull();
});
it("detects new API mounts in the server entry point", () => {
  const registrations = calls(fs.readFileSync(path.join(serverRoot, "index.js"), "utf8"), "app");
  expect(registrations.filter(call => call.path.startsWith("/api/") && call.method !== "use")).toEqual([]);
  const mounts = registrations
    .filter(call => call.method === "use" && call.path.startsWith("/api/"))
    .map(call => call.path).sort();
  const expected = [...new Set(routes.filter(route => !route.mount.startsWith("/api/ext/")).map(route => route.mount))].sort();
  expect(mounts).toEqual(expected);
});
it("classifies reviewed owner APIs and rejects unknown paths/methods", () => {
  for (const route of routes) {
    const owner = route.mount === "/api/fs" || route.mount === "/api/vault-config" ||
      ["/api/bootstrap", "/api/vault/list", "/api/vault/info", "/api/version"].includes(route.path);
    expect(route.currentAccess).toBe(owner ? "owner" : "admin");
    expect(Object.isFrozen(route)).toBe(true);
    expect(permittedResource(route.method, route.path, [])).toBe(true);
    expect(dataRoutePolicy("OPTIONS", route.path)).toBeNull();
    expect(dataRoutePolicy("PUT", route.path)).toBeNull();
    expect(dataRoutePolicy(route.method, route.path + "/unknown")).toBeNull();
    if (route.method === "GET") expect(dataRoutePolicy("HEAD", route.path)).toBe(route);
  }
  expect(permittedResource("GET", "/api/unclassified", [])).toBe(false);
  expect(dataRoutePolicy("GET", "/api/fs/%72eadFile")).toBeNull();
});
