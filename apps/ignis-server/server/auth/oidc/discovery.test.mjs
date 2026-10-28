import { it, expect, beforeAll, afterAll } from "vitest";
import https from "node:https";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { initializeOidcClient } = require("./discovery");
const { readOidcConfig } = require("./config");
const cert = fs.readFileSync(
  new URL("./fixtures/localhost-cert.pem", import.meta.url),
);
const key = fs.readFileSync(
  new URL("./fixtures/localhost-key.pem", import.meta.url),
);
let server, origin, handler;
const requests = [];
beforeAll(async () => {
  server = https.createServer({ key, cert }, (req, res) => {
    requests.push({
      path: req.url,
      method: req.method,
      authorization: req.headers.authorization,
    });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://oidc.test.invalid:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const configuration = (suffix = "/application/o/ignis/") =>
  readOidcConfig(
    {
      IGNIS_OIDC_ENABLED: "true",
      IGNIS_OIDC_ISSUER: origin + suffix,
      IGNIS_OIDC_CLIENT_ID: "synthetic-client",
      IGNIS_OIDC_CLIENT_SECRET: "SYNTHETIC_SECRET",
    },
    { publicOrigin: "https://ignis.example", allowHttpLoopback: false },
  );
const metadata = (config) => ({
  issuer: config.issuer,
  authorization_endpoint: origin + "/authorize",
  token_endpoint: origin + "/token",
  jwks_uri: origin + "/keys",
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  authorization_response_iss_parameter_supported: true,
});
const initialize = (config, options = {}) =>
  initializeOidcClient(
    config,
    {
      ca: cert,
      privateAddresses: { [origin]: ["127.0.0.1"] },
      ...options,
    },
    {
      lookup: (_host, _options, callback) =>
        callback(null, [{ address: "127.0.0.1", family: 4 }]),
    },
  );
const serve = (data) => {
  handler = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };
};
it.each(["", "/", "/realms/demo", "/application/o/ignis/"])(
  "discovers path issuer %s before constructing a confidential client",
  async (suffix) => {
    const config = configuration(suffix);
    serve(metadata(config));
    requests.length = 0;
    const result = await initialize(config);
    expect(requests).toEqual([
      {
        path: suffix.replace(/\/$/, "") + "/.well-known/openid-configuration",
        method: "GET",
        authorization: undefined,
      },
    ]);
    expect(result.serverMetadata().issuer).toBe(config.issuer);
    expect(
      result.serverMetadata().authorization_response_iss_parameter_supported,
    ).toBe(true);
    expect(result.clientMetadata()).toMatchObject({
      client_id: "synthetic-client",
      id_token_signed_response_alg: "RS256",
      token_endpoint_auth_method: "client_secret_basic",
      redirect_uris: [config.redirectUri],
    });
    expect(JSON.stringify(result.clientMetadata())).not.toContain(
      "SYNTHETIC_SECRET",
    );
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
  },
);
it.each([
  { issuer: "https://attacker.invalid" },
  { token_endpoint: "https://attacker.invalid/token" },
  { jwks_uri: "https://169.254.169.254/keys" },
  { require_pushed_authorization_requests: true },
  { require_signed_request_object: true },
  { require_pushed_authorization_requests: "false" },
  { authorization_response_iss_parameter_supported: "true" },
  { id_token_signing_alg_values_supported: ["none"] },
])(
  "rejects hostile or incompatible metadata before other requests: %j",
  async (patch) => {
    const config = configuration();
    serve({ ...metadata(config), ...patch });
    requests.length = 0;
    await expect(initialize(config)).rejects.toThrow(
      /^Unable to initialize OIDC provider$/,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBeUndefined();
  },
);
it.each([
  [200, "text/html", "{}"],
  [500, "application/json", "SYNTHETIC_SECRET"],
  [200, "application/json", "{broken"],
  [200, "application/json", "null"],
  [200, "application/json", Buffer.from([0xff])],
  [200, "application/json", "x".repeat(1048577)],
  [302, "application/json", "{}"],
])("rejects invalid discovery response %s %s", async (status, type, body) => {
  handler = (_req, res) => {
    res.writeHead(status, {
      "content-type": type,
      location: origin + "/token",
    });
    res.end(body);
  };
  requests.length = 0;
  await expect(initialize(configuration())).rejects.toThrow(
    /^Unable to initialize OIDC provider$/,
  );
  expect(requests).toHaveLength(1);
});
it("restricts subsequent library calls to validated endpoints and methods", async () => {
  const config = configuration();
  serve(metadata(config));
  const instance = await initialize(config);
  const client = await import("openid-client");
  const fetcher = instance[client.customFetch];
  requests.length = 0;
  for (const [url, init] of [
    [origin + "/other", {}],
    [origin + "/token", {}],
    [origin + "/keys", { method: "POST" }],
    [origin + "/keys", { headers: { authorization: "secret" } }],
    [origin + "/keys?other=true", {}],
  ])
    await expect(fetcher(url, init)).rejects.toThrow();
  expect(requests).toHaveLength(0);
  await fetcher(origin + "/keys");
  expect(requests[0]).toMatchObject({
    path: "/keys",
    method: "GET",
    authorization: undefined,
  });
});
it("uses Basic client authentication through the restricted token transport", async () => {
  const config = configuration();
  serve(metadata(config));
  const instance = await initialize(config);
  const client = await import("openid-client");
  requests.length = 0;
  let body;
  handler = (req, res) => {
    body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
    });
  };
  const callback = new URL(config.redirectUri);
  callback.search = new URLSearchParams({
    code: "synthetic-code",
    state: "synthetic-state",
    iss: config.issuer,
  }).toString();
  await expect(
    client.authorizationCodeGrant(instance, callback, {
      expectedState: "synthetic-state",
      expectedNonce: "synthetic-nonce",
      pkceCodeVerifier: "a".repeat(43),
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    path: "/token",
    method: "POST",
  });
  expect(requests[0].authorization).toMatch(/^Basic /);
  const credentials = Buffer.from(requests[0].authorization.slice(6), "base64")
    .toString("utf8")
    .split(":")
    .map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
  expect(credentials).toEqual(["synthetic-client", "SYNTHETIC_SECRET"]);
  const params = new URLSearchParams(body);
  expect(params.get("code_verifier")).toBe("a".repeat(43));
  expect(params.get("redirect_uri")).toBe(config.redirectUri);
  expect(params.has("client_secret")).toBe(false);
});
it("preserves the advertised issuer requirement in callback validation", async () => {
  const config = configuration();
  serve(metadata(config));
  const instance = await initialize(config);
  const client = await import("openid-client");
  requests.length = 0;
  await expect(
    client.authorizationCodeGrant(
      instance,
      new URL(config.redirectUri + "?code=test&state=expected"),
      {
        expectedState: "expected",
        expectedNonce: "nonce",
        pkceCodeVerifier: "a".repeat(43),
      },
    ),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
it("requires explicit endpoint origins in addition to network exceptions", async () => {
  const config = configuration();
  const additional = origin.replace("oidc.test.invalid", "other.invalid");
  serve({ ...metadata(config), jwks_uri: additional + "/keys" });
  await expect(initialize(config)).rejects.toThrow();
  const instance = await initialize(config, { allowedOrigins: [additional] });
  expect(instance.serverMetadata().jwks_uri).toBe(additional + "/keys");
});

it("fails closed before fetching when the configured profile is changed", async () => {
  requests.length = 0;
  const original = configuration();
  for (const patch of [
    { clientAuthentication: "none" },
    { idTokenAlgorithm: "HS256" },
    { scope: "openid offline_access" },
    { codeChallengeMethod: "plain" },
  ]) {
    await expect(
      initialize({
        ...original,
        clientSecret: original.clientSecret,
        ...patch,
      }),
    ).rejects.toThrow(/^Unable to initialize OIDC provider$/);
  }
  expect(requests).toHaveLength(0);
});
