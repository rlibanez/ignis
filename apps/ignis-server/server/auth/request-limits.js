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
    upgrade: (ip) =>
      allow([
        ["ws-global", 300, 60000],
        ["ws-ip:" + key(ip), 30, 60000],
      ]),
  };
}

module.exports = { createRequestLimits };
