const { createHash } = require("node:crypto");

function key(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function createRequestLimits({ now = Date.now, capacity = 10000 } = {}) {
  const buckets = new Map();
  function check(rules) {
    const at = now();
    for (const [id, bucket] of buckets)
      if (bucket.until <= at) buckets.delete(id);
    let missing = 0, retryAt = at;
    for (const [id, limit] of rules) {
      const bucket = buckets.get(id);
      if (bucket && bucket.count >= limit) retryAt = Math.max(retryAt, bucket.until);
      if (!bucket) missing++;
    }
    if (buckets.size + missing > capacity) {
      // Expiring one of this request's own counters also requires recreating it;
      // only unrelated counters free capacity for the missing rule counters.
      const own = new Set(rules.map(([id]) => id));
      const expiries = [...buckets].filter(([id]) => !own.has(id)).map(([,bucket]) => bucket.until).sort((a,b) => a-b);
      const needed = buckets.size + missing - capacity;
      retryAt = Math.max(retryAt, expiries[needed-1] ?? at + 60000);
    }
    if (retryAt > at) return {allowed:false,retryAfterSeconds:Math.max(1,Math.ceil((retryAt-at)/1000))};
    for (const [id, , duration] of rules) {
      const bucket = buckets.get(id) || { count: 0, until: at + duration };
      bucket.count++;
      buckets.set(id, bucket);
    }
    return {allowed:true,retryAfterSeconds:0};
  }
  const allow = rules => check(rules).allowed;
  const loginRules = (ip, login) => [
    ["login-global", 60, 60000],
    ["login-ip:" + key(ip), 10, 15 * 60000],
    ["login-account:" + key(login), 10, 15 * 60000],
  ];
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
    resetPassword: ip => allow([
      ["reset-global", 30, 60000],
      ["reset-ip:" + key(ip), 10, 15 * 60000],
    ]),
    login: (ip, login) => allow(loginRules(ip, login)),
    checkLogin: (ip, login) => check(loginRules(ip, login)),
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
    sharedResourceReads: actorId => allow([["share-reads-global",12000,60000],["share-reads-actor:"+key(actorId),2400,60000]]),
    sharedResources: actorId => allow([["shares-global",600,60000],["shares-actor:"+key(actorId),120,60000]]),
    vaultCreation: actorId => allow([["vault-create-global",60,60000],["vault-create-actor:"+key(actorId),10,60000]]),
    vaultMembers: actorId => allow([
      ["vault-members-global", 300, 60000],
      ["vault-members-actor:" + key(actorId), 60, 60000],
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
