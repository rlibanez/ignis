import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
const require = createRequire(import.meta.url);
const express = require("express");
const { createSecurity } = require("../../app/create-security");
const { readAuthConfig } = require("../http-policy");
const { openDatabase } = require("../../platform/persistence/database");
const { bootstrapAdmin } = require("../store");
const { hashPassword } = require("../password");
const ORIGIN = "http://localhost:8080";
const certPath = new URL("./fixtures/localhost-cert.pem", import.meta.url);
let idp,
  issuer,
  pair,
  jwk,
  hash,
  root,
  db,
  boundary,
  server,
  port,
  tokenRequests,
  callbackClaims;
const codes = new Map();
let providerUnavailable = false, discoveryRequests = 0;
beforeAll(async () => {
  hash = await hashPassword("synthetic-passphrase");
  pair = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "one", alg: "RS256" };
  idp = https.createServer(
    {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(
        new URL("./fixtures/localhost-key.pem", import.meta.url),
      ),
    },
    async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/openid-configuration") {
        discoveryRequests++;
        if (providerUnavailable) {
          res.writeHead(503);
          res.end("{}");
          return;
        }
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: issuer + "/authorize",
            token_endpoint: issuer + "/token",
            jwks_uri: issuer + "/keys",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            authorization_response_iss_parameter_supported: true,
          }),
        );
        return;
      }
      if (req.url === "/keys") {
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url !== "/token") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      tokenRequests++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const entry = codes.get(params.get("code"));
      codes.delete(params.get("code"));
      if (
        !entry ||
        createHash("sha256")
          .update(params.get("code_verifier") ?? "")
          .digest("base64url") !== entry.challenge ||
        params.get("redirect_uri") !== ORIGIN + "/api/auth/oidc/callback"
      ) {
        res.writeHead(400);
        res.end('{"error":"invalid_grant"}');
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({
        iss: issuer,
        sub: "external",
        aud: "ignis",
        iat: now,
        exp: now + 300,
        nonce: entry.nonce,
        auth_time: now,
        preferred_username: "external",
        email: "external@example.com",
        email_verified: true,
        ...callbackClaims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "one" })
        .sign(pair.privateKey);
      res.end(
        JSON.stringify({
          access_token: "SYNTHETIC_ACCESS_SECRET",
          token_type: "Bearer",
          id_token: jwt,
        }),
      );
    },
  );
  await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
  issuer = `https://oidc.test.invalid:${idp.address().port}`;
});
afterAll(async () => {
  idp.closeAllConnections();
  await new Promise((resolve) => idp.close(resolve));
});
function environment() {
  return {
    IGNIS_OIDC_ENABLED: "true",
    IGNIS_OIDC_ISSUER: issuer,
    IGNIS_OIDC_CLIENT_ID: "ignis",
    IGNIS_OIDC_CLIENT_SECRET: "SYNTHETIC_CLIENT_SECRET",
    IGNIS_OIDC_AUTO_PROVISION: "true",
    IGNIS_OIDC_PRIVATE_ADDRESSES: JSON.stringify({ [issuer]: ["127.0.0.1"] }),
    IGNIS_OIDC_CA_FILE: certPath.pathname,
  };
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-oidc-http-"));
  db = openDatabase(root);
  bootstrapAdmin(db, "admin", hash);
  tokenRequests = 0;
  providerUnavailable = true;
  discoveryRequests = 0;
  callbackClaims = {};
  codes.clear();
  boundary = createSecurity({
    dataRoot: root,
    config: readAuthConfig({
      IGNIS_PUBLIC_ORIGIN: ORIGIN,
      IGNIS_ALLOW_HTTP_LOOPBACK: "true",
    }),
    oidcEnv: environment(),
    oidcDependencies: {
      lookup: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]),
    },
  });
  await boundary.initialize();
  expect(discoveryRequests).toBe(0);
  providerUnavailable = false;
  const app = express();
  boundary.install(app);
  app.get("/api/vault/list", (_req, res) => res.json([]));
  app.get("/", (_req,res)=>res.type("html").send("<!doctype html><title>Ignis</title>"));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  boundary.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
