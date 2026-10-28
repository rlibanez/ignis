const { readPasswordPolicy } = require("./password-policy");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { readInitialAdminKey } = require("./initial-admin");

const ROUTES = new Set([
  ...["stat", "readFile", "access", "tree", "download", "download-zip"].map(
    (p) => `GET /api/fs/${p}`,
  ),
  ...[
    "writeFile",
    "appendFile",
    "mkdir",
    "rename",
    "copyFile",
    "utimes",
    "batch-read",
  ].map((p) => `POST /api/fs/${p}`),
  ...["unlink", "rmdir", "rm"].map((p) => `DELETE /api/fs/${p}`),
  "GET /api/vault/list",
  "GET /api/vault/info",
  "POST /api/vault/refresh",
  "POST /api/vault/create",
  "POST /api/vault/rename",
  "DELETE /api/vault/remove",
  "POST /api/proxy",
  "GET /api/version",
  "GET /api/settings",
  "POST /api/settings",
  "GET /api/plugins",
  "GET /api/bootstrap",
  "POST /api/plugins/headless-sync/enable",
  "POST /api/plugins/headless-sync/disable",
  ...["status", "logs", "vaults", "remote-vaults"].map(
    (p) => `GET /api/ext/headless-sync/${p}`,
  ),
  ...[
    "login",
    "logout",
    "setup",
    "config",
    "start",
    "stop",
    "unlink",
    "create-remote-vault",
  ].map((p) => `POST /api/ext/headless-sync/${p}`),
]);

function readAuthConfig(env = process.env) {
  if (!env.IGNIS_PUBLIC_ORIGIN)
    throw new Error("IGNIS_PUBLIC_ORIGIN is required");
  const origin = new URL(env.IGNIS_PUBLIC_ORIGIN);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw new Error("Invalid public origin");
  if (
    env.IGNIS_ALLOW_HTTP_LOOPBACK &&
    !["true", "false"].includes(env.IGNIS_ALLOW_HTTP_LOOPBACK)
  ) {
    throw new Error("Invalid HTTP loopback setting");
  }
  const trustedProxies = JSON.parse(env.IGNIS_TRUSTED_PROXIES || "[]");
  if (
    !Array.isArray(trustedProxies) ||
    trustedProxies.length > 32 ||
    trustedProxies.some((value) => {
      if (typeof value !== "string") return true;
      const parts = value.split("/");
      const family = net.isIP(parts[0]);
      return (
        !family ||
        parts.length > 2 ||
        (parts.length === 2 &&
          (!/^\d+$/.test(parts[1]) ||
            Number(parts[1]) > (family === 4 ? 32 : 128)))
      );
    })
  )
    throw new Error("Trusted proxies must be explicit IP addresses or CIDRs");
  return {
    publicOrigin: origin.origin,
    allowHttpLoopback: env.IGNIS_ALLOW_HTTP_LOOPBACK === "true",
    trustedProxies,
    passwordPolicy: readPasswordPolicy(env),
    initialAdminKeyDigest: readInitialAdminKey(env),
  };
}

function canonicalRequestPath(req) {
  const raw = req.url.split("?")[0];
  // No percent-encoded API aliases, separators or dot-segment routing differences.
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith("/") || raw.includes("\\") || /[\x00-\x20]/.test(raw))
    return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((s) => s === "." || s === "..")
  )
    return null;
  if (decoded.startsWith("/api/") && raw !== decoded) return null;
  return decoded.length > 1 ? decoded.replace(/\/$/, "") : decoded;
}

function permittedResource(method, pathname, staticRoots) {
  const verb = method === "HEAD" ? "GET" : method;
  if (ROUTES.has(`${verb} ${pathname}`)) return true;
  if (pathname.startsWith("/api/")) return false;
  if (verb !== "GET") return false;
  if (["/", "/index.html", "/favicon.png"].includes(pathname)) return true;
  if (pathname.startsWith("/vault-files/") && pathname.split("/").length >= 4)
    return true;
  for (const entry of staticRoots) {
    const root = typeof entry === "string" ? entry : entry.root;
    const mount = typeof entry === "string" ? "/" : entry.mount;
    if (!pathname.startsWith(mount)) continue;
    const file = path.resolve(root, pathname.slice(mount.length));
    if (!file.startsWith(path.resolve(root) + path.sep)) continue;
    try {
      const real = fs.realpathSync(file);
      if (
        real.startsWith(fs.realpathSync(root) + path.sep) &&
        fs.statSync(real).isFile()
      )
        return true;
    } catch {
      /* A missing static file is not an allowed route. */
    }
  }
  return false;
}

module.exports = { readAuthConfig, canonicalRequestPath, permittedResource };
