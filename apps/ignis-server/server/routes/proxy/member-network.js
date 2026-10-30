const { isIP } = require("node:net");
const dns = require("node:dns");
const { isPublicAddress } = require("../../auth/oidc/transport");
// Normal accounts never inherit private-network exceptions intended for admins.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error || !addresses?.length || addresses.some(entry => !isPublicAddress(entry.address)))
      return callback(new Error("Public address required"));
    return options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
  });
}
function memberTarget(url, mode, allowlist) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) return false;
  return url.protocol === "https:" && !url.username && !url.password &&
    (!url.port || url.port === "443") &&
    (mode !== "allowlist" || allowlist.includes(url.hostname));
}
const fail = (message, statusCode = 403) => { throw Object.assign(new Error(message), { statusCode }); };
let inFlight = 0;
async function memberRelay(args, relay, mode, allowlist) {
  const allowedTarget = url => memberTarget(url, mode, allowlist);
  if (!allowedTarget(new URL(args.url))) fail("Public HTTPS target required");
  if (inFlight >= 8) fail("Network capacity reached", 429);
  inFlight++;
  try { return await relay({ ...args, allowedTarget, lookup: publicLookup, timeoutMs: 15000, maxBytes: 10 * 1024 * 1024 }); }
  finally { inFlight--; }
}
module.exports = { publicLookup, memberTarget, memberRelay };
