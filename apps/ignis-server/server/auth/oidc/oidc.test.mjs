import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { readOidcConfig } = require("./config");
const { createOidcTransactions } = require("./transactions");
const transport = {
  publicOrigin: "https://ignis.example",
  allowHttpLoopback: false,
};
const env = {
  IGNIS_OIDC_ENABLED: "true",
  IGNIS_OIDC_ISSUER: "https://idp.example/application/o/ignis/",
  IGNIS_OIDC_CLIENT_ID: "ignis",
  IGNIS_OIDC_CLIENT_SECRET: "SYNTHETIC_CLIENT_SECRET",
};
const config = readOidcConfig(env, transport);
const cookie = (attempt) => attempt.cookie.split(";")[0];
it("keeps OIDC disabled by default and fixes the confidential profile and callback", () => {
  expect(readOidcConfig({}, transport)).toBeNull();
  expect(config.redirectUri).toBe(
    "https://ignis.example/api/auth/oidc/callback",
  );
  expect(config.issuer).toBe(env.IGNIS_OIDC_ISSUER);
  expect(config.clientAuthentication).toBe("client_secret_basic");
  expect(config.scope).toBe("openid");
  expect(config.clientSecret).toBe(env.IGNIS_OIDC_CLIENT_SECRET);
  expect(JSON.stringify(config)).not.toContain(env.IGNIS_OIDC_CLIENT_SECRET);
  expect(Object.isFrozen(config)).toBe(true);
});
it("rejects malformed or incomplete configuration with sanitized errors", () => {
  for (const patch of [
    { IGNIS_OIDC_ENABLED: "yes" },
    { IGNIS_OIDC_ISSUER: "https://idp.exa\nmple" },
    { IGNIS_OIDC_ISSUER: "https://idp.example#" },
    { IGNIS_OIDC_ISSUER: "http://idp.example" },
    { IGNIS_OIDC_ISSUER: "https://user:password@idp.example" },
    { IGNIS_OIDC_ISSUER: "https://idp.example?secret=SYNTHETIC_CLIENT_SECRET" },
    { IGNIS_OIDC_CLIENT_ID: "" },
    { IGNIS_OIDC_CLIENT_SECRET: "" },
    { IGNIS_OIDC_CLIENT_SECRET_FILE: "/secret/location" },
    { IGNIS_OIDC_CLIENT_SECRET: "line\nbreak" },
  ]) {
    expect(() => readOidcConfig({ ...env, ...patch }, transport)).toThrow();
    try {
      readOidcConfig({ ...env, ...patch }, transport);
    } catch (e) {
      expect(e.message).not.toContain("SYNTHETIC_CLIENT_SECRET");
      expect(e.message).not.toContain("/secret/location");
    }
  }
});
it("reads a bounded runtime secret file with one optional final newline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-oidc-"));
  const file = path.join(root, "client-secret");
  const fileEnv = {
    ...env,
    IGNIS_OIDC_CLIENT_SECRET: "",
    IGNIS_OIDC_CLIENT_SECRET_FILE: file,
  };
  try {
    for (const ending of ["", "\n", "\r\n"]) {
      fs.writeFileSync(file, "synthetic" + ending, { mode: 0o600 });
      expect(readOidcConfig(fileEnv, transport).clientSecret).toBe("synthetic");
    }
    fs.writeFileSync(file, "x".repeat(5000));
    expect(() => readOidcConfig(fileEnv, transport)).toThrow();
    fs.unlinkSync(file);
    expect(() => readOidcConfig(fileEnv, transport)).toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it("generates independent state, nonce and S256 PKCE bound to the browser", async () => {
  const store = createOidcTransactions(config, transport);
  const a = await store.begin();
  const b = await store.begin(cookie(a));
  expect(a.state).not.toBe(b.state);
  expect(a.nonce).not.toBe(b.nonce);
  expect(a).not.toHaveProperty("verifier");
  expect(a.cookie).toContain("__Host-ignis-oidc=");
  expect(a.cookie).toContain("HttpOnly");
  expect(a.cookie).toContain("Secure");
  expect(a.cookie).toContain("SameSite=Lax");
  const consumed = store.consume(a.state, cookie(a));
  expect(consumed.nonce).toBe(a.nonce);
  expect(
    createHash("sha256").update(consumed.verifier).digest("base64url"),
  ).toBe(a.codeChallenge);
  expect(store.consume(a.state, cookie(a))).toBeNull();
  expect(store.consume(b.state, cookie(b))).not.toBeNull();
});
it("rejects wrong browsers, ambiguous cookies, malformed state and replay", async () => {
  const store = createOidcTransactions(config, transport);
  const a = await store.begin(),
    b = await store.begin();
  expect(store.consume(a.state, cookie(b))).toBeNull();
  expect(store.consume(a.state, cookie(a) + "; " + cookie(b))).toBeNull();
  expect(store.consume("bad", cookie(a))).toBeNull();
  expect(store.consume(a.state, cookie(a))).not.toBeNull();
  expect(store.consume(a.state, cookie(a))).toBeNull();
});
it("expires at five minutes, loses attempts on restart and supports explicit cleanup", async () => {
  let at = 1000;
  const store = createOidcTransactions(config, transport, { now: () => at });
  const a = await store.begin();
  at += 300000;
  expect(store.consume(a.state, cookie(a))).toBeNull();
  const b = await store.begin();
  expect(
    createOidcTransactions(config, transport).consume(b.state, cookie(b)),
  ).toBeNull();
  store.clear();
  expect(store.consume(b.state, cookie(b))).toBeNull();
});
it("bounds parallel attempts per browser and globally without evicting valid attempts", async () => {
  const store = createOidcTransactions(config, transport, {
    capacity: 3,
    perBrowser: 2,
  });
  const a = await store.begin();
  const attempts = await Promise.all([
    store.begin(cookie(a)),
    store.begin(cookie(a)),
  ]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  const b = await store.begin();
  expect(b).not.toBeNull();
  expect(await store.begin()).toBeNull();
  expect(store.consume(a.state, cookie(a))).not.toBeNull();
  expect(await store.begin()).not.toBeNull();
});
