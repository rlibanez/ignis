// Pure validation boundary. Does not fetch metadata or establish network trust.
function validateOidcMetadata(input, config, allowedOrigins = []) {
  const fail = () => {
    throw new Error("Invalid OIDC provider metadata");
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  if (input.issuer !== config.issuer) fail();
  const origins = new Set([new URL(config.issuer).origin]);
  for (const origin of allowedOrigins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      fail();
    }
    if (url.protocol !== "https:" || url.origin !== origin) fail();
    origins.add(origin);
  }
  // This profile does not implement mandatory PAR or signed Request Objects.
  for (const key of [
    "require_pushed_authorization_requests",
    "require_signed_request_object",
  ]) {
    if (input[key] !== undefined && input[key] !== false) fail();
  }
  const result = { issuer: config.issuer };
  const responseIssuer = input.authorization_response_iss_parameter_supported;
  if (responseIssuer !== undefined) {
    if (typeof responseIssuer !== "boolean") fail();
    result.authorization_response_iss_parameter_supported = responseIssuer;
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const value = input[key];
    let url;
    try {
      url = new URL(value);
    } catch {
      fail();
    }
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      /[\s\\#]/u.test(value) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !origins.has(url.origin)
    )
      fail();
    result[key] = value;
  }
  function capability(key, required, fallback) {
    const value = input[key] === undefined ? fallback : input[key];
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 128 ||
      value.some(
        (item) => typeof item !== "string" || !item.length || item.length > 256,
      ) ||
      !value.includes(required)
    )
      fail();
    result[key] = Object.freeze([...value]);
  }
  capability("response_types_supported", "code");
  capability("id_token_signing_alg_values_supported", "RS256");
  capability("token_endpoint_auth_methods_supported", "client_secret_basic", [
    "client_secret_basic",
  ]);
  capability("grant_types_supported", "authorization_code", [
    "authorization_code",
    "implicit",
  ]);
  capability("response_modes_supported", "query", ["query", "fragment"]);
  // Absence of this optional metadata does not mean PKCE is unavailable.
  // The eventual flow must still send S256 and verify the exchange with PKCE.
  if (input.code_challenge_methods_supported !== undefined)
    capability("code_challenge_methods_supported", "S256");
  if (input.scopes_supported !== undefined)
    capability("scopes_supported", "openid");
  const subjects = input.subject_types_supported;
  if (
    !Array.isArray(subjects) ||
    !subjects.length ||
    subjects.length > 2 ||
    subjects.some((value) => !["public", "pairwise"].includes(value))
  )
    fail();
  result.subject_types_supported = Object.freeze([...subjects]);
  // Do not forward unreviewed extensions (e.g. mTLS aliases) to the OIDC library.
  return Object.freeze(result);
}
module.exports = { validateOidcMetadata };
