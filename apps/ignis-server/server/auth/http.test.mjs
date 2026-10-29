import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
const require = createRequire(import.meta.url);
const express = require("express");
const { WebSocket } = require("ws");
const { setupWebSocket, watcher } = require("@ignis/server-core");
const { createAuthBoundary } = require("./http");
const { readAuthConfig, permittedResource } = require("./http-policy");
const { openDatabase } = require("./database");
const { bootstrapAdmin } = require("./store");
const { hashPassword } = require("./password");
const ORIGIN = "http://localhost:8080";
const PASSWORD = "synthetic integration passphrase";
let root, db, boundary, server, wss, base, hash, clock, beforeRouting;
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-http-auth-"));
  fs.mkdirSync(path.join(root, "vault"));
  fs.writeFileSync(path.join(root, "vault", "note.md"), "private note");
  db = openDatabase(path.join(root, "data"));
  bootstrapAdmin(db, "admin", hash);
  db.prepare(
    "INSERT INTO users(id,login,role,created_at) VALUES ('normal','normal','user',1)",
  ).run();
  db.prepare("INSERT INTO local_credentials VALUES ('normal',?,1)").run(hash);
  clock = Date.now();
  const app = express();
  boundary = createAuthBoundary({
    dataRoot: path.join(root, "data"),
    config: readAuthConfig({
      IGNIS_PUBLIC_ORIGIN: ORIGIN,
      IGNIS_ALLOW_HTTP_LOOPBACK: "true",
    }),
    now: () => clock,
  });
  beforeRouting = () => {};
  boundary.install(app);
  app.use(express.json());
  app.use((req, res, next) => {
    beforeRouting();
    next();
  });
  app.use(boundary.revalidate);
  app.get("/api/vault/list", (req, res) => res.json(["private vault"]));
  app.post("/api/fs/writeFile", (req, res) => res.json({ ok: true }));
  app.get("/api/settings", () => {
    throw new Error("secret internal failure");
  });
  app.get("/api/new-unclassified", (req, res) =>
    res.send("should never be reached"),
  );
  app.get("/api/ext/unknown/secret", (req, res) =>
    res.send("should never be reached"),
  );
  app.use(boundary.errorHandler);
  server = http.createServer(app);
  wss = setupWebSocket(server, {
    getVaultPath: (id) => (id === "vault" ? path.join(root, "vault") : null),
    security: boundary.wsSecurity,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  boundary.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  watcher.stopWatching("vault");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function request(
  route,
  { jar = {}, method = "GET", headers = {}, body } = {},
) {
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      base + route,
      {
        method,
        headers: {
          host: "localhost:8080",
          origin: ORIGIN,
          cookie: Object.entries(jar)
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          const parsed = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            parsed.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          resolve({
            status: res.statusCode,
            headers: parsed,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined)
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
  for (const value of result.headers.getSetCookie()) {
    const [key, token] = value.split(";")[0].split("=");
    jar[key] = token;
  }
  return result;
}
async function csrf(jar) {
  const response = await request("/api/auth/csrf", { jar });
  expect(response.status).toBe(200);
  return (await response.json()).csrfToken;
}
async function login(user = "admin", password = PASSWORD) {
  const jar = {};
  const token = await csrf(jar);
  const result = await request("/api/auth/login", {
    jar,
    method: "POST",
    body: { login: user, password },
    headers: { "x-ignis-csrf": token },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).not.toHaveProperty("token");
  return jar;
}
function connect(jar = {}, origin = ORIGIN) {
  return new WebSocket(base.replace("http:", "ws:") + "/ws?vault=vault", {
    headers: {
      host: "localhost:8080",
      origin,
      cookie: Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
}
async function rejectedSocket(jar, origin) {
  const ws = connect(jar, origin);
  const result = await new Promise((resolve) => {
    ws.on("unexpected-response", (req, res) => {
      res.resume();
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.on("error", () => {});
  });
  return result;
}

describe("HTTP boundary", () => {
  it("rechecks revocation after body parsing and before route execution", async () => {
    const jar = await login();
    const token = await csrf(jar);
    beforeRouting = () => db.prepare("DELETE FROM sessions").run();
    const response = await request("/api/fs/writeFile", {
      jar,
      method: "POST",
      body: {},
      headers: { "x-ignis-csrf": token },
    });
    expect(response.status).toBe(401);
  });
  it("stops response chunks after session revocation", async () => {
    const jar = await login();
    const identity = await (await request("/api/auth/session", { jar })).json();
    const session = db
      .prepare("SELECT id FROM sessions WHERE user_id = ?")
      .get(identity.user.id);
    const req = {
      headers: {
        cookie: Object.entries(jar)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
      auth: { id: session.id },
    };
    const output = [];
    let destroyed = false;
    const res = {
      write: (chunk) => {
        output.push(chunk);
        return true;
      },
      end: () => {},
      destroy: () => {
        destroyed = true;
      },
    };
    boundary.revalidate(req, res, () => {});
    expect(res.write("authorized chunk")).toBe(true);
    db.prepare("DELETE FROM sessions").run();
    expect(res.write("must not escape")).toBe(false);
    expect(destroyed).toBe(true);
    expect(output).toEqual(["authorized chunk"]);
  });
  it("blocks every anonymous data surface, including methods and direct resources", async () => {
    for (const [method, route] of [
      ["GET", "/"],
      ["HEAD", "/index.html"],
      ["GET", "/app.js"],
      ["GET", "/api/bootstrap"],
      ["GET", "/api/fs/readFile?path=note.md"],
      ["GET", "/vault-files/vault/note.md"],
      ["GET", "/api/fs/download-zip"],
      ["POST", "/api/fs/batch-read"],
      ["POST", "/api/proxy"],
      ["GET", "/api/settings"],
      ["GET", "/api/plugins"],
      ["GET", "/api/ext/headless-sync/status"],
    ]) {
      const response = await request(route, {
        method,
        ...(method === "POST" ? { body: {} } : {}),
      });
      expect(response.status, route).toBe(
        ["/", "/index.html"].includes(route) ? 303 : 401,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("allows local login and admin reads, but leaves normal accounts without data access", async () => {
    const admin = await login();
    expect((await request("/api/vault/list", { jar: admin })).status).toBe(200);
    const normal = await login("normal");
    expect((await request("/api/auth/session", { jar: normal })).status).toBe(
      200,
    );
    for (const route of [
      "/",
      "/api/vault/list",
      "/api/settings",
      "/vault-files/vault/note.md",
    ]) {
      expect((await request(route, { jar: normal })).status).toBe(403);
    }
  });
  it("requires same-origin CSRF proof bound to the current browser and session", async () => {
    const jar = await login();
    const token = await csrf(jar);
    const mutation = {
      jar,
      method: "POST",
      body: {},
      headers: { "x-ignis-csrf": token },
    };
    expect((await request("/api/fs/writeFile", mutation)).status).toBe(200);
    expect(
      (await request("/api/fs/writeFile", { ...mutation, headers: {} })).status,
    ).toBe(403);
    expect(
      (
        await request("/api/fs/writeFile", {
          ...mutation,
          headers: { ...mutation.headers, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const other = await login();
    expect(
      (await request("/api/fs/writeFile", { ...mutation, jar: other })).status,
    ).toBe(403);
    expect(
      (
        await request("/api/auth/login", {
          method: "POST",
          body: { login: "admin", password: PASSWORD },
        })
      ).status,
    ).toBe(403);
  });
  it("logout revokes the bearer and prelogin CSRF cannot be replayed after authentication", async () => {
    const jar = await login();
    const saved = { ...jar };
    const token = await csrf(jar);
    const result = await request("/api/auth/logout", {
      jar,
      method: "POST",
      body: {},
      headers: { "x-ignis-csrf": token },
    });
    expect(result.status).toBe(204);
    expect(jar["ignis-dev-session"]).toBe("");
    expect((await request("/api/vault/list", { jar: saved })).status).toBe(401);
  });
  it("denies unclassified routes and sanitizes unexpected errors", async () => {
    const jar = await login();
    for (const route of [
      "/api/new-unclassified",
      "/api/ext/unknown/secret",
      "/api/auth/callback",
    ]) {
      expect((await request(route, { jar })).status).toBe(404);
    }
    const error = await request("/api/settings", { jar });
    expect(error.status).toBe(500);
    expect(await error.text()).not.toContain("secret internal");
  });
  it("does not trust forwarded host/proto to override the configured origin", async () => {
    const result = await request("/api/auth/status", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "localhost:8080",
        "x-forwarded-proto": "https",
      },
    });
    expect(result.status).toBe(403);
    expect(
      (await request("/api/auth/status", { headers: { origin: "null" } }))
        .status,
    ).toBe(403);
  });
  it("rejects malformed JSON, oversized login bodies and non-JSON requests without leaks", async () => {
    const jar = {};
    const token = await csrf(jar);
    for (const [body, status, headers] of [
      ["{bad", 400, {}],
      ["x".repeat(9000), 413, {}],
      [
        "login=admin",
        415,
        { "content-type": "application/x-www-form-urlencoded" },
      ],
    ]) {
      const res = await request("/api/auth/login", {
        jar,
        method: "POST",
        body,
        headers: { "x-ignis-csrf": token, ...headers },
      });
      expect(res.status).toBe(status);
      expect(await res.text()).not.toContain(body.slice(0, 20));
    }
  });
  it("limits attempts across accounts despite spoofed forwarding headers", async () => {
    const jar = {};
    const token = await csrf(jar);
    for (let i = 0; i < 10; i++) {
      const res = await request("/api/auth/login", {
        jar,
        method: "POST",
        body: { login: `missing${i}`, password: "" },
        headers: { "x-ignis-csrf": token, "x-forwarded-for": `192.0.2.${i}` },
      });
      expect(res.status).toBe(401);
    }
    const limited = await request("/api/auth/login", {
      jar,
      method: "POST",
      body: { login: "admin", password: PASSWORD },
      headers: { "x-ignis-csrf": token },
    });
    expect(limited.status).toBe(429);
  });
  it("expires HTTP sessions and rejects disabled users", async () => {
    const jar = await login("normal");
    db.exec("UPDATE users SET status = 'disabled' WHERE id = 'normal'");
    expect((await request("/api/auth/session", { jar })).status).toBe(401);
    const admin = await login();
    clock += 30 * 60000;
    expect((await request("/api/vault/list", { jar: admin })).status).toBe(401);
  });
});

describe("WebSocket boundary", () => {
  it("rejects anonymous, non-admin and foreign-origin handshakes", async () => {
    expect(await rejectedSocket({})).toBe(401);
    expect(await rejectedSocket(await login("normal"))).toBe(401);
    expect(await rejectedSocket(await login(), "https://evil.example")).toBe(
      401,
    );
  });
  it("blocks outgoing messages immediately after revocation and closes the connection", async () => {
    const ws = connect(await login());
    await once(ws, "open");
    let received = false;
    ws.on("message", () => {
      received = true;
    });
    const closed = once(ws, "close");
    db.exec(
      "UPDATE users SET auth_version = auth_version + 1 WHERE login = 'admin'",
    );
    wss.broadcastToVault("vault", {
      type: "modified",
      path: "must-not-arrive.md",
    });
    await closed;
    expect(received).toBe(false);
  });
  it("closes idle sockets on revocation without waiting for traffic", async () => {
    const ws = connect(await login());
    await once(ws, "open");
    const closed = once(ws, "close");
    db.exec("DELETE FROM sessions");
    await closed;
  });
  it("validates each incoming message and rejects unknown channels", async () => {
    const ws = connect(await login());
    await once(ws, "open");
    const message = once(ws, "message");
    ws.send(JSON.stringify({ type: "subscribe-channel", channel: "metadata" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    wss
      .channel("metadata")
      .broadcastToVault("vault", { type: "revision", etag: "ok" });
    expect(JSON.parse((await message)[0].toString()).etag).toBe("ok");
    const closed = once(ws, "close");
    ws.send(JSON.stringify({ type: "subscribe-channel", channel: "unknown" }));
    await closed;
  });
});

it("requires an explicit origin and narrow proxy configuration", () => {
  expect(() => readAuthConfig({})).toThrow();
  for (const value of ["true", "1", '["all"]', '["127.0.0.1/99"]']) {
    expect(() =>
      readAuthConfig({
        IGNIS_PUBLIC_ORIGIN: ORIGIN,
        IGNIS_TRUSTED_PROXIES: value,
      }),
    ).toThrow();
  }
  expect(
    readAuthConfig({
      IGNIS_PUBLIC_ORIGIN: "https://ignis.example",
      IGNIS_TRUSTED_PROXIES: '["127.0.0.1/32"]',
    }).trustedProxies,
  ).toEqual(["127.0.0.1/32"]);
});

describe("startup and proxy policy", () => {
  it("blocks uninitialized installations and invalid bootstrap state", async () => {
    const emptyRoot = path.join(root, "empty");
    const pending = createAuthBoundary({
      dataRoot: emptyRoot,
      config: readAuthConfig({
        IGNIS_PUBLIC_ORIGIN: ORIGIN,
        IGNIS_ALLOW_HTTP_LOOPBACK: "true",
      }),
    });
    const app = express();
    pending.install(app);
    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const previous = base;
    base = `http://127.0.0.1:${listener.address().port}`;
    try {
      const status = await request("/api/auth/status");
      expect(await status.json()).toEqual({
        initialized: false,
        setupAvailable: false,
      });
      expect((await request("/api/vault/list")).status).toBe(401);
    } finally {
      base = previous;
      pending.close();
      await new Promise((resolve) => listener.close(resolve));
    }
    const inconsistent = openDatabase(emptyRoot);
    inconsistent.exec(
      "INSERT INTO users(id,login,role,created_at) VALUES ('broken','broken','user',1)",
    );
    inconsistent.close();
    expect(() =>
      createAuthBoundary({
        dataRoot: emptyRoot,
        config: readAuthConfig({
          IGNIS_PUBLIC_ORIGIN: ORIGIN,
          IGNIS_ALLOW_HTTP_LOOPBACK: "true",
        }),
      }),
    ).toThrow();
  });
  it("only trusts TLS forwarding from an explicitly trusted peer", async () => {
    for (const trusted of [[], ["127.0.0.1/32"]]) {
      const b = createAuthBoundary({
        dataRoot: path.join(root, "data"),
        config: readAuthConfig({
          IGNIS_PUBLIC_ORIGIN: "https://ignis.example",
          IGNIS_TRUSTED_PROXIES: JSON.stringify(trusted),
        }),
      });
      const app = express();
      b.install(app);
      const listener = app.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const previous = base;
      base = `http://127.0.0.1:${listener.address().port}`;
      try {
        const response = await request("/api/auth/status", {
          headers: {
            host: "ignis.example",
            origin: "https://ignis.example",
            "x-forwarded-proto": "https",
          },
        });
        expect(response.status).toBe(trusted.length ? 200 : 403);
      } finally {
        base = previous;
        b.close();
        await new Promise((resolve) => listener.close(resolve));
      }
    }
  });
});

it("maps mounted static resources without allowing traversal or unknown API routes", () => {
  const roots = [{ root: path.join(root, "vault"), mount: "/assets/" }];
  expect(permittedResource("GET", "/assets/note.md", roots)).toBe(true);
  expect(permittedResource("GET", "/note.md", roots)).toBe(false);
  expect(permittedResource("POST", "/assets/note.md", roots)).toBe(false);
  expect(
    permittedResource("GET", "/assets/../data/auth/identity.sqlite", roots),
  ).toBe(false);
  expect(permittedResource("GET", "/api/unclassified", roots)).toBe(false);
});

it("rejects requests and sockets carrying a previous browser session context", async () => {
  const jar = await login();
  const session = await (await request("/api/auth/session", { jar })).json();
  expect(
    (
      await request("/api/vault/list", {
        jar,
        headers: { "x-ignis-context": session.sessionId },
      })
    ).status,
  ).toBe(200);
  const stale = await request("/api/fs/writeFile", {
    jar,
    method: "POST",
    body: {},
    headers: {
      "x-ignis-context": "previous-session",
      "x-ignis-csrf": await csrf(jar),
    },
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).code).toBe("AUTH_CONTEXT_CHANGED");
  const req = {
    headers: {
      host: "localhost:8080",
      origin: ORIGIN,
      cookie: Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
    socket: { remoteAddress: "127.0.0.1" },
    url: "/ws?vault=vault&context=old",
  };
  expect(boundary.wsSecurity.verify(req)).toBe(false);
  req.url = "/ws?vault=vault&context=" + session.sessionId;
  expect(boundary.wsSecurity.verify(req)).toBe(true);
});
it("serves login assets without exposing the app to unauthenticated clients", async () => {
  for (const route of ["/login", "/auth/login.js", "/auth/client.js"]) {
    const response = await request(route);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect((await request("/")).headers.get("location")).toBe("/login");
});

describe("user administration HTTP", () => {
  it("denies anonymous and normal users both listing and creation", async () => {
    for (const jar of [{}, await login("normal")]) {
      const expected = Object.keys(jar).length ? 403 : 401;
      expect((await request("/api/auth/users", { jar })).status).toBe(expected);
      expect((await request("/api/auth/users", {
        jar, method: "POST", body: { login: "new-user", password: PASSWORD },
      })).status).toBe(expected);
    }
  });

  it("creates a normal user with CSRF and lists only public account fields", async () => {
    const jar = await login();
    const body = { login: "new-user", password: PASSWORD };
    expect((await request("/api/auth/users", {
      jar, method: "POST", body,
    })).status).toBe(403);
    const headers = { "x-ignis-csrf": await csrf(jar) };
    expect((await request("/api/auth/users", {
      jar, method: "POST", headers: { ...headers, origin: "https://evil.example" }, body,
    })).status).toBe(403);
    expect((await request("/api/auth/users", {
      jar, method: "POST", headers, body: { ...body, role: "admin" },
    })).status).toBe(400);
    const created = await request("/api/auth/users", { jar, method: "POST", headers, body });
    expect(created.status).toBe(201);
    const { user } = await created.json();
    expect(user.role).toBe("user");
    expect(db.prepare("SELECT count(*) n FROM memberships WHERE user_id=?").get(user.id).n).toBe(0);
    const listed = await request("/api/auth/users", { jar });
    expect(listed.status).toBe(200);
    for (const row of (await listed.json()).users)
      expect(Object.keys(row).sort()).toEqual(["canSetLocalPassword", "email", "email_trust", "hasLocalPassword", "id", "login", "oidcLinked", "role", "status"]);
    expect((await listed.json()).oidcAvailable).toBe(false);
    expect((await listed.json()).users.every((row) => row.oidcLinked === null)).toBe(true);
    const normalJar = await login("new-user");
    expect((await request("/api/vault/list", { jar: normalJar })).status).toBe(403);
  });

  it("rejects stale admin authentication before creating an account", async () => {
    const jar = await login();
    expect((await (await request("/api/auth/session", { jar })).json()).recentAuthentication).toBe(true);
    clock += 300001;
    expect((await (await request("/api/auth/session", { jar })).json()).recentAuthentication).toBe(false);
    const result = await request("/api/auth/users", {
      jar, method: "POST", headers: { "x-ignis-csrf": await csrf(jar) },
      body: { login: "new-user", password: PASSWORD },
    });
    expect(result.status).toBe(403);
    expect((await result.json()).code).toBe("REAUTH_REQUIRED");
    expect(db.prepare("SELECT id FROM users WHERE login='new-user'").get()).toBeUndefined();
  });
});

it("rejects user administration from a stale browser context", async () => {
  const jar = await login();
  const headers = { "x-ignis-context": "previous-session" };
  expect((await request("/api/auth/users", { jar, headers })).status).toBe(409);
  expect((await request("/api/auth/users", {
    jar, method: "POST",
    headers: { ...headers, "x-ignis-csrf": await csrf(jar) },
    body: { login: "new-user", password: PASSWORD },
  })).status).toBe(409);
  expect(db.prepare("SELECT id FROM users WHERE login='new-user'").get()).toBeUndefined();
});

it("serves the administrative UI without embedding account data", async () => {
  const page = await request("/admin/users");
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await page.text()).toContain('id="administration" hidden');
  expect((await request("/auth/users.js")).status).toBe(200);
  expect((await request("/api/auth/users")).status).toBe(401);
});

it("serves the shared favicon anonymously for authentication and administration pages", async () => {
  for (const route of ["/setup", "/login", "/account", "/admin/users"]) {
    const page = await request(route);
    expect(await page.text()).toContain('rel="icon" type="image/png" href="/favicon.png"');
    expect(page.headers.get("content-security-policy")).toContain("img-src 'self'");
  }
  const icon = await request("/favicon.png");
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toContain("image/png");
  expect(Number(icon.headers.get("content-length"))).toBe(
    fs.statSync(new URL("../../../../images/favicon.png", import.meta.url)).size,
  );
  expect((await request("/favicon.png", { method: "HEAD" })).status).toBe(200);
  expect((await request("/images/favicon.png")).status).toBe(401);
});

describe("account status administration", () => {
  async function update(jar, body, headers = {}) {
    return request("/api/auth/users/status", {
      jar, method: "POST", body,
      headers: { "x-ignis-csrf": await csrf(jar), ...headers },
    });
  }
  it("revokes target sessions, blocks login and permits reactivation without restoring sessions", async () => {
    const admin = await login();
    const normal = await login("normal");
    const body = { userId: "normal", status: "disabled", expectedStatus: "active" };
    expect((await update(admin, body)).status).toBe(200);
    expect((await request("/api/auth/session", { jar: normal })).status).toBe(401);
    const denied = await request("/api/auth/login", {
      jar: normal, method: "POST", headers: { "x-ignis-csrf": await csrf(normal) },
      body: { login: "normal", password: PASSWORD },
    });
    expect(denied.status).toBe(401);
    expect((await update(admin, body)).status).toBe(409);
    expect((await update(admin, { ...body, status: "active", expectedStatus: "disabled" })).status).toBe(200);
    expect((await request("/api/auth/session", { jar: normal })).status).toBe(401);
    await login("normal");
  });
  it("enforces authorization, CSRF, origin, freshness and strict request fields", async () => {
    const body = { userId: "normal", status: "disabled", expectedStatus: "active" };
    expect((await update({}, body)).status).toBe(401);
    expect((await update(await login("normal"), body)).status).toBe(403);
    const admin = await login();
    expect((await request("/api/auth/users/status", { jar: admin, method: "POST", body })).status).toBe(403);
    expect((await update(admin, body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await update(admin, { ...body, role: "admin" })).status).toBe(400);
    expect((await update(admin, { ...body, status: "deleted" })).status).toBe(400);
    clock += 300001;
    const expired = await update(admin, body);
    expect(expired.status).toBe(403);
    expect((await expired.json()).code).toBe("REAUTH_REQUIRED");
    expect(db.prepare("SELECT status FROM users WHERE id='normal'").get().status).toBe("active");
  });
  it("protects the last administrator and closes sockets for a disabled administrator", async () => {
    const admin = await login();
    const id = db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
    const last = await update(admin, { userId: id, status: "disabled", expectedStatus: "active" });
    expect((await last.json()).code).toBe("LAST_ADMIN");
    db.prepare("INSERT INTO users(id,login,role,created_at) VALUES ('second','second','admin',1)").run();
    db.prepare("INSERT INTO local_credentials VALUES ('second',?,1)").run(hash);
    const second = await login("second");
    const ws = connect(second);
    await once(ws, "open");
    const closed = once(ws, "close");
    expect((await update(admin, { userId: "second", status: "disabled", expectedStatus: "active" })).status).toBe(200);
    await closed;
    expect((await request("/api/auth/session", { jar: second })).status).toBe(401);
  });
});

describe("administrative session revocation", () => {
  async function revoke(jar, body, headers = {}) {
    return request("/api/auth/users/revoke-sessions", {
      jar, method: "POST", body,
      headers: { "x-ignis-csrf": await csrf(jar), ...headers },
    });
  }
  it("closes another user's sessions while preserving the operator and allowing new sign-ins", async () => {
    const admin = await login();
    const one = await login("normal");
    const two = await login("normal");
    const result = await revoke(admin, { userId: "normal" });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ revokedSessions: 2, signedOut: false });
    for (const jar of [one, two])
      expect((await request("/api/auth/session", { jar })).status).toBe(401);
    expect((await request("/api/auth/session", { jar: admin })).status).toBe(200);
    await login("normal");
  });
  it("allows the last administrator to revoke itself and closes its sockets", async () => {
    const admin = await login();
    const otherSession = await login();
    const id = db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
    const ws = connect(admin);
    await once(ws, "open");
    const closed = once(ws, "close");
    const result = await revoke(admin, { userId: id });
    expect(result.status).toBe(200);
    expect((await result.json()).signedOut).toBe(true);
    expect(result.headers.getSetCookie().some(value => value.includes("Max-Age=0"))).toBe(true);
    await closed;
    for (const jar of [admin, otherSession])
      expect((await request("/api/auth/session", { jar })).status).toBe(401);
    await login();
  });
  it("requires admin, CSRF, origin, matching context, recent sign-in and an exact payload", async () => {
    const body = { userId: "normal" };
    expect((await revoke({}, body)).status).toBe(401);
    expect((await revoke(await login("normal"), body)).status).toBe(403);
    const admin = await login();
    expect((await request("/api/auth/users/revoke-sessions", { jar: admin, method: "POST", body })).status).toBe(403);
    expect((await revoke(admin, body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await revoke(admin, body, { "x-ignis-context": "old" })).status).toBe(409);
    expect((await revoke(admin, { ...body, role: "admin" })).status).toBe(400);
    expect((await revoke(admin, { userId: "missing" })).status).toBe(404);
    clock += 300001;
    const stale = await revoke(admin, body);
    expect(stale.status).toBe(403);
    expect((await stale.json()).code).toBe("REAUTH_REQUIRED");
  });
});

it("keeps login assets and password login available after auth-read exhaustion", async () => {
  for (let i = 0; i < 300; i++)
    expect((await request("/api/auth/status")).status).toBe(200);
  const limited = await request("/api/auth/session");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  for (const route of ["/login?oidc=success", "/account?oidc=linked", "/auth/login.js", "/auth/client.js", "/favicon.png"])
    expect((await request(route)).status).toBe(200);
  clock += 60000;
  const jar = await login();
  expect((await request("/api/auth/session", { jar })).status).toBe(200);
});

it("static page traffic cannot exhaust the session and CSRF budget", async () => {
  for (let i = 0; i < 75; i++)
    expect((await request("/login")).status).toBe(200);
  const jar = await login();
  expect((await request("/api/auth/session", { jar })).status).toBe(200);
});

it("changes a normal user's own password and revokes every session", async () => {
  const jar = await login("normal");
  const other = await login("normal");
  const response = await request("/api/auth/password", {
    jar, method: "POST", headers: { "x-ignis-csrf": await csrf(jar) },
    body: { currentPassword: PASSWORD, newPassword: "replacement-passphrase" },
  });
  expect(response.status).toBe(200);
  expect((await request("/api/auth/session", { jar })).status).toBe(401);
  expect((await request("/api/auth/session", { jar: other })).status).toBe(401);
  const fresh = await login("normal", "replacement-passphrase");
  expect((await request("/api/auth/session", { jar: fresh })).status).toBe(200);
});
it("requires a session, CSRF, same origin and an exact password change payload", async () => {
  const body = { currentPassword: PASSWORD, newPassword: "replacement-passphrase" };
  expect((await request("/api/auth/password", { method: "POST", body })).status).toBe(401);
  const jar = await login();
  expect((await request("/api/auth/password", { jar, method: "POST", body })).status).toBe(403);
  expect((await request("/api/auth/password", { jar, method: "POST", body,
    headers: { "x-ignis-csrf": await csrf(jar), origin: "https://evil.example" } })).status).toBe(403);
  expect((await request("/api/auth/password", { jar, method: "POST", body: { ...body, userId: "normal" },
    headers: { "x-ignis-csrf": await csrf(jar) } })).status).toBe(400);
});

it("supports opted-in LAN login while enforcing exact Host, Origin and CSRF", async () => {
  const origin = "http://192.168.2.9:8080";
  const lan = createAuthBoundary({
    dataRoot: path.join(root, "data"),
    config: readAuthConfig({ IGNIS_PUBLIC_ORIGIN: origin, IGNIS_ALLOW_HTTP_PRIVATE_NETWORK: "true" }),
    oidcEnv: {},
  });
  const app = express();
  lan.install(app);
  const local = http.createServer(app);
  await new Promise(resolve => local.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${local.address().port}`;
  const fetchLan = (target, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(target, options, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode,
        json: async () => JSON.parse(text),
        headers: { getSetCookie: () => res.headers["set-cookie"] || [] },
      }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
  try {
    const headers = { host: "192.168.2.9:8080" };
    expect((await fetchLan(url + "/login", { headers })).status).toBe(200);
    expect((await fetchLan(url + "/login", { headers: { host: "localhost:8080" } })).status).toBe(403);
    const csrfResponse = await fetchLan(url + "/api/auth/csrf", { headers });
    const token = (await csrfResponse.json()).csrfToken;
    const cookie = csrfResponse.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const options = { method: "POST", headers: { ...headers, cookie, origin, "content-type": "application/json", "x-ignis-csrf": token }, body: JSON.stringify({ login: "admin", password: PASSWORD }) };
    expect((await fetchLan(url + "/api/auth/login", { ...options, headers: { ...options.headers, origin: "http://192.168.2.10:8080" } })).status).toBe(403);
    expect((await fetchLan(url + "/api/auth/login", { ...options, headers: { ...options.headers, "x-ignis-csrf": "invalid" } })).status).toBe(403);
    const response = await fetchLan(url + "/api/auth/login", options);
    expect(response.status).toBe(200);
    const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith("ignis-dev-session="));
    expect(sessionCookie).toContain("HttpOnly; SameSite=Lax");
    expect(sessionCookie).not.toContain("Secure");
    expect((await fetchLan(url + "/api/auth/session", { headers: { ...headers, cookie: sessionCookie.split(";")[0] } })).status).toBe(200);
  } finally {
    local.closeAllConnections();
    await new Promise(resolve => local.close(resolve));
    lan.close();
  }
});

it("admin email updates require recent authorized requests and revoke self sessions", async () => {
  const jar = await login();
  const listing = await (await request("/api/auth/users", { jar })).json();
  const admin = listing.users.find(user => user.login === "admin");
  const body = { userId: admin.id, status: "active", expectedStatus: "active", email: "admin@example.com", emailVerified: true, expectedEmail: null, expectedEmailTrust: "unverified" };
  expect((await request("/api/auth/users/status", { jar, method: "POST", body })).status).toBe(403);
  const response = await request("/api/auth/users/status", { jar, method: "POST", body, headers: { "x-ignis-csrf": await csrf(jar) } });
  expect(response.status).toBe(200);
  expect((await response.json()).signedOut).toBe(true);
  expect((await request("/api/auth/session", { jar })).status).toBe(401);
  expect(db.prepare("SELECT email_trust FROM users WHERE id=?").get(admin.id).email_trust).toBe("admin_confirmed");
});

it("reauthenticates the same administrator with a rotated session and rejects account injection", async () => {
  const jar = await login();
  const session = await (await request("/api/auth/session", { jar })).json();
  clock += 300001;
  async function confirm(body) {
    return request("/api/auth/reauth", { jar, method: "POST", body,
      headers: { "x-ignis-context": session.sessionId, "x-ignis-csrf": await csrf(jar) } });
  }
  expect((await confirm({ password: PASSWORD, login: "normal" })).status).toBe(400);
  expect((await confirm({ password: "incorrect" })).status).toBe(400);
  const response = await confirm({ password: PASSWORD });
  expect(response.status).toBe(200);
  const current = await (await request("/api/auth/session", { jar })).json();
  expect(current.user.id).toBe(session.user.id);
  expect(current.sessionId).not.toBe(session.sessionId);
  expect(current.recentAuthentication).toBe(true);
});

it("guards initial password setup with admin identity, CSRF, context and recent authentication", async () => {
  const normal = await login("normal");
  const jar = await login();
  db.exec("DELETE FROM local_credentials WHERE user_id='normal'; INSERT INTO oidc_identities VALUES ('https://provider.example','initial-sub','normal',0)");
  const context = (await (await request("/api/auth/session", { jar })).json()).sessionId;
  const body = { userId: "normal", password: PASSWORD };
  const path = "/api/auth/users/set-password";
  expect((await request(path, { jar: normal, method: "POST", body })).status).toBe(401);
  expect((await request(path, { jar, method: "POST", body })).status).toBe(403);
  expect((await request(path, { jar, method: "POST", body, headers: { "x-ignis-csrf": await csrf(jar) } })).status).toBe(409);
  clock += 300001;
  expect((await request(path, { jar, method: "POST", body, headers: { "x-ignis-context": context, "x-ignis-csrf": await csrf(jar) } })).status).toBe(403);
  const fresh = await login();
  const freshContext = (await (await request("/api/auth/session", { jar: fresh })).json()).sessionId;
  const response = await request(path, { jar: fresh, method: "POST", body, headers: { "x-ignis-context": freshContext, "x-ignis-csrf": await csrf(fresh) } });
  expect(response.status).toBe(200);
  expect((await response.json()).signedOut).toBe(false);
  expect((await (await request("/api/auth/users", { jar: fresh })).json()).users.find(u => u.id === "normal")).toMatchObject({ hasLocalPassword: true, canSetLocalPassword: false });
  expect(await login("normal")).toBeTruthy();
});

it("sets the OIDC-only administrator's own password and signs out without unlinking", async () => {
  const admin = db.prepare("SELECT id FROM users WHERE role='admin'").get();
  db.prepare("INSERT INTO oidc_identities VALUES ('https://provider.example','admin-sub',?,0)").run(admin.id);
  db.prepare("DELETE FROM local_credentials WHERE user_id=?").run(admin.id);
  const sessions = require("./sessions").createSessionService(db, { now: () => clock });
  const auth = sessions.issueForVerifiedOidcIdentity({ issuer: "https://provider.example", subject: "admin-sub", authenticatedAt: clock });
  const jar = { "ignis-dev-session": auth.token };
  const session = await (await request("/api/auth/session", { jar })).json();
  const response = await request("/api/auth/users/set-password", { jar, method: "POST", body: { userId: admin.id, password: PASSWORD },
    headers: { "x-ignis-context": session.sessionId, "x-ignis-csrf": await csrf(jar) } });
  expect(response.status).toBe(200);
  expect((await response.json()).signedOut).toBe(true);
  expect(jar["ignis-dev-session"]).toBe("");
  expect(sessions.resolve(auth.token)).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(1);
  expect(await login()).toBeTruthy();
});
it("denies non-admin password setup and foreign-origin or injected requests", async () => {
  const normal = await login("normal");
  const jar = await login();
  const path = "/api/auth/users/set-password";
  const body = { userId: "normal", password: PASSWORD };
  expect((await request(path, { jar: normal, method: "POST", body, headers: { "x-ignis-csrf": await csrf(normal) } })).status).toBe(403);
  const context = (await (await request("/api/auth/session", { jar })).json()).sessionId;
  const headers = { "x-ignis-context": context, "x-ignis-csrf": await csrf(jar) };
  expect((await request(path, { jar, method: "POST", body, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
  expect((await request(path, { jar, method: "POST", body: { ...body, role: "admin" }, headers })).status).toBe(400);
  expect((await request(path, { jar, method: "POST", body, headers })).status).toBe(400);
});

it("issues password-reset secrets only to recently authenticated administrators with CSRF and exact context", async () => {
  const jar = await login(); const normal = await login("normal");
  const context = (await (await request("/api/auth/session", { jar })).json()).sessionId;
  const path = "/api/auth/users/reset-password"; const body = { userId: "normal" };
  expect((await request(path, { jar: normal, method: "POST", body, headers: { "x-ignis-csrf": await csrf(normal) } })).status).toBe(403);
  expect((await request(path, { jar, method: "POST", body })).status).toBe(403);
  const headers = { "x-ignis-context": context, "x-ignis-csrf": await csrf(jar) };
  expect((await request(path, { jar, method: "POST", body, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
  expect((await request(path, { jar, method: "POST", body, headers: { ...headers, "x-ignis-context": "wrong" } })).status).toBe(409);
  expect((await request(path, { jar, method: "POST", body: { ...body, role: "admin" }, headers })).status).toBe(400);
  clock += 300001;
  expect((await request(path, { jar, method: "POST", body, headers })).status).toBe(403);
});
it("exchanges a temporary password at login for a restricted reset wizard without issuing a session", async () => {
  const jar = await login();
  const context = (await (await request("/api/auth/session", { jar })).json()).sessionId;
  const issued = await request("/api/auth/users/reset-password", { jar, method: "POST", body: { userId: "normal" },
    headers: { "x-ignis-context": context, "x-ignis-csrf": await csrf(jar) } });
  expect(issued.status).toBe(200); expect(issued.headers.get("cache-control")).toBe("no-store");
  const { secret, expiresAt } = await issued.json(); expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/); expect(expiresAt).toBe(clock + 3600000);
  const anonymous = {};
  const loginReset = await request("/api/auth/login", { jar: anonymous, method: "POST", body: { login: "normal", password: secret }, headers: { "x-ignis-csrf": await csrf(anonymous) } });
  expect(loginReset.status).toBe(200); expect(await loginReset.json()).toEqual({ passwordResetRequired: true });
  expect((await request("/api/auth/session", { jar: anonymous })).status).toBe(401);
  expect((await request("/api/vault/list", { jar: anonymous })).status).toBe(401);
  expect((await request("/api/auth/users", { jar: anonymous })).status).toBe(401);
  expect(loginReset.headers.getSetCookie().find(value => value.startsWith("ignis-dev-reset="))).toContain("HttpOnly; SameSite=Lax");
  const replayJar = {};
  expect((await request("/api/auth/login", { jar: replayJar, method: "POST", body: { login: "normal", password: secret }, headers: { "x-ignis-csrf": await csrf(replayJar) } })).status).toBe(401);
  const grant = await (await request("/api/auth/reset-password", { jar: anonymous })).json();
  expect(grant.login).toBe("normal");
  const path = "/api/auth/reset-password"; const body = { password: "replacement-password!123" };
  expect((await request("/reset-password")).status).toBe(200);
  expect((await request(path, { jar: anonymous, method: "POST", body })).status).toBe(403);
  const headers = { "x-ignis-csrf": await csrf(anonymous), "x-ignis-reset-context": grant.context };
  expect((await request(path, { jar: anonymous, method: "POST", body, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
  expect((await request(path, { jar: anonymous, method: "POST", body: { ...body, secret }, headers })).status).toBe(400);
  expect((await request(path, { jar: anonymous, method: "POST", body, headers: { ...headers, "x-ignis-reset-context": "wrong" } })).status).toBe(400);
  const response = await request(path, { jar: anonymous, method: "POST", body, headers });
  expect(response.status).toBe(200); expect((await request("/api/auth/session", { jar: anonymous })).status).toBe(401);
  expect((await request(path, { jar: anonymous, method: "POST", body, headers: { "x-ignis-csrf": await csrf(anonymous) } })).status).toBe(400);
  expect(await login("normal", body.password)).toBeTruthy();
});
it("allows self-reset issuance, clears the administrator cookie and returns the secret once", async () => {
  const jar = await login(); const session = await (await request("/api/auth/session", { jar })).json();
  const response = await request("/api/auth/users/reset-password", { jar, method: "POST", body: { userId: session.user.id },
    headers: { "x-ignis-context": session.sessionId, "x-ignis-csrf": await csrf(jar) } });
  expect(response.status).toBe(200); expect((await response.json()).signedOut).toBe(true);
  expect(jar["ignis-dev-session"]).toBe("");
  expect((await request("/api/auth/users", { jar })).status).toBe(401);
});
it("limits anonymous reset attempts independently from password login", async () => {
  const jar = {}; const headers = { "x-ignis-csrf": await csrf(jar) };
  for (let i=0; i<10; i++) expect((await request("/api/auth/reset-password", { jar, method: "POST", headers, body: { password: PASSWORD } })).status).toBe(400);
  expect((await request("/api/auth/reset-password", { jar, method: "POST", headers, body: { password: PASSWORD } })).status).toBe(429);
  expect(await login()).toBeTruthy();
});
