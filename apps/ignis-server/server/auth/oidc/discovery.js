const { createJwksFetch } = require("./jwks");
const { createOidcTransport } = require("./transport");
const { validateOidcMetadata } = require("./metadata");

// Backend initialization only. No HTTP route or session issuance in this module.
async function initializeOidcClient(
  config,
  { allowedOrigins = [], privateAddresses = {}, ca, timeoutMs = 5000 } = {},
  dependencies,
) {
  try {
    if (
      !config ||
      config.clientAuthentication !== "client_secret_basic" ||
      config.idTokenAlgorithm !== "RS256" ||
      config.codeChallengeMethod !== "S256" ||
      config.responseType !== "code" ||
      ![
        "openid",
        "openid profile",
        "openid email",
        "openid profile email",
      ].includes(config.scope) ||
      typeof config.clientSecret !== "string" ||
      !config.clientSecret.length
    )
      throw new Error();
    const issuer = new URL(config.issuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.username ||
      issuer.password ||
      /[\s\\?#]/u.test(config.issuer)
    )
      throw new Error();
    const transport = createOidcTransport(
      {
        origins: [issuer.origin, ...allowedOrigins],
        privateAddresses,
        ca,
        timeoutMs,
      },
      dependencies,
    );
    // OIDC Discovery appends to the issuer path; it is not OAuth AS path insertion.
    const location =
      config.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
    const response = await transport(location, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw new Error();
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      await response.arrayBuffer(),
    );
    const metadata = validateOidcMetadata(
      JSON.parse(json),
      config,
      allowedOrigins,
    );
    const client = await import("openid-client");
    const configuration = new client.Configuration(
      metadata,
      config.clientId,
      {
        redirect_uris: [config.redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "client_secret_basic",
        id_token_signed_response_alg: "RS256",
        [client.clockTolerance]: 30,
      },
      client.ClientSecretBasic(config.clientSecret),
    );
    configuration.timeout = timeoutMs / 1000;
    client.enableNonRepudiationChecks(configuration);
    const fetchKeys = createJwksFetch(transport);
    const tokenUrl = new URL(metadata.token_endpoint).href;
    const keysUrl = new URL(metadata.jwks_uri).href;
    configuration[client.customFetch] = async (input, init = {}) => {
      let href;
      try {
        href = new URL(input).href;
      } catch {
        throw new Error("OIDC endpoint request rejected");
      }
      const method = init.method ?? "GET";
      if (
        !(href === tokenUrl && method === "POST") &&
        !(href === keysUrl && method === "GET")
      )
        throw new Error("OIDC endpoint request rejected");
      // Client credentials belong only to the token endpoint, never to JWKS.
      if (method === "GET" && new Headers(init.headers).has("authorization"))
        throw new Error("OIDC endpoint request rejected");
      return method === "GET" ? fetchKeys(input, init) : transport(input, init);
    };
    return configuration;
  } catch {
    // Library errors may contain provider responses or request material.
    throw new Error("Unable to initialize OIDC provider");
  }
}
module.exports = { initializeOidcClient };
