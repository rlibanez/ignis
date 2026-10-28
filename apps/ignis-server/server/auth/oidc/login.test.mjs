import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import https from "node:https";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
const require = createRequire(import.meta.url);
const { readOidcConfig } = require("./config");
const { initializeOidcClient } = require("./discovery");
const { createOidcLogin } = require("./login");
const cert = fs.readFileSync(
  new URL("./fixtures/localhost-cert.pem", import.meta.url),
);
const key = fs.readFileSync(
  new URL("./fixtures/localhost-key.pem", import.meta.url),
);
const policy = {
  publicOrigin: "https://ignis.example",
  allowHttpLoopback: false,
};
let server,
  origin,
  config,
  pair,
  second,
  jwk,
  otherJwk,
  keys,
  keyRequests,
  tokenRequests,
  keyStatus = 200;
const codes = new Map();
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  second = await generateKeyPair("RS256");
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "one",
    alg: "RS256",
    use: "sig",
  };
  otherJwk = {
    ...(await exportJWK(second.publicKey)),
    kid: "two",
    alg: "RS256",
    use: "sig",
  };
  server = https.createServer({ key, cert }, async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          jwks_uri: origin + "/keys",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          authorization_response_iss_parameter_supported: true,
        }),
      );
      return;
    }
    if (req.url === "/keys") {
      keyRequests++;
      res.statusCode = keyStatus;
      res.end(JSON.stringify({ keys }));
      return;
    }
    if (req.url !== "/token") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    tokenRequests++;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const params = new URLSearchParams(raw);
    const entry = codes.get(params.get("code"));
    codes.delete(params.get("code"));
    if (
      !entry ||
      createHash("sha256")
        .update(params.get("code_verifier") ?? "")
        .digest("base64url") !== entry.challenge ||
      params.get("redirect_uri") !== config.redirectUri ||
      !req.headers.authorization?.startsWith("Basic ")
    ) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    res.end(
      JSON.stringify({
        access_token: "synthetic-access",
        token_type: "Bearer",
        ...(entry.token === null ? {} : { id_token: entry.token }),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://oidc.test.invalid:${server.address().port}`;
  config = readOidcConfig(
    {
      IGNIS_OIDC_ENABLED: "true",
      IGNIS_OIDC_ISSUER: origin,
      IGNIS_OIDC_CLIENT_ID: "ignis",
      IGNIS_OIDC_CLIENT_SECRET: "synthetic-secret",
    },
    policy,
  );
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
async function flow() {
  keys = [jwk];
  keyRequests = 0;
  tokenRequests = 0;
  keyStatus = 200;
  codes.clear();
  const instance = await initializeOidcClient(
    config,
    { ca: cert, privateAddresses: { [origin]: ["127.0.0.1"] } },
    { lookup: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) },
  );
  return createOidcLogin(config, instance, policy);
}
async function attempt(
  login,
  {
    claims: patch = {},
    header = {},
    signer = pair.privateKey,
    token,
    hashes = false,
    cookie,
  } = {},
) {
  const begin = await login.begin(cookie);
  const authorize = new URL(begin.url);
  const code = randomUUID();
  const seconds = Math.floor(Date.now() / 1000);
  const claims = {
    iss: origin,
    sub: "external-user",
    aud: "ignis",
    iat: seconds,
    exp: seconds + 300,
    nonce: authorize.searchParams.get("nonce"),
    ...patch,
  };
  if (hashes) {
    for (const [name, value] of [
      ["at_hash", "synthetic-access"],
      ["c_hash", code],
    ])
      claims[name] = createHash("sha256")
        .update(value)
        .digest()
        .subarray(0, 16)
        .toString("base64url");
  }
  const signed =
    token !== undefined
      ? token
      : await new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: "one", ...header })
          .sign(signer);
  codes.set(code, {
    token: signed,
    challenge: authorize.searchParams.get("code_challenge"),
  });
  const callback = new URL(config.redirectUri);
  callback.search = new URLSearchParams({
    code,
    state: authorize.searchParams.get("state"),
    iss: origin,
  }).toString();
  return { callback, cookie: begin.cookie.split(";")[0], authorize, code };
}
const complete = (login, a) => login.complete(a.callback, a.cookie);
it("completes a signed code flow and returns only the stable external identity", async () => {
  const login = await flow();
  const a = await attempt(login, {
    claims: { email: "admin@example.test", roles: ["admin"] },
  });
  expect(a.authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(a.authorize.searchParams.get("scope")).toBe("openid");
  expect(a.authorize.searchParams.has("client_secret")).toBe(false);
  expect(await complete(login, a)).toEqual({
    issuer: origin,
    subject: "external-user",
  });
  expect(keyRequests).toBe(1);
  await expect(complete(login, a)).rejects.toThrow(
    /^OIDC authentication failed$/,
  );
  expect(tokenRequests).toBe(1);
});
it.each([
  ["issuer", { iss: "https://wrong.invalid" }],
  ["audience", { aud: "other" }],
  ["multiple audiences without azp", { aud: ["ignis", "other"] }],
  ["single audience with wrong azp", { azp: "other" }],
  ["nonce", { nonce: "other" }],
  ["missing nonce", { nonce: undefined }],
  ["multiple audiences wrong azp", { aud: ["ignis", "other"], azp: "other" }],
  ["expired", { exp: 1 }],
  ["future iat", { iat: 9999999999 }],
  ["old iat", { iat: 1 }],
  ["future nbf", { nbf: 9999999999 }],
  ["empty sub", { sub: "" }],
  ["long sub", { sub: "a".repeat(256) }],
  ["nonstring sub", { sub: 5 }],
  ["missing sub", { sub: undefined }],
  ["missing exp", { exp: undefined }],
  ["missing iat", { iat: undefined }],
  ["access hash", { at_hash: "bad" }],
  ["code hash", { c_hash: "bad" }],
])("rejects invalid %s with no reusable transaction", async (_name, claims) => {
  const login = await flow();
  const a = await attempt(login, { claims });
  await expect(complete(login, a)).rejects.toThrow(
    /^OIDC authentication failed$/,
  );
  await expect(complete(login, a)).rejects.toThrow();
  expect(tokenRequests).toBe(1);
});
it("accepts multiple audiences only with the correct authorized party and valid optional hash", async () => {
  const login = await flow();
  const a = await attempt(login, {
    claims: {
      aud: ["ignis", "other"],
      azp: "ignis",
      at_hash: createHash("sha256")
        .update("synthetic-access")
        .digest()
        .subarray(0, 16)
        .toString("base64url"),
    },
  });
  expect(await complete(login, a)).toHaveProperty("subject", "external-user");
});
it("rejects a bad signature despite a valid TLS token response", async () => {
  const login = await flow();
  const a = await attempt(login, { signer: second.privateKey });
  await expect(complete(login, a)).rejects.toThrow();
  expect(keyRequests).toBe(1);
});
it.each([null, "eyJhbGciOiJub25lIn0.e30.", "broken.jwt"])(
  "rejects absent or unsupported ID tokens: %s",
  async (token) => {
    const login = await flow();
    const a = await attempt(login, { token });
    await expect(complete(login, a)).rejects.toThrow();
  },
);
it("does not use token jku or x5u as a key authority", async () => {
  const login = await flow();
  const a = await attempt(login, {
    header: {
      jku: "https://169.254.169.254/keys",
      x5u: "https://attacker.invalid",
    },
  });
  expect(await complete(login, a)).toHaveProperty("subject");
  expect(keyRequests).toBe(1);
});
it("rejects wrong browsers, duplicate parameters and foreign callbacks before exchange", async () => {
  const login = await flow();
  const a = await attempt(login);
  await expect(login.complete(a.callback, "")).rejects.toThrow();
  const duplicate = new URL(a.callback);
  duplicate.searchParams.append("state", duplicate.searchParams.get("state"));
  await expect(login.complete(duplicate, a.cookie)).rejects.toThrow();
  const foreign = new URL(a.callback);
  foreign.hostname = "attacker.invalid";
  await expect(login.complete(foreign, a.cookie)).rejects.toThrow();
  expect(tokenRequests).toBe(0);
  expect(await complete(login, a)).toHaveProperty("subject");
});
it("burns cancellations and PKCE failures and isolates concurrent attempts", async () => {
  const login = await flow();
  const a = await attempt(login);
  a.callback.searchParams.delete("code");
  a.callback.searchParams.set("error", "access_denied");
  await expect(complete(login, a)).rejects.toThrow();
  await expect(complete(login, a)).rejects.toThrow();
  expect(tokenRequests).toBe(0);
  const b = await attempt(login);
  const c = await attempt(login, { cookie: b.cookie });
  codes.get(b.code).challenge = "wrong";
  await expect(complete(login, b)).rejects.toThrow();
  expect(await complete(login, c)).toHaveProperty("subject");
});
it("allows only one of two concurrent callbacks to exchange the code", async () => {
  const login = await flow();
  const a = await attempt(login);
  const results = await Promise.allSettled([
    complete(login, a),
    complete(login, a),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(tokenRequests).toBe(1);
});
it("bounds unknown-key refresh and accepts rotation after cooldown", async () => {
  let time = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const login = await flow();
    await complete(login, await attempt(login));
    keys = [otherJwk];
    for (let i = 0; i < 3; i++)
      await expect(
        complete(
          login,
          await attempt(login, {
            signer: second.privateKey,
            header: { kid: "two" },
          }),
        ),
      ).rejects.toThrow();
    expect(keyRequests).toBe(1);
    time += 61000;
    expect(
      await complete(
        login,
        await attempt(login, {
          signer: second.privateKey,
          header: { kid: "two" },
        }),
      ),
    ).toHaveProperty("subject");
    expect(keyRequests).toBe(2);
  } finally {
    spy.mockRestore();
  }
});
it("bounds repeated failed key downloads", async () => {
  const login = await flow();
  keyStatus = 503;
  for (let i = 0; i < 3; i++)
    await expect(complete(login, await attempt(login))).rejects.toThrow();
  expect(keyRequests).toBe(1);
});
it.each(["too many", "private", "ambiguous"])(
  "rejects %s JWKS",
  async (kind) => {
    const login = await flow();
    keys =
      kind === "too many"
        ? Array(33).fill(jwk)
        : kind === "private"
          ? [{ ...jwk, d: "private" }]
          : [jwk, jwk];
    await expect(complete(login, await attempt(login))).rejects.toThrow();
  },
);

it("accepts valid optional access-token and code hashes", async () => {
  const login = await flow();
  expect(
    await complete(login, await attempt(login, { hashes: true })),
  ).toHaveProperty("subject");
});
it("rejects HS256 rather than treating the client secret as a signing key", async () => {
  const login = await flow();
  const a = await attempt(login, {
    header: { alg: "HS256" },
    signer: new TextEncoder().encode("synthetic-secret"),
  });
  await expect(complete(login, a)).rejects.toThrow();
  expect(keyRequests).toBe(0);
});
it("rejects expired and cleared transactions without exchange", async () => {
  let time = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const login = await flow();
    const a = await attempt(login);
    time += 300001;
    await expect(complete(login, a)).rejects.toThrow();
    const b = await attempt(login);
    login.clear();
    await expect(complete(login, b)).rejects.toThrow();
    expect(tokenRequests).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it("returns only requested matching claims and requires boolean email verification", async () => {
  await flow();
  const scoped = {
    ...config,
    clientSecret: config.clientSecret,
    scope: "openid profile email",
  };
  const instance = await initializeOidcClient(
    scoped,
    { ca: cert, privateAddresses: { [origin]: ["127.0.0.1"] } },
    { lookup: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) },
  );
  const login = await createOidcLogin(scoped, instance, policy);
  expect(
    await complete(
      login,
      await attempt(login, {
        claims: {
          preferred_username: "person",
          email: "person@example.com",
          email_verified: "true",
          roles: ["admin"],
        },
      }),
    ),
  ).toEqual({
    issuer: origin,
    subject: "external-user",
    preferredUsername: "person",
    email: "person@example.com",
    emailVerified: false,
  });
});
async function manualFixture() {
  await flow();
  const db = new DatabaseSync(":memory:");
  for (const migration of require("../schema")) db.exec(migration.sql);
  db.prepare(
    "INSERT INTO users(id,login,role,created_at) VALUES ('local','local','admin',0)",
  ).run();
  db.prepare(
    "INSERT INTO oidc_identities VALUES ('https://previous.example','old','local',0)",
  ).run();
  const sessions = require("../sessions").createSessionService(db);
  const issued = sessions.issueForVerifiedOidcIdentity({
    issuer: "https://previous.example",
    subject: "old",
    authenticatedAt: Date.now(),
  });
  const instance = await initializeOidcClient(
    config,
    { ca: cert, privateAddresses: { [origin]: ["127.0.0.1"] } },
    { lookup: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) },
  );
  const manual = await require("./manual-link").createManualOidcLink(
    db,
    config,
    instance,
    policy,
    sessions,
  );
  const wrapper = { begin: (cookie) => manual.begin(issued.token, cookie) };
  return { db, sessions, issued, manual, wrapper };
}
it("manually links after fresh provider authentication and revokes old sessions", async () => {
  const f = await manualFixture();
  try {
    const a = await attempt(f.wrapper, {
      claims: { auth_time: Math.floor(Date.now() / 1000) },
    });
    expect(a.authorize.searchParams.get("prompt")).toBe("login");
    expect(a.authorize.searchParams.get("max_age")).toBe("0");
    await expect(
      f.manual.complete(a.callback, a.cookie, "wrong-token"),
    ).rejects.toThrow();
    const result = await f.manual.complete(
      a.callback,
      a.cookie,
      f.issued.token,
    );
    expect(result.userId).toBe("local");
    expect(result.authentication.token).not.toBe(f.issued.token);
    expect(f.sessions.resolve(result.authentication.token).user.id).toBe(
      "local",
    );
    expect(
      f.db
        .prepare("SELECT user_id FROM oidc_identities WHERE issuer=?")
        .get(origin).user_id,
    ).toBe("local");
    expect(f.sessions.resolve(f.issued.token)).toBeNull();
    await expect(
      f.manual.complete(a.callback, a.cookie, f.issued.token),
    ).rejects.toThrow();
  } finally {
    f.db.close();
  }
});
it.each([undefined, 1, 9999999999])(
  "rejects manual linking without fresh auth_time: %s",
  async (authTime) => {
    const f = await manualFixture();
    try {
      const a = await attempt(f.wrapper, { claims: { auth_time: authTime } });
      await expect(
        f.manual.complete(a.callback, a.cookie, f.issued.token),
      ).rejects.toThrow();
      expect(
        f.db
          .prepare("SELECT count(*) n FROM oidc_identities WHERE issuer=?")
          .get(origin).n,
      ).toBe(0);
    } finally {
      f.db.close();
    }
  },
);
it("rejects manual linking when the local session changes during the provider round trip", async () => {
  const f = await manualFixture();
  try {
    const a = await attempt(f.wrapper, {
      claims: { auth_time: Math.floor(Date.now() / 1000) },
    });
    f.sessions.revoke(f.issued.token);
    await expect(
      f.manual.complete(a.callback, a.cookie, f.issued.token),
    ).rejects.toThrow();
    expect(tokenRequests).toBe(0);
  } finally {
    f.db.close();
  }
});

it("provisions from verified claims and issues an opaque normal-user session", async () => {
  await flow();
  const db = new DatabaseSync(":memory:");
  try {
    for (const m of require("../schema")) db.exec(m.sql);
    db.prepare(
      "INSERT INTO users(id,login,role,created_at) VALUES ('setup-admin','setup-admin','admin',0)",
    ).run();
    const scoped = {
      ...config,
      clientSecret: config.clientSecret,
      scope: "openid profile email",
      autoProvision: true,
      accountLinking: "disabled",
    };
    const instance = await initializeOidcClient(
      scoped,
      { ca: cert, privateAddresses: { [origin]: ["127.0.0.1"] } },
      {
        lookup: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]),
      },
    );
    const sessions = require("../sessions").createSessionService(db);
    const login = await require("./account-login").createOidcAccountLogin(
      db,
      scoped,
      instance,
      policy,
      sessions,
    );
    const a = await attempt(login, {
      claims: {
        preferred_username: "newuser",
        email: "new@example.com",
        email_verified: true,
        roles: ["admin"],
      },
    });
    const result = await complete(login, a);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(sessions.resolve(result.token).user).toMatchObject({
      login: "newuser",
      role: "user",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-access");
    db.prepare("UPDATE users SET status='disabled' WHERE role='user'").run();
    const b = await attempt(login, {
      claims: { preferred_username: "newuser" },
    });
    await expect(complete(login, b)).rejects.toThrow();
    expect(
      db.prepare("SELECT count(*) n FROM users WHERE role='user'").get().n,
    ).toBe(1);
  } finally {
    db.close();
  }
});
it("email changes invalidate existing sessions and stale sessions cannot start manual linking", async () => {
  const f = await manualFixture();
  try {
    const old = f.sessions.issueForVerifiedOidcIdentity({
      issuer: "https://previous.example",
      subject: "old",
      authenticatedAt: Date.now() - 300001,
    });
    await expect(f.manual.begin(old.token)).rejects.toThrow();
    require("../email").setUserEmail(
      f.db,
      "local",
      "admin@example.com",
      "admin_confirmed",
    );
    expect(f.sessions.resolve(f.issued.token)).toBeNull();
    await expect(f.manual.begin(f.issued.token)).rejects.toThrow();
  } finally {
    f.db.close();
  }
});
