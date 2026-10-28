import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { startupErrorMessage } = require("./startup-error");
const { readOidcConfig } = require("./config");
const policy = {
  publicOrigin: "https://ignis.example",
  allowHttpLoopback: false,
};
it("identifies the missing issuer when OIDC alone is enabled", () => {
  let error;
  try {
    readOidcConfig({ IGNIS_OIDC_ENABLED: "true" }, policy);
  } catch (caught) {
    error = caught;
  }
  expect(startupErrorMessage(error)).toContain(
    "IGNIS_OIDC_ISSUER is missing or invalid",
  );
  expect(startupErrorMessage(error)).toContain("Server remains closed.");
});
it.each([
  [{ IGNIS_OIDC_CLIENT_ID: "" }, "IGNIS_OIDC_CLIENT_ID"],
  [{ IGNIS_OIDC_CLIENT_SECRET: "" }, "exactly one nonempty secret source"],
  [{ IGNIS_OIDC_AUTO_PROVISION: "yes" }, "IGNIS_OIDC_AUTO_PROVISION"],
  [{ IGNIS_OIDC_ACCOUNT_LINKING: "username" }, "IGNIS_OIDC_ACCOUNT_LINKING"],
  [
    {
      IGNIS_OIDC_CLIENT_SECRET: "",
      IGNIS_OIDC_CLIENT_SECRET_FILE: "/missing/SYNTHETIC_SECRET",
    },
    "Cannot read IGNIS_OIDC_CLIENT_SECRET_FILE",
  ],
])(
  "reports actionable configuration errors without values",
  (patch, expected) => {
    let error;
    try {
      readOidcConfig(
        {
          IGNIS_OIDC_ENABLED: "true",
          IGNIS_OIDC_ISSUER: "https://idp.example",
          IGNIS_OIDC_CLIENT_ID: "ignis",
          IGNIS_OIDC_CLIENT_SECRET: "SYNTHETIC_SECRET",
          ...patch,
        },
        policy,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(startupErrorMessage(error)).toContain(expected);
    expect(startupErrorMessage(error)).not.toContain("SYNTHETIC_SECRET");
  },
);
it("never emits unknown errors, nested causes or provider content", () => {
  for (const error of [
    null,
    new Error("SYNTHETIC_SECRET"),
    new Error("Invalid OIDC issuer: SYNTHETIC_SECRET"),
  ])
    expect(startupErrorMessage(error)).toBe(
      "[ignis] Startup failed; server remains closed",
    );
  expect(
    startupErrorMessage(
      new Error("Unable to initialize OIDC provider", {
        cause: new Error("SYNTHETIC_SECRET"),
      }),
    ),
  ).not.toContain("SYNTHETIC_SECRET");
});
