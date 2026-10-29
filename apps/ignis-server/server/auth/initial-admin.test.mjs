import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
const express = require("express");
const { readAuthConfig } = require("./http-policy");
const {
  readInitialAdminKey,
  createInitialAdminSetup,
} = require("./initial-admin");
const { createAuthBoundary } = require("./http");
const { openDatabase } = require("./database");
const { bootstrapAdmin } = require("./store");
const { hashPassword } = require("./password");
const KEY = randomBytes(16).toString("hex");
const OTHER = randomBytes(16).toString("hex");
const PASSWORD = "synthetic setup test password";
let root, db, server, boundary, hash;
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-setup-"));
  db = openDatabase(root);
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  boundary?.close();
  server = null;
  boundary = null;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const body = (changes = {}) => ({
  initialAdminKey: KEY,
  login: "Admin",
  password: PASSWORD,
  passwordConfirmation: PASSWORD,
  ...changes,
});
const service = (key = KEY) =>
  createInitialAdminSetup(db, {
    keyDigest: readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY: key }),
    initialized: () => !!db.prepare("SELECT 1 FROM bootstrap_state").get(),
  });
function count(table) {
  return db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
}
async function start(key = KEY, policyEnv = {}) {
  boundary = createAuthBoundary({
    dataRoot: root,
    config: readAuthConfig({
      IGNIS_PUBLIC_ORIGIN: "http://localhost:8080",
      IGNIS_ALLOW_HTTP_LOOPBACK: "true",
      IGNIS_INITIAL_ADMIN_KEY: key,
      ...policyEnv,
    }),
  });
  const app = express();
  boundary.install(app);
  app.use(boundary.errorHandler);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function request(route, jar = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: route,
        method: options.method || "GET",
        headers: {
          host: "localhost:8080",
          origin: "http://localhost:8080",
          cookie: Object.entries(jar)
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          "content-type": "application/json",
          ...options.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          for (const cookie of res.headers["set-cookie"] || []) {
            const [k, v] = cookie.split(";")[0].split("=");
            jar[k] = v;
          }
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      },
    );
    req.on("error", reject);
    req.end(
      options.raw ?? (options.body ? JSON.stringify(options.body) : undefined),
    );
  });
}
async function challenge(jar) {
  return JSON.parse((await request("/api/auth/csrf", jar)).text).csrfToken;
}
async function submit(jar, changes = {}, headers = {}) {
  return request("/api/auth/setup", jar, {
    method: "POST",
    headers: { "x-ignis-csrf": await challenge(jar), ...headers },
    body: body(changes),
  });
}

describe("initial key configuration", () => {
  it("disables setup without a secret and does not retain plaintext", () => {
    expect(readInitialAdminKey({})).toBeNull();
    expect(readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY: "" })).toBeNull();
    expect(readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY: KEY })).toHaveLength(
      32,
    );
    expect(
      readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY: KEY }).toString("hex"),
    ).not.toBe(KEY);
  });
  it("accepts a bounded file with one optional LF or CRLF", () => {
    const file = path.join(root, "key");
    for (const suffix of ["", "\n", "\r\n"]) {
      fs.writeFileSync(file, KEY + suffix, { mode: 0o600 });
      expect(
        readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY_FILE: file }),
      ).toEqual(readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY: KEY }));
    }
    fs.writeFileSync(file, "");
    expect(
      readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY_FILE: file }),
    ).toBeNull();
    expect(
      readInitialAdminKey({
        IGNIS_INITIAL_ADMIN_KEY_FILE: path.join(root, "missing"),
      }),
    ).toBeNull();
  });
  it("rejects conflicting, malformed and oversized sources without exposing values", () => {
    for (const env of [
      {
        IGNIS_INITIAL_ADMIN_KEY: KEY,
        IGNIS_INITIAL_ADMIN_KEY_FILE: "/secret/location",
      },
      { IGNIS_INITIAL_ADMIN_KEY: "SECRET_BAD_FORMAT" },
    ]) {
      try {
        readInitialAdminKey(env);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error.message).toMatch(/initial admin key/);
        expect(error.message).not.toContain(KEY);
        expect(error.message).not.toContain("SECRET_BAD_FORMAT");
      }
    }
    const file = path.join(root, "key");
    for (const value of [KEY + "\n\n", "x".repeat(1000)]) {
      fs.writeFileSync(file, value);
      expect(() =>
        readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY_FILE: file }),
      ).toThrow(/Invalid initial admin key/);
    }
  });
});
it("disables web setup for an unreadable key without preventing CLI bootstrap", () => {
  const file = path.join(root, "unreadable-key");
  fs.writeFileSync(file, KEY, { mode: 0o000 });
  try {
    expect(
      readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY_FILE: file }),
    ).toBeNull();
    bootstrapAdmin(db, "cli-admin", hash);
    expect(count("users")).toBe(1);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});
