import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateOidcMetadata: validate } = require("./metadata");
const config = { issuer: "https://idp.example/realm/demo" };
const base = () => ({
  issuer: config.issuer,
  authorization_endpoint: "https://idp.example/authorize",
  token_endpoint: "https://idp.example/token",
  jwks_uri: "https://idp.example/keys",
  response_types_supported: ["code"],
  id_token_signing_alg_values_supported: ["RS256"],
  subject_types_supported: ["public"],
});
it("accepts the confidential profile with specification defaults and snapshots metadata", () => {
  const input = base();
  const output = validate(input, config);
  expect(output.token_endpoint_auth_methods_supported).toEqual([
    "client_secret_basic",
  ]);
  expect(Object.isFrozen(output)).toBe(true);
  input.response_types_supported.push("token");
  expect(output.response_types_supported).toEqual(["code"]);
});
it.each([null, [], {}, { ...base(), issuer: config.issuer + "/" }])(
  "rejects invalid documents and nonexact issuers",
  (input) => {
    expect(() => validate(input, config)).toThrow(
      "Invalid OIDC provider metadata",
    );
  },
);
it.each(["authorization_endpoint", "token_endpoint", "jwks_uri"])(
  "constrains %s to explicitly approved HTTPS origins",
  (key) => {
    for (const value of [
      undefined,
      "http://idp.example/a",
      "https://evil.example/a",
      "https://idp.example:444/a",
      "https://user:secret@idp.example/a",
      "https://idp.example/a#",
      "https://idp.example/\na",
      "https://idp.example\\evil/a",
      "/relative",
      "https://127.0.0.1/a",
    ]) {
      expect(() => validate({ ...base(), [key]: value }, config)).toThrow(
        "Invalid OIDC provider metadata",
      );
    }
    expect(
      validate({ ...base(), [key]: "https://keys.example/a" }, config, [
        "https://keys.example",
      ])[key],
    ).toBe("https://keys.example/a");
  },
);
it.each([
  ["response_types_supported", ["token"]],
  ["id_token_signing_alg_values_supported", ["none", "HS256"]],
  ["token_endpoint_auth_methods_supported", ["none", "client_secret_post"]],
  ["grant_types_supported", ["implicit"]],
  ["response_modes_supported", ["form_post"]],
  ["code_challenge_methods_supported", ["plain"]],
  ["scopes_supported", ["email"]],
  ["subject_types_supported", ["unknown"]],
])("rejects unsupported %s without downgrade", (key, value) => {
  expect(() => validate({ ...base(), [key]: value }, config)).toThrow();
  expect(() => validate({ ...base(), [key]: null }, config)).toThrow();
  expect(() => validate({ ...base(), [key]: "code" }, config)).toThrow();
});
it("drops unreviewed metadata extensions and validates explicit origins", () => {
  expect(
    validate(
      {
        ...base(),
        mtls_endpoint_aliases: { token_endpoint: "https://evil.example" },
      },
      config,
    ),
  ).not.toHaveProperty("mtls_endpoint_aliases");
  for (const origin of [
    "http://idp.example",
    "https://idp.example/",
    "https://idp.example/path",
    "https://x@y.example",
  ])
    expect(() => validate(base(), config, [origin])).toThrow();
});