async function request(route, jar = {}, method = "GET", body, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          host: "localhost:8080",
          cookie: Object.entries(jar)
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          ...(body ? { "content-type": "application/json" } : {}),
          ...extra,
        },
      },
      (res) => {
        for (const cookie of res.headers["set-cookie"] || []) {
          const [name, value] = cookie.split(";")[0].split("=");
          jar[name] = value;
        }
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function post(route, jar, body = {}) {
  const csrf = (await request("/api/auth/csrf", jar)).json().csrfToken;
  return request(route, jar, "POST", body, {
    origin: ORIGIN,
    "x-ignis-csrf": csrf,
  });
}
function providerCallback(authorizationUrl) {
  const authorize = new URL(authorizationUrl);
  const code = randomUUID();
  codes.set(code, {
    challenge: authorize.searchParams.get("code_challenge"),
    nonce: authorize.searchParams.get("nonce"),
  });
  return (
    "/api/auth/oidc/callback?" +
    new URLSearchParams({
      code,
      state: authorize.searchParams.get("state"),
      iss: issuer,
    })
  );
}
it("performs cross-site callback, provisions a normal account and sets only an opaque session cookie", async () => {
  const jar = {};
  expect((await request("/api/auth/status")).json().oidcAvailable).toBe(true);
  const start = await post("/api/auth/oidc/start", jar);
  expect(start.status).toBe(200);
  const callback = providerCallback(start.json().authorizationUrl);
  const result = await request(callback, jar, "GET", undefined, {
    "sec-fetch-site": "cross-site",
  });
  expect(result.status).toBe(303);
  expect(result.headers.location).toBe("/");
  const landing = await request(result.headers.location, jar, "GET", undefined, {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  });
  expect(landing.status).toBe(200);
  expect(landing.headers["content-type"]).toContain("text/html");
  expect(result.headers["set-cookie"].join(";")).toContain("HttpOnly");
  expect(result.text).not.toContain("SYNTHETIC");
  expect(jar["ignis-dev-session"]).toMatch(/^[a-f0-9]{64}$/);
  expect((await request("/api/auth/session", jar)).json().user.role).toBe(
    "user",
  );
  expect((await request("/api/vault/list", jar)).status).toBe(200);
  expect(
    (
      await request(callback, jar, "GET", undefined, {
        "sec-fetch-site": "cross-site",
      })
    ).headers.location,
  ).toBe("/login?oidc=failed");
  expect(tokenRequests).toBe(1);
});
it("requires POST, Origin and CSRF to start either flow", async () => {
  expect((await request("/api/auth/oidc/start")).status).toBe(404);
  expect(
    (await request("/api/auth/oidc/start", {}, "POST", {}, { origin: ORIGIN }))
      .status,
  ).toBe(403);
  expect((await post("/api/auth/oidc/link", {})).status).toBe(403);
  expect(
    (
      await request("/api/auth/status", {}, "GET", undefined, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/auth/oidc/callback/", {}, "GET", undefined, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403);
});
it("does not consume a legitimate callback when the browser binding is missing", async () => {
  const jar = {};
  const start = await post("/api/auth/oidc/start", jar);
  const callback = providerCallback(start.json().authorizationUrl);
  expect((await request(callback)).headers.location).toBe("/login?oidc=failed");
  expect(tokenRequests).toBe(0);
  expect((await request(callback, jar)).headers.location).toBe(
    "/",
  );
});
it("manually links an administrator only from its existing recent session", async () => {
  const jar = {};
  expect(
    (
      await post("/api/auth/login", jar, {
        login: "admin",
        password: "synthetic-passphrase",
      })
    ).status,
  ).toBe(200);
  const listing = (await request("/api/auth/users", jar)).json();
  expect(listing.oidcAvailable).toBe(true);
  const before = listing.users;
  expect(before.find((user) => user.login === "admin").oidcLinked).toBe(false);
  const oldToken = jar["ignis-dev-session"];
  const start = await post("/api/auth/oidc/link", jar);
  expect(start.status).toBe(200);
  const authorize = new URL(start.json().authorizationUrl);
  expect(authorize.searchParams.get("max_age")).toBe("30");
  const result = await request(
    providerCallback(authorize.href),
    jar,
    "GET",
    undefined,
    { "sec-fetch-site": "cross-site" },
  );
  expect(result.headers.location).toBe("/?manage=account");
  const landing = await request(result.headers.location, jar, "GET", undefined, {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  });
  expect(landing.status).toBe(200);
  expect(landing.headers["content-type"]).toContain("text/html");
  expect(jar["ignis-dev-session"]).not.toBe(oldToken);
  const after = (await request("/api/auth/users", jar)).json().users;
  expect(after.find((user) => user.login === "admin").oidcLinked).toBe(true);
  for (const user of after) {
    expect(Object.keys(user).sort()).toEqual(["canSetLocalPassword", "email", "email_trust", "hasLocalPassword", "id", "login", "oidcLinked", "password_change_required", "role", "status"]);
  }
  expect((await request("/api/auth/session", jar)).json()).toMatchObject({
    user: { role: "admin" },
    oidcLinked: true,
  });
  expect(
    (await request("/api/auth/session", { "ignis-dev-session": oldToken }))
      .status,
  ).toBe(401);
});
it("rejects callbacks if the initiating session was replaced", async () => {
  const jar = {};
  await post("/api/auth/login", jar, {
    login: "admin",
    password: "synthetic-passphrase",
  });
  const start = await post("/api/auth/oidc/link", jar);
  await post("/api/auth/logout", jar);
  expect(
    (await request(providerCallback(start.json().authorizationUrl), jar))
      .headers.location,
  ).toBe("/login?oidc=failed");
  expect(tokenRequests).toBe(0);
});
it("keeps provider errors and invalid claims out of responses", async () => {
  const jar = {};
  const start = await post("/api/auth/oidc/start", jar);
  callbackClaims = { aud: "wrong" };
  const result = await request(
    providerCallback(start.json().authorizationUrl),
    jar,
  );
  expect(result.headers.location).toBe("/login?oidc=failed");
  expect(result.headers["set-cookie"]).toBeUndefined();
  expect(result.text).not.toContain("SYNTHETIC");
});
it("serves account UI and fixed public assets without exposing provider secrets", async () => {
  for (const route of ["/login", "/auth/login.js"]) {
    const res = await request(route);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("SYNTHETIC_CLIENT_SECRET");
    expect(res.headers["cache-control"]).toBe("no-store");
  }
});
it("rejects invalid enabled startup configuration", async () => {
  const other = createSecurity({
    dataRoot: root,
    config: readAuthConfig({
      IGNIS_PUBLIC_ORIGIN: ORIGIN,
      IGNIS_ALLOW_HTTP_LOOPBACK: "true",
    }),
    oidcEnv: { ...environment(), IGNIS_OIDC_ISSUER: "http://unsafe.example" },
  });
  try {
    await expect(other.initialize()).rejects.toThrow();
  } finally {
    other.close();
  }
});

it("bounds repeated OIDC starts and validates network configuration without exposing paths", async () => {
  const jar = {};
  for (let i = 0; i < 10; i++) await post("/api/auth/oidc/start", jar);
  expect((await post("/api/auth/oidc/start", jar)).status).toBe(429);
  const { readNetworkOptions } = require("./runtime");
  for (const env of [
    { IGNIS_OIDC_ALLOWED_ORIGINS: "{}" },
    { IGNIS_OIDC_PRIVATE_ADDRESSES: "[]" },
    { IGNIS_OIDC_PRIVATE_ADDRESSES: "null" },
    { IGNIS_OIDC_CA_FILE: "/missing/synthetic-secret" },
    { IGNIS_OIDC_ALLOWED_ORIGINS: "x".repeat(16385) },
  ])
    expect(() => readNetworkOptions(env)).toThrow(
      /^Invalid OIDC network configuration$/,
    );
});
it("does not accept a fabricated callback or redirect to an attacker destination", async () => {
  const result = await request(
    "/api/auth/oidc/callback?code=SYNTHETIC_SECRET&state=" +
      "a".repeat(43) +
      "&returnTo=https://attacker.invalid",
    {},
    "GET",
    undefined,
    { "sec-fetch-site": "cross-site" },
  );
  expect(result.headers.location).toBe("/login?oidc=failed");
  expect(result.headers["set-cookie"]).toBeUndefined();
  expect(tokenRequests).toBe(0);
});

it("asks for reauthentication before starting a link with an old local authentication", async () => {
  const jar = {};
  await post("/api/auth/login", jar, {
    login: "admin", password: "synthetic-passphrase",
  });
  db.exec("UPDATE sessions SET authenticated_at = authenticated_at - 300001");
  const result = await post("/api/auth/oidc/link", jar);
  expect(result.status).toBe(403);
  expect(result.json().code).toBe("REAUTH_REQUIRED");
  expect(result.json()).not.toHaveProperty("authorizationUrl");
  expect(tokenRequests).toBe(0);
});

it("lets the administrator unlink its own current provider and sign in locally again", async () => {
  const jar = {};
  await post("/api/auth/login", jar, { login: "admin", password: "synthetic-passphrase" });
  const start = await post("/api/auth/oidc/link", jar);
  await request(providerCallback(start.json().authorizationUrl), jar, "GET", undefined, { "sec-fetch-site": "cross-site" });
  const user = (await request("/api/auth/session", jar)).json().user;
  expect((await request("/api/auth/session", jar)).json().oidcLinked).toBe(true);
  const result = await post("/api/auth/users/unlink-oidc", jar, { userId: user.id });
  expect(result.status).toBe(200);
  expect(result.json()).toEqual({ unlinked: true, signedOut: true });
  expect((await request("/api/auth/session", jar)).status).toBe(401);
  expect(db.prepare("SELECT count(*) n FROM oidc_identities WHERE user_id=? AND issuer=?").get(user.id, issuer).n).toBe(0);
  expect((await post("/api/auth/login", jar, { login: "admin", password: "synthetic-passphrase" })).status).toBe(200);
  expect((await request("/api/auth/session", jar)).json().oidcLinked).toBe(false);
});
it("protects external-only accounts and rejects untrusted unlink input", async () => {
  const jar = {};
  await post("/api/auth/login", jar, { login: "admin", password: "synthetic-passphrase" });
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('external-only','external-only','user',0)");
  db.prepare("INSERT INTO oidc_identities VALUES (?, 'external-only', 'external-only', 0)").run(issuer);
  const body = { userId: "external-only" };
  const rejected = await post("/api/auth/users/unlink-oidc", jar, body);
  expect(rejected.status).toBe(400);
  expect(rejected.json().code).toBe("LOCAL_PASSWORD_REQUIRED");
  expect((await post("/api/auth/users/unlink-oidc", {}, body)).status).toBe(401);
  expect((await post("/api/auth/users/unlink-oidc", jar, { ...body, issuer: "https://other.example" })).status).toBe(400);
  db.exec("UPDATE sessions SET authenticated_at = authenticated_at - 300001");
  const stale = await post("/api/auth/users/unlink-oidc", jar, body);
  expect(stale.status).toBe(403);
  expect(stale.json().code).toBe("REAUTH_REQUIRED");
  expect(db.prepare("SELECT count(*) n FROM oidc_identities WHERE user_id='external-only'").get().n).toBe(1);
});

it("keeps local access during a provider outage and recovers without restarting", async () => {
  providerUnavailable = true;
  const jar = {};
  expect((await post("/api/auth/login", jar, {
    login: "admin", password: "synthetic-passphrase",
  })).status).toBe(200);
  const failed = await post("/api/auth/oidc/link", jar);
  expect(failed.status).toBe(503);
  expect(failed.json().error).toBe("OpenID Connect is unavailable; try again later");
  expect((await request("/api/auth/users", jar)).status).toBe(200);
  expect((await post("/api/auth/oidc/start", {})).status).toBe(503);
  providerUnavailable = false;
  const linked = await post("/api/auth/oidc/link", jar);
  expect(linked.status).toBe(200);
  expect((await request(providerCallback(linked.json().authorizationUrl), jar)).status).toBe(303);
});

it("does not contact discovery for unsolicited callbacks", async () => {
  await request("/api/auth/oidc/callback?state=" + "a".repeat(43) + "&code=invalid");
  expect(discoveryRequests).toBe(0);
});

it("shares initialization between concurrent OIDC attempts", async () => {
  const results = await Promise.all(Array.from({ length: 3 }, () => post("/api/auth/oidc/start", {})));
  expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
  expect(discoveryRequests).toBe(1);
});

it("limits cross-site landing exceptions to public top-level GET documents", async () => {
  const headers = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  for (const route of ["/api/auth/session", "/api/auth/csrf", "/api/auth/users", "/api/vault/list", "/account/", "/login/"]) {
    expect((await request(route, {}, "GET", undefined, headers)).status).toBe(403);
  }
  for (const route of ["/login", "/account"]) {
    expect((await request(route, {}, "POST", {}, headers)).status).toBe(403);
    expect((await request(route, {}, "GET", undefined, { ...headers, "sec-fetch-dest": "iframe" })).status).toBe(403);
    expect((await request(route, {}, "GET", undefined, { ...headers, "sec-fetch-mode": "cors" })).status).toBe(403);
    expect((await request(route, {}, "GET", undefined, { ...headers, host: "wrong.invalid" })).status).toBe(403);
  }
});

it("OIDC reauthentication preserves the administrator and rejects another provider identity", async () => {
  const jar = {};
  await post("/api/auth/login", jar, { login: "admin", password: "synthetic-passphrase" });
  const initial = (await request("/api/auth/session", jar)).json();
  db.prepare("INSERT INTO oidc_identities VALUES (?, 'external', ?, 0)").run(issuer, initial.user.id);
  // Linking invalidates the old session, so start with a new local session.
  await post("/api/auth/login", jar, { login: "admin", password: "synthetic-passphrase" });
  async function begin() {
    const session = (await request("/api/auth/session", jar)).json();
    const token = (await request("/api/auth/csrf", jar)).json().csrfToken;
    return request("/api/auth/oidc/reauth", jar, "POST", {}, {
      origin: ORIGIN, "x-ignis-csrf": token, "x-ignis-context": session.sessionId,
    });
  }
  const start = await begin();
  expect(start.status).toBe(200);
  expect(new URL(start.json().authorizationUrl).searchParams.get("max_age")).toBe("30");
  callbackClaims = { sub: "someone-else" };
  expect((await request(providerCallback(start.json().authorizationUrl), jar)).headers.location).toBe("/login?oidc=failed");
  expect((await request("/api/auth/session", jar)).json().user.id).toBe(initial.user.id);
  expect(db.prepare("SELECT count(*) n FROM users").get().n).toBe(1);
  callbackClaims = {};
  const again = await begin();
  const before = jar["ignis-dev-session"];
  const completed = await request(providerCallback(again.json().authorizationUrl), jar);
  expect(completed.headers.location).toBe("/?manage=users&reauth=success");
  expect(jar["ignis-dev-session"]).not.toBe(before);
  expect((await request("/api/auth/session", jar)).json().user.id).toBe(initial.user.id);
  expect((await request(completed.headers.location, jar, "GET", undefined, {
    "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
  })).status).toBe(200);
});

it('binds remember-me to the OIDC transaction and resumes without contacting the provider',async()=>{
 const jar={};const start=await post('/api/auth/oidc/start',jar,{rememberMe:true});expect(start.status).toBe(200);
 const callback=await request(providerCallback(start.json().authorizationUrl),jar,'GET',undefined,{'sec-fetch-site':'cross-site'});
 expect(callback.status).toBe(303);expect(jar['ignis-dev-remember']).toMatch(/^[a-f0-9]{64}$/);
 const original=(await request('/api/auth/session',jar)).json();
 delete jar['ignis-dev-session'];providerUnavailable=true;
 const restored=await request('/api/auth/session',jar);expect(restored.status).toBe(200);expect(restored.json().sessionId).toBe(original.sessionId);
 expect(tokenRequests).toBe(1);
 const saved={...jar};db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(original.user.id);
 expect((await request('/api/auth/session',saved)).status).toBe(401);
});
it('does not let callback query parameters enable persistence',async()=>{
 const jar={};const start=await post('/api/auth/oidc/start',jar);
 const result=await request(providerCallback(start.json().authorizationUrl)+'&rememberMe=true',jar,'GET',undefined,{'sec-fetch-site':'cross-site'});
 // Protocol may reject the extra parameter; either result must not mint a device grant.
 expect([302,303]).toContain(result.status);expect(jar['ignis-dev-remember'] || '').toBe('');
 expect(db.prepare('SELECT count(*) n FROM remembered_sessions').get().n).toBe(0);
});

it('lets a normal OIDC user reauthenticate and set only their own first password',async()=>{
 const jar={};
 const login=await post('/api/auth/oidc/start',jar);
 await request(providerCallback(login.json().authorizationUrl),jar);
 const initial=(await request('/api/auth/session',jar)).json();expect(initial.user.role).toBe('user');
 const send=async(route,body,extra={})=>{
  const current=(await request('/api/auth/session',jar)).json();
  const csrf=(await request('/api/auth/csrf',jar)).json().csrfToken;
  return request(route,jar,'POST',body,{origin:ORIGIN,'x-ignis-csrf':csrf,'x-ignis-context':current.sessionId,...extra});
 };
 expect((await send('/api/auth/password',{newPassword:'new-local-password!'})).json().code).toBe('REAUTH_REQUIRED');
 expect((await send('/api/auth/oidc/reauth',{})).status).toBe(403);
 const start=await send('/api/auth/oidc/reauth',{purpose:'password'});
 expect(start.status).toBe(200);expect(new URL(start.json().authorizationUrl).searchParams.get('max_age')).toBe('30');
 callbackClaims={sub:'different'};
 expect((await request(providerCallback(start.json().authorizationUrl),jar)).headers.location).toBe('/login?oidc=failed');
 callbackClaims={};
 const retry=await send('/api/auth/oidc/reauth',{purpose:'password'});
 expect((await request(providerCallback(retry.json().authorizationUrl),jar)).headers.location).toBe('/?manage=password');
 expect((await request('/?manage=password',jar,'GET',undefined,{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'})).status).toBe(200);
 const body={newPassword:'new-local-password!'};
 expect((await send('/api/auth/password',body,{'x-ignis-csrf':'invalid'})).status).toBe(403);
 expect((await send('/api/auth/password',body,{'x-ignis-context':'wrong'})).status).toBe(409);
 expect((await send('/api/auth/password',{...body,userId:'admin'})).status).toBe(400);
 db.exec('UPDATE sessions SET authenticated_at=authenticated_at-300001');
 expect((await send('/api/auth/password',body)).json().code).toBe('REAUTH_REQUIRED');
 const again=await send('/api/auth/oidc/reauth',{purpose:'password'});
 await request(providerCallback(again.json().authorizationUrl),jar);
 const other={...jar};
 expect((await send('/api/auth/password',body)).status).toBe(200);
 expect((await request('/api/auth/session',jar)).status).toBe(401);
 expect((await request('/api/auth/session',other)).status).toBe(401);
 expect(db.prepare('SELECT user_id FROM oidc_identities WHERE user_id=?').get(initial.user.id)).toBeTruthy();
 expect((await post('/api/auth/login',jar,{login:initial.user.login,password:body.newPassword})).status).toBe(200);
 expect((await send('/api/auth/password',{newPassword:'another-password!'})).status).not.toBe(200);
});

it("allows normal users to unlink only themselves after fresh local password verification", async () => {
  const jar = {};
  const start = await post("/api/auth/oidc/start", jar);
  await request(providerCallback(start.json().authorizationUrl), jar, "GET", undefined, { "sec-fetch-site": "cross-site" });
  const session = (await request("/api/auth/session", jar)).json();
  const send = async (body, headers = {}) => {
    const csrf = (await request("/api/auth/csrf", jar)).json().csrfToken;
    return request("/api/auth/oidc/unlink", jar, "POST", body, {
      origin: ORIGIN, "x-ignis-csrf": csrf, "x-ignis-context": session.sessionId, ...headers,
    });
  };
  expect((await send({ password: "synthetic-passphrase" })).status).toBe(400);
  db.prepare("INSERT INTO local_credentials (user_id,password_hash,updated_at) VALUES (?,?,?)").run(session.user.id, hash, Date.now());
  // Credential creation invalidates old sessions; sign in again with the local password.
  await post("/api/auth/login", jar, { login: session.user.login, password: "synthetic-passphrase" });
  Object.assign(session, (await request("/api/auth/session", jar)).json());
  expect((await send({ password: "wrong" })).status).toBe(400);
  expect((await send({ password: "synthetic-passphrase", userId: "another-user" })).status).toBe(400);
  expect((await send({ password: "synthetic-passphrase" }, { origin: "https://evil.example" })).status).toBe(403);
  expect((await send({ password: "synthetic-passphrase" }, { "x-ignis-csrf": "invalid" })).status).toBe(403);
  expect((await send({ password: "synthetic-passphrase" }, { "x-ignis-context": "stale" })).status).toBe(409);
  expect(db.prepare("SELECT count(*) n FROM oidc_identities WHERE user_id=?").get(session.user.id).n).toBe(1);
  const result = await send({ password: "synthetic-passphrase" });
  expect(result.status).toBe(200);
  expect(result.json().signedOut).toBe(true);
  expect(db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?").get(session.user.id).n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM oidc_identities WHERE user_id=?").get(session.user.id).n).toBe(0);
  expect((await request("/api/auth/session", jar)).status).toBe(401);
  expect((await post("/api/auth/login", jar, { login: session.user.login, password: "synthetic-passphrase" })).status).toBe(200);
});

it('reauthenticates a normal linked identity for email without granting admin or password setup',async()=>{
 const jar={};const login=await post('/api/auth/oidc/start',jar);
 await request(providerCallback(login.json().authorizationUrl),jar);
 const initial=(await request('/api/auth/session',jar)).json();
 const send=async(route,body)=>{
  const current=(await request('/api/auth/session',jar)).json();
  const csrf=(await request('/api/auth/csrf',jar)).json().csrfToken;
  return request(route,jar,'POST',body,{origin:ORIGIN,'x-ignis-csrf':csrf,'x-ignis-context':current.sessionId});
 };
 db.exec('UPDATE sessions SET authenticated_at=authenticated_at-300001');
 const email={email:'changed@example.com',expectedEmail:initial.email,expectedEmailTrust:initial.emailTrust};
 expect((await send('/api/auth/email',email)).json().code).toBe('REAUTH_REQUIRED');
 const wrong=await send('/api/auth/oidc/reauth',{purpose:'email'});expect(wrong.status).toBe(200);
 callbackClaims={sub:'different'};
 expect((await request(providerCallback(wrong.json().authorizationUrl),jar)).headers.location).toBe('/login?oidc=failed');
 callbackClaims={};
 const start=await send('/api/auth/oidc/reauth',{purpose:'email'});
 expect((await request(providerCallback(start.json().authorizationUrl),jar)).headers.location).toBe('/?manage=email');
 const current=(await request('/api/auth/session',jar)).json();expect(current.user.id).toBe(initial.user.id);expect(current.oidcLinked).toBe(true);
 expect((await send('/api/auth/password',{newPassword:'new-local-password!'})).json().code).toBe('REAUTH_REQUIRED');
 expect((await request('/api/auth/users',jar)).status).toBe(403);
 expect((await send('/api/auth/email',email)).status).toBe(200);
 expect((await request('/api/auth/session',jar)).status).toBe(401);
 expect(db.prepare('SELECT email_trust FROM users WHERE id=?').get(initial.user.id).email_trust).toBe('unverified');
});
