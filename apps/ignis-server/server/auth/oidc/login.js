const { createHash } = require("node:crypto");
const { createOidcTransactions } = require("./transactions");

// Returns a verified external identity only: no provisioning, roles or session issuance.
async function createOidcLogin(
  config,
  configuration,
  cookiePolicy,
  { now = Date.now } = {},
) {
  const client = await import("openid-client");
  if (
    configuration.serverMetadata().issuer !== config.issuer ||
    configuration.clientMetadata().client_id !== config.clientId ||
    configuration.clientMetadata().id_token_signed_response_alg !== "RS256"
  )
    throw new Error("Invalid OIDC login configuration");
  client.enableNonRepudiationChecks(configuration);
  const transactions = createOidcTransactions(config, cookiePolicy, { now });
  const fail = () => new Error("OIDC authentication failed");
  return Object.freeze({
    async begin(cookieHeader) {
      try {
        const attempt = await transactions.begin(cookieHeader);
        if (!attempt) throw fail();
        const url = client.buildAuthorizationUrl(configuration, {
          redirect_uri: config.redirectUri,
          response_type: "code",
          response_mode: "query",
          scope: "openid",
          state: attempt.state,
          nonce: attempt.nonce,
          code_challenge: attempt.codeChallenge,
          code_challenge_method: "S256",
        });
        return { url: url.href, cookie: attempt.cookie };
      } catch {
        throw fail();
      }
    },
    async complete(callback, cookieHeader) {
      try {
        const raw = callback instanceof URL ? callback.href : callback;
        if (
          typeof raw !== "string" ||
          raw.length > 8192 ||
          /[\s\\#]/u.test(raw)
        )
          throw fail();
        const url = new URL(raw);
        const redirect = new URL(config.redirectUri);
        if (
          url.origin !== redirect.origin ||
          url.pathname !== redirect.pathname ||
          url.username ||
          url.password
        )
          throw fail();
        const params = url.searchParams;
        for (const key of params.keys())
          if (params.getAll(key).length !== 1) throw fail();
        const state = params.get("state");
        const attempt = transactions.consume(state, cookieHeader);
        if (
          !attempt ||
          attempt.issuer !== config.issuer ||
          attempt.clientId !== config.clientId ||
          attempt.redirectUri !== config.redirectUri ||
          attempt.expiresAt <= now()
        )
          throw fail();
        // Transaction is consumed even when the provider cancels or exchange fails.
        const tokens = await client.authorizationCodeGrant(configuration, url, {
          expectedState: state,
          expectedNonce: attempt.nonce,
          pkceCodeVerifier: attempt.verifier,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        const seconds = now() / 1000;
        if (
          attempt.expiresAt <= now() ||
          !claims ||
          claims.iss !== config.issuer ||
          typeof claims.sub !== "string" ||
          !/^[\x20-\x7e]{1,255}$/.test(claims.sub) ||
          !Number.isFinite(claims.iat) ||
          !Number.isFinite(claims.exp) ||
          claims.iat > seconds + 30 ||
          claims.iat < seconds - 330 ||
          claims.exp <= claims.iat ||
          claims.exp <= seconds - 30 ||
          (claims.azp !== undefined && claims.azp !== config.clientId)
        )
          throw fail();
        // Optional in code-flow ID Tokens; verify when supplied, fixed to RS256.
        for (const [claim, value] of [
          ["at_hash", tokens.access_token],
          ["c_hash", params.get("code")],
        ]) {
          if (claims[claim] !== undefined) {
            if (
              typeof value !== "string" ||
              claims[claim] !==
                createHash("sha256")
                  .update(value, "ascii")
                  .digest()
                  .subarray(0, 16)
                  .toString("base64url")
            )
              throw fail();
          }
        }
        return Object.freeze({ issuer: claims.iss, subject: claims.sub });
      } catch {
        throw fail();
      }
    },
    clear() {
      transactions.clear();
    },
  });
}
module.exports = { createOidcLogin };
