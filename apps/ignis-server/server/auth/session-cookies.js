// Pure transport helpers. publicOrigin must come from trusted deployment configuration,
// never Host / X-Forwarded-* headers. Wiring to Express and CSRF belongs to phase 2A.2.
function createSessionCookies({
  publicOrigin,
  allowHttpLoopback = false,
  purpose = "session",
}) {
  if (!["session", "csrf", "oidc"].includes(purpose))
    throw new Error("Invalid cookie purpose");
  const origin = new URL(publicOrigin);
  const secure = origin.protocol === "https:";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (!secure &&
      !(allowHttpLoopback === true && loopback && origin.protocol === "http:"))
  ) {
    throw new Error(
      "Sessions require HTTPS; HTTP is only allowed explicitly on loopback",
    );
  }
  const name = `${secure ? "__Host-ignis" : "ignis-dev"}-${purpose}`;
  const attributes = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  function serialize(token, expiresAt, now = Date.now()) {
    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      !Number.isFinite(new Date(expiresAt).getTime())
    )
      throw new Error("Invalid session cookie");
    return `${name}=${token}; ${attributes}; Max-Age=${Math.floor((expiresAt - now) / 1000)}; Expires=${new Date(expiresAt).toUTCString()}`;
  }
  function read(header) {
    if (
      typeof header !== "string" ||
      header.length > 8192 ||
      /[\r\n]/.test(header)
    )
      return null;
    let token = null;
    for (const field of header.split(";")) {
      const part = field.trim();
      const equals = part.indexOf("=");
      if ((equals < 0 ? part : part.slice(0, equals)) !== name) continue;
      const candidate = part.slice(equals + 1);
      // Reject ambiguous duplicates, quoting and encoded values, not "first cookie wins".
      if (token !== null || equals < 0 || !/^[a-f0-9]{64}$/.test(candidate))
        return null;
      token = candidate;
    }
    return token;
  }
  function clear() {
    return `${name}=; ${attributes}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
  return { name, serialize, read, clear };
}

module.exports = { createSessionCookies };
