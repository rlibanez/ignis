const { createHash } = require("node:crypto");

function key(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function createRequestLimits({ now = Date.now, capacity = 10000 } = {}) {
  const buckets = new Map();
  function allow(rules) {
    const at = now();
    for (const [id, bucket] of buckets)
      if (bucket.until <= at) buckets.delete(id);
    let missing = 0;
    for (const [id, limit] of rules) {
      const bucket = buckets.get(id);
      if (bucket && bucket.count >= limit) return false;
      if (!bucket) missing++;
    }
    if (buckets.size + missing > capacity) return false;
    for (const [id, , duration] of rules) {
      const bucket = buckets.get(id) || { count: 0, until: at + duration };
      bucket.count++;
      buckets.set(id, bucket);
    }
    return true;
  }
  return {
    staticRequest: (ip) =>
      allow([
        ["static-global", 3000, 60000],
        ["static-ip:" + key(ip), 600, 60000],
      ]),
    authRead: (ip) =>
      allow([
        ["auth-read-global", 1500, 60000],
        ["auth-read-ip:" + key(ip), 300, 60000],
      ]),
    publicRequest: (ip) =>
      allow([
        ["public-global", 300, 60000],
        ["public-ip:" + key(ip), 60, 60000],
      ]),
    login: (ip, login) =>
      allow([
        ["login-global", 60, 60000],
        ["login-ip:" + key(ip), 10, 15 * 60000],
        ["login-account:" + key(login), 10, 15 * 60000],
      ]),
    oidcStart: (ip) =>
      allow([
        ["oidc-start-global", 60, 60000],
        ["oidc-start-ip:" + key(ip), 10, 900000],
      ]),
    oidcCallback: (ip) =>
      allow([
        ["oidc-callback-global", 120, 60000],
        ["oidc-callback-ip:" + key(ip), 30, 900000],
      ]),
    createUser: (actorId) =>
      allow([
        ["create-user-global", 30, 60000],
        ["create-user-actor:" + key(actorId), 10, 60000],
      ]),
    setup: (ip) =>
      allow([
        ["setup-global", 20, 15 * 60000],
        ["setup-ip:" + key(ip), 5, 15 * 60000],
      ]),
    upgrade: (ip) =>
      allow([
        ["ws-global", 300, 60000],
        ["ws-ip:" + key(ip), 30, 60000],
      ]),
  };
}

module.exports = { createRequestLimits };
