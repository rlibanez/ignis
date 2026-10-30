const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { createSessionCookies } = require("./session-cookies");
const digest = (text) => createHash("sha256").update(text).digest();

function createCsrf(config, { now = Date.now, capacity = 5000, db } = {}) {
  const cookies = createSessionCookies({ ...config, purpose: "csrf" });
  const entries = new Map();
  function issue(req, res, session) {
    const at = now();
    if (db) db.prepare("DELETE FROM csrf_tokens WHERE expires_at<=?").run(at);
    else {
      for (const [key, entry] of entries) {
        if (entry.until <= at) entries.delete(key);
      }
    }
    const count = db ? db.prepare("SELECT count(*) n FROM csrf_tokens").get().n : entries.size;
    if (count >= capacity) return null;
    const browser =
      cookies.read(req.headers.cookie) || randomBytes(32).toString("hex");
    const token = randomBytes(32).toString("hex");
    const until = at + 10 * 60000;
    const entry = {
      browser: digest(browser),
      sessionId: session?.id || null,
      until,
    };
    const key = digest(token).toString("hex");
    // Keep session/browser binding across restarts without persisting bearer secrets.
    if (db) {
      db.prepare("INSERT INTO csrf_tokens (token_hash,browser_hash,session_id,expires_at) VALUES (?,?,?,?)")
        .run(key, entry.browser, entry.sessionId, until);
    } else entries.set(key, entry);
    res.append("Set-Cookie", cookies.serialize(browser, until, at));
    return token;
  }
  function valid(req, session) {
    const token = req.headers["x-ignis-csrf"];
    const browser = cookies.read(req.headers.cookie);
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !browser)
      return false;
    const key = digest(token).toString("hex");
    const entry = db
      ? db.prepare("SELECT browser_hash AS browser,session_id AS sessionId,expires_at AS until FROM csrf_tokens WHERE token_hash=?").get(key)
      : entries.get(key);
    return (
      !!entry &&
      entry.until > now() &&
      entry.sessionId === (session?.id || null) &&
      timingSafeEqual(entry.browser, digest(browser))
    );
  }
  function consume(req) {
    const token = req.headers["x-ignis-csrf"];
    if (typeof token === "string") {
      const key = digest(token).toString("hex");
      if (db) db.prepare("DELETE FROM csrf_tokens WHERE token_hash=?").run(key);
      else entries.delete(key);
    }
  }
  return { issue, valid, consume };
}

module.exports = { createCsrf };