describe("initial administrator transaction", () => {
  it("rejects disabled, missing and incorrect keys without side effects", async () => {
    expect((await service("").create(body())).status).toBe(403);
    for (const value of [undefined, "", OTHER, [], {}])
      expect(
        (await service().create(body({ initialAdminKey: value }))).status,
      ).toBe(403);
    expect(count("users")).toBe(0);
    expect(count("sessions")).toBe(0);
  });
  it("validates account details and confirmation before creating records", async () => {
    for (const changes of [
      { login: ".." },
      { password: "short", passwordConfirmation: "short" },
      { passwordConfirmation: "different" },
      { password: "x".repeat(1025), passwordConfirmation: "x".repeat(1025) },
    ])
      expect((await service().create(body(changes))).status).toBe(400);
    expect(count("users")).toBe(0);
    expect(count("local_credentials")).toBe(0);
    expect(count("bootstrap_state")).toBe(0);
  });
  it("creates one local administrator with audit but no automatic session, and cannot reopen", async () => {
    expect((await service().create(body())).status).toBe(201);
    expect(db.prepare("SELECT login, role FROM users").get()).toEqual({
      login: "admin",
      role: "admin",
    });
    expect(count("local_credentials")).toBe(1);
    expect(count("bootstrap_state")).toBe(1);
    expect(count("audit_events")).toBe(1);
    expect(count("sessions")).toBe(0);
    expect(
      (await service(OTHER).create(body({ initialAdminKey: OTHER }))).status,
    ).toBe(409);
    expect((await service("").create(body())).status).toBe(409);
    expect(count("users")).toBe(1);
  });
  it("chooses exactly one winner for two concurrent web attempts", async () => {
    const instance = service();
    const results = await Promise.all([
      instance.create(body()),
      instance.create(body({ login: "other" })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(count("users")).toBe(1);
    expect(count("audit_events")).toBe(1);
  });
  it("rechecks the transaction when the CLI wins during password hashing", async () => {
    const pending = service().create(body());
    const otherDb = openDatabase(root);
    try {
      bootstrapAdmin(otherDb, "cli-admin", hash);
    } finally {
      otherDb.close();
    }
    expect((await pending).status).toBe(409);
    expect(db.prepare("SELECT login FROM users").get().login).toBe("cli-admin");
    expect(count("users")).toBe(1);
  });
  it("accepts only the configured key after rotation", async () => {
    const instance = service(OTHER);
    expect((await instance.create(body())).status).toBe(403);
    expect(
      (await instance.create(body({ initialAdminKey: OTHER }))).status,
    ).toBe(201);
  });
});
describe("setup HTTP boundary", () => {
  it("serves only a minimal CSP-protected shell and exposes no installation secret", async () => {
    await start();
    const status = await request("/api/auth/status");
    expect(JSON.parse(status.text)).toEqual({
      initialized: false,
      setupAvailable: true,
      passwordPolicy: { minLength: 8, minSpecialChars: 0, maxBytes: 1024 },
    });
    expect((await request("/")).headers.location).toBe("/setup");
    for (const route of ["/setup", "/auth/setup.js", "/auth/setup.css"]) {
      const result = await request(route);
      expect(result.status).toBe(200);
      expect(result.text).not.toContain(KEY);
      expect(result.text).not.toContain(PASSWORD);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
    }
    for (const route of [
      "/api/vault/list",
      "/api/bootstrap",
      "/vault-files/Team/note.md",
      "/auth/other.js",
    ])
      expect((await request(route)).status).toBe(401);
    expect(count("users")).toBe(0);
  });
  it("keeps the CLI usable when web setup is disabled", async () => {
    await start("");
    expect(
      JSON.parse((await request("/api/auth/status")).text).setupAvailable,
    ).toBe(false);
    expect((await submit({})).status).toBe(403);
    bootstrapAdmin(db, "cli-admin", hash);
    expect(
      JSON.parse((await request("/api/auth/status")).text).initialized,
    ).toBe(true);
  });
  it("requires CSRF, same origin and bounded JSON before setup", async () => {
    await start();
    const jar = {};
    expect(
      (await request("/api/auth/setup", jar, { method: "POST", body: body() }))
        .status,
    ).toBe(403);
    expect(
      (await submit(jar, {}, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await submit(jar, {}, { origin: "" })).status).toBe(403);
    expect(
      (await request("/api/auth/setup", jar, { method: "POST", raw: "{" }))
        .status,
    ).toBe(400);
    expect(
      (
        await request("/api/auth/setup", jar, {
          method: "POST",
          body: { padding: "x".repeat(9000) },
        })
      ).status,
    ).toBe(413);
    expect(count("users")).toBe(0);
  });
  it("bounds setup attempts even with spoofed forwarded IPs", async () => {
    await start();
    const jar = {};
    for (let i = 0; i < 5; i++)
      expect(
        (
          await submit(
            jar,
            { initialAdminKey: OTHER },
            { "x-forwarded-for": `198.51.100.${i}` },
          )
        ).status,
      ).toBe(403);
    const response = await submit(jar);
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("900");
    expect(count("users")).toBe(0);
  });
  it("closes setup persistently and requires a separate login", async () => {
    await start();
    const jar = {};
    const result = await submit(jar);
    expect(result.status).toBe(201);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(count("sessions")).toBe(0);
    expect((await request("/api/auth/session", jar)).status).toBe(401);
    await new Promise((resolve) => server.close(resolve));
    server = null;
    boundary.close();
    boundary = null;
    await start(OTHER);
    expect(JSON.parse((await request("/api/auth/status")).text)).toEqual({
      initialized: true,
      setupAvailable: false,
      passwordPolicy: { minLength: 8, minSpecialChars: 0, maxBytes: 1024 },
    });
    expect((await submit(jar, { initialAdminKey: OTHER })).status).toBe(409);
    expect(count("users")).toBe(1);
    const login = await request("/api/auth/login", jar, {
      method: "POST",
      headers: { "x-ignis-csrf": await challenge(jar) },
      body: { login: "admin", password: PASSWORD },
    });
    expect(login.status).toBe(200);
  });
});

it("advertises and enforces configured password rules in direct setup requests", async () => {
  await start(KEY, {
    IGNIS_PASSWORD_MIN_LENGTH: "10",
    IGNIS_PASSWORD_MIN_SPECIAL_CHARS: "1",
  });
  expect(
    JSON.parse((await request("/api/auth/status")).text).passwordPolicy,
  ).toEqual({ minLength: 10, minSpecialChars: 1, maxBytes: 1024 });
  const jar = {};
  for (const password of ["abcdefgh!", "abcdefghij"]) {
    expect(
      (await submit(jar, { password, passwordConfirmation: password })).status,
    ).toBe(400);
    expect(count("users")).toBe(0);
  }
  expect(
    (
      await submit(jar, {
        password: "abcdefghi!",
        passwordConfirmation: "abcdefghi!",
      })
    ).status,
  ).toBe(201);
});
it("accepts a 16-byte hex key and rejects shorter or old 32-byte keys", () => {
  expect(readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY: KEY })).toHaveLength(
    32,
  );
  for (const value of [KEY.slice(2), KEY + KEY])
    expect(() =>
      readInitialAdminKey({ IGNIS_INITIAL_ADMIN_KEY: value }),
    ).toThrow(/format/);
});
