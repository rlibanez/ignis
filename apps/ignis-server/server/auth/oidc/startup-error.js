// Only fixed, reviewed messages may reach startup logs. Never interpolate causes,
// provider responses, configuration values or filesystem paths.
const diagnostics = new Map([
  ["Invalid IGNIS_OIDC_ENABLED", "IGNIS_OIDC_ENABLED must be true or false."],
  [
    "Invalid OIDC issuer",
    "IGNIS_OIDC_ISSUER is missing or invalid; expected an HTTPS issuer URL without credentials, query or fragment.",
  ],
  [
    "Invalid OIDC client ID",
    "IGNIS_OIDC_CLIENT_ID is missing or invalid; expected 1-512 characters without control characters.",
  ],
  [
    "Configure exactly one OIDC client secret source",
    "Configure exactly one nonempty secret source: IGNIS_OIDC_CLIENT_SECRET or IGNIS_OIDC_CLIENT_SECRET_FILE.",
  ],
  [
    "Unable to read OIDC client secret",
    "Cannot read IGNIS_OIDC_CLIENT_SECRET_FILE; check the container mount, permissions, absolute path and file size.",
  ],
  [
    "Invalid OIDC client secret",
    "The OIDC client secret is empty or invalid; expected at most 4096 UTF-8 bytes without control characters.",
  ],
  [
    "Invalid IGNIS_OIDC_AUTO_PROVISION",
    "IGNIS_OIDC_AUTO_PROVISION must be true or false.",
  ],
  [
    "Invalid IGNIS_OIDC_ACCOUNT_LINKING",
    "IGNIS_OIDC_ACCOUNT_LINKING must be disabled, preferred_username, verified_email or preferred_username_and_verified_email.",
  ],
  [
    "Invalid OIDC network configuration",
    "Invalid OIDC network configuration; check IGNIS_OIDC_ALLOWED_ORIGINS, IGNIS_OIDC_PRIVATE_ADDRESSES and IGNIS_OIDC_CA_FILE.",
  ],
  [
    "Unable to initialize OIDC provider",
    "OIDC provider initialization failed; check issuer discovery, DNS/IP policy, TLS/CA and supported provider metadata.",
  ],
]);
function startupErrorMessage(error) {
  const detail = diagnostics.get(error?.message);
  return detail
    ? `[ignis] Startup failed: ${detail} Server remains closed.`
    : "[ignis] Startup failed; server remains closed";
}
module.exports = { startupErrorMessage };
