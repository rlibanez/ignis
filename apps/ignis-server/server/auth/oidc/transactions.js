const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { createSessionCookies } = require("../session-cookies");
const hash = (value) => createHash("sha256").update(value).digest();
const browserFormat = /^[a-f0-9]{64}$/;
const stateFormat = /^[A-Za-z0-9_-]{43}$/;

function createOidcTransactions(
  config,
  transport,
  { now = Date.now, capacity = 1000, perBrowser = 4 } = {},
) {
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    !Number.isSafeInteger(perBrowser) ||
    perBrowser < 1
  )
    throw new Error("Invalid OIDC transaction limits");
  const entries = new Map();
  const cookies = createSessionCookies({ ...transport, purpose: "oidc" });
  const ttlMs = 5 * 60000;
  function purge() {
    for (const [key, entry] of entries)
      if (entry.expiresAt <= now()) entries.delete(key);
  }
  return {
    async begin(cookieHeader) {
      const oidc = await import("openid-client");
      const browser =
        cookies.read(cookieHeader) || randomBytes(32).toString("hex");
      const browserHash = hash(browser);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(verifier);
      // Check capacity after awaits, immediately before insertion, to avoid concurrent overflow.
      purge();
      const count = [...entries.values()].filter((entry) =>
        timingSafeEqual(entry.browserHash, browserHash),
      ).length;
      if (entries.size >= capacity || count >= perBrowser) return null;
      const at = now(),
        expiresAt = at + ttlMs;
      entries.set(hash(state).toString("hex"), {
        browserHash,
        verifier,
        nonce,
        expiresAt,
        issuer: config.issuer,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
      });
      return {
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: "S256",
        // Keep the browser binding beyond the transaction TTL so staggered tabs remain bound.
        cookie: cookies.serialize(browser, at + 10 * 60000, at),
      };
    },
    consume(state, cookieHeader) {
      purge();
      const browser = cookies.read(cookieHeader);
      if (
        typeof state !== "string" ||
        !stateFormat.test(state) ||
        !browserFormat.test(browser || "")
      )
        return null;
      const key = hash(state).toString("hex");
      const entry = entries.get(key);
      if (!entry || !timingSafeEqual(entry.browserHash, hash(browser)))
        return null;
      // Burn before any token request, including provider errors; no replay after failure.
      entries.delete(key);
      return {
        verifier: entry.verifier,
        nonce: entry.nonce,
        issuer: entry.issuer,
        clientId: entry.clientId,
        redirectUri: entry.redirectUri,
        expiresAt: entry.expiresAt,
      };
    },
    clear() {
      entries.clear();
    },
  };
}
module.exports = { createOidcTransactions };
