const fs = require("node:fs");
const path = require("node:path");
const { createSessionCookies } = require("../session-cookies");

// Internal contract only: not wired into the HTTP server until the complete adapter is accepted.
function readOidcConfig(env = process.env, transport) {
  const enabled = env.IGNIS_OIDC_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled))
    throw new Error("Invalid IGNIS_OIDC_ENABLED");
  if (enabled === "false") return null;
  createSessionCookies(transport);
  const issuer = env.IGNIS_OIDC_ISSUER;
  let url;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("Invalid OIDC issuer");
  }
  if (
    typeof issuer !== "string" ||
    issuer.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\s\\?#]/u.test(issuer)
  )
    throw new Error("Invalid OIDC issuer");
  const clientId = env.IGNIS_OIDC_CLIENT_ID;
  if (
    typeof clientId !== "string" ||
    !clientId.length ||
    clientId.length > 512 ||
    /[\p{Cc}]/u.test(clientId)
  )
    throw new Error("Invalid OIDC client ID");
  const direct = env.IGNIS_OIDC_CLIENT_SECRET;
  const file = env.IGNIS_OIDC_CLIENT_SECRET_FILE;
  if (!!direct === !!file)
    throw new Error("Configure exactly one OIDC client secret source");
  let secret = direct;
  if (file) {
    let fd;
    try {
      if (!path.isAbsolute(file)) throw new Error();
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4098) throw new Error();
      const buffer = Buffer.alloc(4099);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      secret = new TextDecoder("utf-8", { fatal: true })
        .decode(buffer.subarray(0, length))
        .replace(/\r?\n$/, "");
    } catch {
      throw new Error("Unable to read OIDC client secret");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (
    typeof secret !== "string" ||
    !secret.length ||
    Buffer.byteLength(secret) > 4096 ||
    /[\p{Cc}]/u.test(secret)
  )
    throw new Error("Invalid OIDC client secret");
  const autoProvision = env.IGNIS_OIDC_AUTO_PROVISION ?? "false";
  const accountLinking = env.IGNIS_OIDC_ACCOUNT_LINKING ?? "disabled";
  if (!["true", "false"].includes(autoProvision))
    throw new Error("Invalid IGNIS_OIDC_AUTO_PROVISION");
  if (
    ![
      "disabled",
      "preferred_username",
      "verified_email",
      "preferred_username_and_verified_email",
    ].includes(accountLinking)
  )
    throw new Error("Invalid IGNIS_OIDC_ACCOUNT_LINKING");
  const scopes = ["openid"];
  if (autoProvision === "true" || accountLinking.includes("preferred_username"))
    scopes.push("profile");
  if (autoProvision === "true" || accountLinking.includes("verified_email"))
    scopes.push("email");
  const config = {
    issuer,
    clientId,
    redirectUri: new URL("/api/auth/oidc/callback", transport.publicOrigin)
      .href,
    clientAuthentication: "client_secret_basic",
    responseType: "code",
    scope: scopes.join(" "),
    autoProvision: autoProvision === "true",
    accountLinking,
    codeChallengeMethod: "S256",
    idTokenAlgorithm: "RS256",
  };
  // Keep accidental JSON/string logging from serializing the client secret.
  Object.defineProperty(config, "clientSecret", {
    value: secret,
    enumerable: false,
  });
  return Object.freeze(config);
}
module.exports = { readOidcConfig };
