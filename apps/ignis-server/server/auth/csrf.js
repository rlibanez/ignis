const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { createSessionCookies } = require("./session-cookies");
const digest = (text) => createHash("sha256").update(text).digest();

function createCsrf(config, { now = Date.now, capacity = 5000 } = {}) {
  const cookies = createSessionCookies({ ...config, purpose: "csrf" });
  const entries = new Map();
  function issue(req, res, session) {
    const at = now();
    for (const [key, entry] of entries)
      if (entry.until <= at) entries.delete(key);
    if (entries.size >= capacity) return null;
    const browser =
      cookies.read(req.headers.cookie) || randomBytes(32).toString("hex");
    const token = randomBytes(32).toString("hex");
    const until = at + 10 * 60000;
    entries.set(digest(token).toString("hex"), {
      browser: digest(browser),
      sessionId: session?.id || null,
      until,
    });
    res.append("Set-Cookie", cookies.serialize(browser, until, at));
    return token;
  }
  function valid(req, session) {
    const token = req.headers["x-ignis-csrf"];
    const browser = cookies.read(req.headers.cookie);
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !browser)
      return false;
    const entry = entries.get(digest(token).toString("hex"));
    return (
      !!entry &&
      entry.until > now() &&
      entry.sessionId === (session?.id || null) &&
      timingSafeEqual(entry.browser, digest(browser))
    );
  }
  function consume(req) {
    const token = req.headers["x-ignis-csrf"];
    if (typeof token === "string")
      entries.delete(digest(token).toString("hex"));
  }
  return { issue, valid, consume };
}

module.exports = { createCsrf };
