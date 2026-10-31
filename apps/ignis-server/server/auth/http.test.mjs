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
let root, db, boundary, server, wss, base, hash, clock, beforeRouting, beforeFileReply;
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
    vaultRoot: root,
    config: readAuthConfig({
      IGNIS_PUBLIC_ORIGIN: ORIGIN,
      IGNIS_ALLOW_HTTP_LOOPBACK: "true",
    }),
    now: () => clock,
  });
  beforeRouting = () => {};
  beforeFileReply = () => {};
  boundary.install(app);
  app.use(express.json());
  app.use((req, res, next) => {
    beforeRouting();
    next();
  });
  app.use(boundary.revalidate);
  app.use("/api/vault-config", require("../routes/vault-config"));
  app.get("/api/bootstrap", (req, res) => res.json({ privateConfiguration: req.privateVaultConfiguration(req.query.vault) }));
  app.get("/api/vault/list", (req, res) => res.json(["private vault"]));
  app.use("/api/vault", require("../routes/vault"));
  app.post("/api/fs/rename", (req,res) => res.json(req.renameVaultResource("vault",req.body.oldPath,req.body.newPath)));
  app.post("/api/fs/writeFile", (req, res) => res.json({ ok: true }));
  app.get("/api/fs/readFile", (req, res) => {
    if (!req.authorizeVaultFile("vault", "content.read", "note.md")) return res.sendStatus(404);
    beforeFileReply();
    res.send("protected bytes");
  });
  app.post(["/api/plugins/headless-sync/enable", "/api/plugins/headless-sync/disable",
    ...["setup", "config", "start", "stop", "unlink"].map(name => "/api/ext/headless-sync/" + name)],
    (req, res) => res.json({ query: req.query, body: req.body }));
  app.get("/api/ext/headless-sync/logs", (req, res) => res.json({ query: req.query }));
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
  // Tests using the default admin exercise an explicitly owned fixture vault.
  if (user === "admin" && !db.prepare("SELECT 1 FROM vaults WHERE directory='vault'").get())
    require("./store").registerVault(db, root, "vault", db.prepare("SELECT id FROM users WHERE login='admin'").get().id);
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
function connect(jar = {}, origin = ORIGIN, reference = "vault") {
  return new WebSocket(base.replace("http:", "ws:") + "/ws?vault=" + encodeURIComponent(reference), {
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
      url: "/api/fs/download?vault=vault",
      query: { vault: "vault" },
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
  it("allows the user shell and catalog but denies unowned vaults and administration", async () => {
    const admin = await login();
    expect((await request("/api/vault/list", { jar: admin })).status).toBe(200);
    const normal = await login("normal");
    expect((await request("/api/auth/session", { jar: normal })).status).toBe(
      200,
    );
    expect((await request("/api/vault/list", { jar: normal })).status).toBe(200);
    expect((await request("/api/settings", { jar: normal })).status).toBe(403);
    expect((await request("/vault-files/vault/note.md", { jar: normal })).status).toBe(404);
  });
  it("requires same-origin CSRF proof bound to the current browser and session", async () => {
    const jar = await login();
    const token = await csrf(jar);
    const mutation = {
      jar,
      method: "POST",
      body: {vault:"vault"},
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
  for (const route of ["/login", "/auth/login.js", "/auth/oidc-start.js", "/auth/client.js"]) {
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
      expect(Object.keys(row).sort()).toEqual(["canSetLocalPassword", "email", "email_trust", "hasLocalPassword", "id", "login", "oidcLinked", "password_change_required", "role", "status"]);
    expect((await listed.json()).oidcAvailable).toBe(false);
    expect((await listed.json()).users.every((row) => row.oidcLinked === null)).toBe(true);
    const normalJar = await login("new-user");
    expect((await request("/api/vault/list", { jar: normalJar })).status).toBe(200);
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
    db.prepare("INSERT INTO memberships SELECT id, 'second', 'reader' FROM vaults WHERE directory='vault'").run();
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

it("requires confirmed, recent and context-bound administrator requests to change roles", async () => {
  const jar = await login(); const normal = await login("normal");
  const session = await (await request("/api/auth/session", { jar })).json();
  const path = "/api/auth/users/status";
  const body = { userId: "normal", status: "active", expectedStatus: "active", role: "admin", expectedRole: "user", confirmAdmin: true };
  expect((await request(path, { jar: normal, method: "POST", body, headers: { "x-ignis-csrf": await csrf(normal) } })).status).toBe(403);
  expect((await request(path, { jar, method: "POST", body })).status).toBe(403);
  expect((await request(path, { jar, method: "POST", body, headers: { "x-ignis-csrf": await csrf(jar) } })).status).toBe(409);
  const headers = { "x-ignis-context": session.sessionId, "x-ignis-csrf": await csrf(jar) };
  expect((await request(path, { jar, method: "POST", body, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
  expect((await request(path, { jar, method: "POST", body: { ...body, confirmAdmin: false }, headers })).status).toBe(400);
  expect((await request(path, { jar, method: "POST", body, headers })).status).toBe(200);
  expect((await request("/api/auth/session", { jar: normal })).status).toBe(401);
  const promoted = await login("normal");
  expect((await request("/api/auth/users", { jar: promoted })).status).toBe(200);
  db.prepare("INSERT INTO memberships SELECT id, 'normal', 'reader' FROM vaults WHERE directory='vault'").run();
  const socket = connect(promoted); await once(socket, "open");
  const closed = once(socket, "close");
  const demotion = { ...body, role: "user", expectedRole: "admin", confirmAdmin: false };
  expect((await request(path, { jar, method: "POST", body: demotion, headers: { ...headers, "x-ignis-csrf": await csrf(jar) } })).status).toBe(200);
  await closed;
  expect((await request("/api/auth/users", { jar: promoted })).status).toBe(401);
  clock += 300001;
  expect((await request(path, { jar, method: "POST", body, headers: { ...headers, "x-ignis-csrf": await csrf(jar) } })).status).toBe(403);
});

it("rejects duplicate, malformed and conflicting vault selectors after parsing and denies unowned vaults", async () => {
  const jar = await login();
  for (const query of ["vault=a&vault=b", "vault[]=a", "vault=", "vault=..%2Fother"])
    expect((await request("/api/fs/readFile?" + query, { jar })).status).toBe(400);
  expect((await request("/api/fs/writeFile?vault=first", { jar, method: "POST", body: { vault: "second", path: "note.md", data: "test" },
    headers: { "x-ignis-csrf": await csrf(jar) } })).status).toBe(400);
  expect((await request("/api/fs/writeFile?vault=first", { jar, method: "POST", body: { vault: "first", path: "note.md", data: "test" },
    headers: { "x-ignis-csrf": await csrf(jar) } })).status).toBe(404);
  const normal = await login("normal");
  expect((await request("/api/fs/readFile?vault=first", { jar: normal })).status).toBe(404);
});

describe("registered WebSocket vault identity", () => {
  function register() {
    const owner = db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
    return require("./store").registerVault(db, root, "vault", owner);
  }
  it("routes UUID and alias connections through the same watcher and broadcast key", async () => {
    const vault = register();
    const jar = await login();
    const byId = connect(jar, ORIGIN, vault.id);
    const byName = connect(jar);
    await Promise.all([once(byId, "open"), once(byName, "open")]);
    const messages = [once(byId, "message"), once(byName, "message")];
    wss.broadcastToVault("vault", { type: "modified", path: "same-vault.md" });
    for (const message of await Promise.all(messages))
      expect(JSON.parse(message[0].toString()).path).toBe("same-vault.md");
    const closed = [once(byId, "close"), once(byName, "close")];
    wss.closeVaultSockets("vault");
    expect((await Promise.all(closed)).map(event => event[0])).toEqual([4002, 4002]);
  });
  it("blocks outgoing data when the pinned vault is quarantined", async () => {
    const vault = register();
    const ws = connect(await login(), ORIGIN, vault.id);
    await once(ws, "open");
    let received = false;
    ws.on("message", () => { received = true; });
    const closed = once(ws, "close");
    db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(vault.id);
    wss.broadcastToVault("vault", { type: "modified", path: "must-not-arrive.md" });
    expect((await closed)[0]).toBe(4002);
    expect(received).toBe(false);
  });
  it("does not follow a replacement registration under the same alias", async () => {
    const vault = register();
    const ws = connect(await login());
    await once(ws, "open");
    const closed = once(ws, "close");
    db.prepare("DELETE FROM vaults WHERE id=?").run(vault.id);
    expect(register().id).not.toBe(vault.id);
    wss.broadcastToVault("vault", { type: "modified", path: "replacement.md" });
    expect((await closed)[0]).toBe(4002);
  });
});

it("resolves plugin and sync UUIDs before routing and keeps all operations administrator-only", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
  const vault = require("./store").registerVault(db, root, "vault", owner);
  const jar = await login();
  const normal = await login("normal");
  const token = await csrf(jar);
  const headers = { "x-ignis-csrf": token };
  for (const action of ["setup", "config", "start", "stop", "unlink"]) {
    const url = "/api/ext/headless-sync/" + action;
    const body = { vaultId: vault.id };
    const response = await request(url, { jar, method: "POST", headers, body });
    expect(response.status).toBe(200);
    expect((await response.json()).body.vaultId).toBe("vault");
    expect((await request(url, { jar: normal, method: "POST", headers, body })).status).toBe(403);
    expect((await request(url, { jar, method: "POST", body })).status).toBe(403);
  }
  for (const action of ["enable", "disable"]) {
    const response = await request("/api/plugins/headless-sync/" + action, { jar, method: "POST", headers, body: { vault: vault.id } });
    expect(response.status).toBe(200);
    expect((await response.json()).body.vault).toBe("vault");
  }
  const logs = await request(`/api/ext/headless-sync/logs?vaultId=${vault.id}`, { jar });
  expect(logs.status).toBe(200);
  expect((await logs.json()).query.vaultId).toBe("vault");
  for (const body of [{}, { vaultId: [] }, { vaultId: "../vault" }, { vaultId: vault.id, vault: "vault" }]) {
    expect((await request("/api/ext/headless-sync/start", { jar, method: "POST", headers, body })).status).toBe(400);
  }
  expect((await request("/api/ext/headless-sync/start?vaultId=other", { jar, method: "POST", headers, body: { vaultId: vault.id } })).status).toBe(400);
  db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(vault.id);
  expect((await request("/api/ext/headless-sync/start", { jar, method: "POST", headers, body: { vaultId: vault.id } })).status).toBe(404);
  expect((await request(`/api/ext/headless-sync/logs?vaultId=${vault.id}`, { jar })).status).toBe(404);
});

it("revalidates the pinned file decision before releasing response bytes", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
  const vault = require("./store").registerVault(db, root, "vault", owner);
  const jar = await login();
  const permitted = await request("/api/fs/readFile?vault=vault&path=note.md", { jar });
  expect(permitted.status).toBe(200);
  expect(await permitted.text()).toBe("protected bytes");
  beforeFileReply = () => db.prepare("UPDATE vaults SET status='quarantine' WHERE id=?").run(vault.id);
  await expect(request("/api/fs/readFile?vault=vault&path=note.md", { jar })).rejects.toThrow();
});

it("projects filesystem events for each real socket without exposing reserved paths or extra payload fields", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
  require("./store").registerVault(db, root, "vault", owner);
  const ws = connect(await login());
  await once(ws, "open");
  const received = [];
  const finished = new Promise(resolve => {
    ws.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      received.push(message);
      if (message.path === "last.md") resolve();
    });
  });
  wss.broadcastToVault("vault", { type: "modified", path: ".ignis-private/secret.md" });
  wss.broadcastToVault("vault", { type: "rename", path: "public.md", toPath: ".ignis-private/secret.md" });
  wss.broadcastToVault("vault", { type: "modified", path: "last.md", unexpectedSecret: "must-not-arrive", stat: { size: 5, mtime: 7, absolutePath: "/private" } });
  await finished;
  expect(received).toEqual([
    { type: "deleted", path: "public.md" },
    { type: "modified", path: "last.md", stat: { size: 5, mtime: 7 } },
  ]);
  const closed = once(ws, "close"); ws.close(); await closed;
});

it("binds bootstrap private configuration to the authenticated account and registered vault", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE role='admin'").get().id;
  const vault = require("./store").registerVault(db, root, "vault", owner);
  db.prepare("INSERT INTO vault_preferences VALUES (?,?,?,?,?)").run(owner,vault.id,".obsidian/app.json",'{"spellcheck":true,"secret":"hidden"}',1);
  const jar = await login();
  const result = await request(`/api/bootstrap?vault=${vault.id}&userId=normal`, { jar });
  expect(result.status).toBe(200);
  const config = (await result.json()).privateConfiguration;
  expect(config[".obsidian/app.json"]).toEqual({content:'{"spellcheck":true}',revision:1,writable:true});
  expect(config[".obsidian/community-plugins.json"].content).toBe("[]");
  expect((await request(`/api/bootstrap?vault=${vault.id}`, {jar:await login("normal")})).status).toBe(404);
  expect((await request(`/api/bootstrap?vault=${vault.id}`)).status).toBe(401);
});

it("protects private configuration writes with CSRF, revision checks and a server-derived identity", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE role='admin'").get().id;
  const vault = require("./store").registerVault(db, root, "vault", owner);
  const jar = await login();
  const route = `/api/vault-config?vault=${vault.id}&path=.obsidian/app.json`;
  expect((await request(route,{jar})).status).toBe(200);
  const body = {vault:vault.id,path:".obsidian/app.json",content:'{"spellcheck":true}',expectedRevision:0,userId:"normal"};
  expect((await request("/api/vault-config",{jar,method:"POST",body})).status).toBe(403);
  const headers = {"x-ignis-csrf":await csrf(jar)};
  const save = () => request("/api/vault-config",{jar,method:"POST",body,headers});
  expect((await save()).status).toBe(200);
  const conflict = await save();
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).code).toBe("PREFERENCES_CONFLICT");
  expect(db.prepare("SELECT user_id FROM vault_preferences").get().user_id).toBe(owner);
  expect((await request(route,{jar})).headers.get("cache-control")).toBe("no-store");
  expect((await request("/api/vault-config",{jar,method:"POST",body:{...body,path:".obsidian/community-plugins.json"},headers})).status).toBe(400);
  expect((await request(route,{jar:await login("normal")})).status).toBe(404);
});

it("allows an owner socket and file reads, then stops both after membership revocation", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE login='normal'").get().id;
  const vault = require("./store").registerVault(db, root, "vault", owner);
  const jar = await login("normal");
  const response = await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`, { jar });
  expect(response.status).toBe(200);
  const ws = connect(jar, ORIGIN, vault.id);
  await once(ws, "open");
  const message = once(ws, "message");
  wss.broadcastToVault("vault", { type: "modified", path: "visible.md" });
  expect(JSON.parse((await message)[0].toString()).path).toBe("visible.md");
  const closed = once(ws, "close");
  db.prepare("DELETE FROM memberships WHERE vault_id=? AND user_id=?").run(vault.id, owner);
  wss.broadcastToVault("vault", { type: "modified", path: "after-revoke.md" });
  await closed;
  expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`, { jar })).status).toBe(404);
});

it("allows reader and editor sessions to read their vault and subscribe to events", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE login='normal'").get().id;
  const vault = require("./store").registerVault(db, root, "vault", owner);
  const jar = await login("normal");
  for (const role of ["reader", "editor"]) {
    db.prepare("UPDATE memberships SET role=? WHERE vault_id=? AND user_id=?").run(role, vault.id, owner);
    expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`, { jar })).status).toBe(200);
    expect((await request(`/api/vault-config?vault=${vault.id}&path=.obsidian/app.json`, { jar })).status).toBe(200);
    const ws = connect(jar, ORIGIN, vault.id);
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
  }
});

it("requires admin membership on sockets and immediately observes its revocation",async()=>{
 const owner="normal";
 const vault=require("./store").registerVault(db,root,"vault",owner);
 const jar=await login();
 expect(await rejectedSocket(jar,ORIGIN)).toBe(401);
 expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`,{jar})).status).toBe(404);
 const admin=db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
 db.prepare("INSERT INTO memberships VALUES (?,?,'reader')").run(vault.id,admin);
 const ws=connect(jar,ORIGIN,vault.id); await once(ws,"open");
 expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`,{jar})).status).toBe(200);
 const closed=once(ws,"close");
 db.prepare("DELETE FROM memberships WHERE user_id=? AND vault_id=?").run(admin,vault.id);
 wss.broadcastToVault("vault",{type:"modified",path:"no-access.md"});
 await closed;
 expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`,{jar})).status).toBe(404);
 expect((await request("/api/auth/users",{jar})).status).toBe(200);
});

it("lets a normal owner share via HTTP, enforces CSRF and closes revoked member sockets",async()=>{
 const vault=require("./store").registerVault(db,root,"vault","normal");
 const owner=await login("normal"),admin=await login();
 const adminId=db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
 const url=`/api/vault/members?vault=${vault.id}`;
 expect((await request(url)).status).toBe(401);
 expect((await request(url,{jar:admin})).status).toBe(404);
 const current=await (await request(url,{jar:owner})).json();
 const body={vault:vault.id,login:"admin",role:"reader",expectedRole:null,revision:current.revision};
 expect((await request("/api/vault/members",{jar:owner,method:"POST",body})).status).toBe(403);
 const headers={"x-ignis-csrf":await csrf(owner)};
 expect((await request("/api/vault/members",{jar:owner,method:"POST",body,headers:{...headers,origin:"https://evil.example"}})).status).toBe(403);
 const added=await request("/api/vault/members",{jar:owner,method:"POST",body,headers});expect(added.status).toBe(200);
 expect(db.prepare("SELECT role FROM memberships WHERE user_id=?").get(adminId).role).toBe("reader");
 expect((await request(url,{jar:admin})).status).toBe(404);
 expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`,{jar:admin})).status).toBe(200);
 const ws=connect(admin,ORIGIN,vault.id);await once(ws,"open");const closed=once(ws,"close");
 const remove={...body,role:null,expectedRole:"reader",revision:(await added.json()).revision};
 expect((await request("/api/vault/members",{jar:owner,method:"POST",body:remove,headers})).status).toBe(200);
 await closed;
 expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`,{jar:admin})).status).toBe(404);
 expect((await request("/api/vault/members",{jar:owner,method:"POST",body,headers})).status).toBe(409);
});

it.each(["admin", "normal"])("accepts Traefik secure WebSockets for an authorized %s without trusting insecure forwarding",async user=>{
 const adminJar=await login();
 const vault=db.prepare("SELECT id FROM vaults WHERE directory='vault'").get();
 if(user==="normal") db.prepare("INSERT INTO memberships VALUES (?,'normal','reader')").run(vault.id);
 const jar=user==="admin"?adminJar:await login("normal");
 const session=await (await request("/api/auth/session",{jar})).json();
 const b=createAuthBoundary({dataRoot:path.join(root,"data"),vaultRoot:root,config:readAuthConfig({
  IGNIS_PUBLIC_ORIGIN:"https://ignis.example",IGNIS_TRUSTED_PROXIES:'["127.0.0.1/32"]',
 })});
 const app=express();b.install(app);
 const req={url:`/ws?vault=${vault.id}&context=${session.sessionId}`,socket:{remoteAddress:"127.0.0.1"},headers:{
  host:"ignis.example",origin:"https://ignis.example",cookie:`__Host-ignis-session=${jar["ignis-dev-session"]}`,"x-forwarded-proto":"wss",
 }};
 try {
  expect(b.wsSecurity.verify(req)).toBe(true);
  for(const proto of ["ws","http","wss, https","https, wss",undefined])
   expect(b.wsSecurity.verify({...req,headers:{...req.headers,"x-forwarded-proto":proto}})).toBe(false);
  expect(b.wsSecurity.verify({...req,socket:{remoteAddress:"192.0.2.15"}})).toBe(false);
  expect(b.wsSecurity.verify({...req,headers:{...req.headers,origin:"https://evil.example"}})).toBe(false);
  expect(b.wsSecurity.verify({...req,headers:{...req.headers,cookie:""}})).toBe(false);
  expect(b.wsSecurity.verify({...req,url:`/ws?vault=${vault.id}&context=stale`})).toBe(false);
  expect(b.wsSecurity.verify({...req,headers:{...req.headers,"x-forwarded-proto":"https"}})).toBe(true);
  const listener=http.createServer(app);
  const sockets=setupWebSocket(listener,{security:b.wsSecurity,getVaultPath:id=>id==="vault"?path.join(root,"vault"):null});
  await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
  let ws;
  try {
   ws=new WebSocket(`ws://127.0.0.1:${listener.address().port}${req.url}`,{headers:req.headers});
   await once(ws,"open");const message=once(ws,"message");
   sockets.broadcastToVault("vault",{type:"modified",path:"forwarded.md"});
   expect(JSON.parse((await message)[0].toString()).path).toBe("forwarded.md");
   // wss is not a TLS assertion for ordinary HTTP routes.
   const response=await fetch(`http://127.0.0.1:${listener.address().port}/api/auth/status`,{headers:req.headers});
   expect(response.status).toBe(403);
  } finally {
   if(ws) ws.terminate();for(const client of sockets.clients)client.terminate();
   sockets.close();await new Promise(resolve=>listener.close(resolve));
  }
 } finally {b.close();}
});

it("transfers ownership through the owner session without granting an admin bypass or losing the response",async()=>{
 const vault=require("./store").registerVault(db,root,"vault","normal");
 const owner=await login("normal"),admin=await login();
 const adminId=db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
 db.prepare("INSERT INTO memberships VALUES (?,?,'reader')").run(vault.id,adminId);
 const route="/api/vault/transfer-ownership";
 const body={vault:vault.id,userId:adminId,expectedRole:"reader",revision:1,confirm:true};
 const headers={"x-ignis-csrf":await csrf(owner)};
 expect((await request(route,{method:"POST",body})).status).toBe(401);
 expect((await request(route,{jar:owner,method:"POST",body})).status).toBe(403);
 expect((await request(route,{jar:owner,method:"POST",body,headers:{...headers,origin:"https://evil.example"}})).status).toBe(403);
 expect((await request(route,{jar:admin,method:"POST",body,headers:{"x-ignis-csrf":await csrf(admin)}})).status).toBe(404);
 expect((await request(route,{jar:owner,method:"POST",body:{...body,confirm:false},headers})).status).toBe(400);
 const response=await request(route,{jar:owner,method:"POST",body,headers});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,membership:"editor"});
 expect((await request(`/api/vault/members?vault=${vault.id}`,{jar:owner})).status).toBe(404);
 expect((await request(`/api/fs/readFile?vault=${vault.id}&path=note.md`,{jar:owner})).status).toBe(200);
 expect((await request(`/api/vault/members?vault=${vault.id}`,{jar:admin})).status).toBe(200);
 expect((await request(route,{jar:owner,method:"POST",body,headers})).status).toBe(404);
});

it("enforces session context, CSRF and owner authority on resource sharing without granting vault access",async()=>{
 const {registerVault}=require("./store");const adminId=db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
 const vault=registerVault(db,root,"vault",adminId);
 const admin=await login("admin"),normal=await login("normal");
 const adminSession=await (await request("/api/auth/session",{jar:admin})).json();
 const normalSession=await (await request("/api/auth/session",{jar:normal})).json();
 const csrfAdmin=(await (await request("/api/auth/csrf",{jar:admin})).json()).csrfToken;
 const csrfNormal=(await (await request("/api/auth/csrf",{jar:normal})).json()).csrfToken;
 const headers={"x-ignis-context":adminSession.sessionId,"x-ignis-csrf":csrfAdmin};
 const body={operation:"create",input:{vault:vault.id,path:"note.md",login:"normal",role:"reader"}};
 expect((await request("/api/shares",{method:"POST",body})).status).toBe(401);
 expect((await request("/api/shares",{jar:admin,method:"POST",body})).status).toBe(403);
 expect((await request("/api/shares",{jar:admin,method:"POST",body,headers:{...headers,origin:"https://evil.example"}})).status).toBe(403);
 const response=await request("/api/shares",{jar:admin,method:"POST",body,headers});expect(response.status).toBe(200);const {id}=await response.json();
 const nh={"x-ignis-context":normalSession.sessionId,"x-ignis-csrf":csrfNormal};
 const read=await request("/api/shares",{jar:normal,method:"POST",headers:nh,body:{operation:"read",input:{id,path:""}}});expect(read.status).toBe(200);
 expect(Buffer.from((await read.json()).content,"base64").toString()).toBe("private note");
 const contentUrl=`/api/shares/content?id=${id}&path=&context=${normalSession.sessionId}`;
 expect((await request(contentUrl)).status).toBe(401);
 expect((await request(contentUrl.replace(normalSession.sessionId,'other'),{jar:normal})).status).toBe(403);
 const attachment=await request(contentUrl,{jar:normal});expect(attachment.status).toBe(200);expect(await attachment.text()).toBe('private note');expect(attachment.headers.get('content-disposition')).toBe('attachment');expect(attachment.headers.get('content-security-policy')).toContain('sandbox');
 expect((await request(contentUrl+'&extra=true',{jar:normal})).status).toBe(400);
 fs.mkdirSync(path.join(root,'Inbox'));const inbox=registerVault(db,root,'Inbox',db.prepare("SELECT id FROM users WHERE login='normal'").get().id);
 const placement={operation:'destination',input:{id,vault:inbox.id,localPath:'note.md'}};
 const renameAttempt={operation:'rename',input:{id,path:'note.md',to:'Renamed.md',etag:'bad'}};
 expect((await request('/api/shares',{jar:normal,method:'POST',body:renameAttempt})).status).toBe(403);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:renameAttempt})).status).toBe(404);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:{...renameAttempt,input:{...renameAttempt.input,userId:adminId}}})).status).toBe(400);

 expect((await request('/api/shares',{jar:normal,method:'POST',body:placement})).status).toBe(403);
 expect((await request('/api/shares',{jar:admin,method:'POST',headers,body:placement})).status).toBe(404);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:{...placement,input:{...placement.input,userId:adminId}}})).status).toBe(400);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:placement})).status).toBe(200);
 const mounts=await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:{operation:'mounts',input:{vault:inbox.id}}});expect(mounts.status).toBe(200);expect((await mounts.json()).mounts[0].id).toBe(id);

 expect((await request("/api/shares",{jar:normal,method:"POST",headers:nh,body:{operation:"revoke",input:{action:"revoke",id,revision:1}}})).status).toBe(404);
 expect((await request("/api/fs/readFile?vault="+vault.id+"&path=note.md",{jar:normal})).status).toBe(404);
 expect((await request("/api/shares",{jar:normal,method:"POST",headers:nh,body:{operation:"read",input:{id,path:"",extra:true}}})).status).toBe(400);
 expect((await request("/api/shares",{jar:normal,method:"POST",headers:{...nh,"x-ignis-context":"other"},body:{operation:"read",input:{id,path:""}}})).status).toBe(409);
 const originalRename=await request('/api/fs/rename?vault='+vault.id,{jar:admin,method:'POST',headers,body:{oldPath:'note.md',newPath:'Renamed.md'}});
 expect(originalRename.status).toBe(200);
 expect(db.prepare('SELECT path FROM shared_resources WHERE id=?').get(id).path).toBe('Renamed.md');
 expect((await request(contentUrl,{jar:normal})).status).toBe(200);
 const afterRename=await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:{operation:'mounts',input:{vault:inbox.id}}});
 expect((await afterRename.json()).mounts[0].localPath).toBe('note.md');
 expect((await request('/api/shares',{jar:admin,method:'POST',headers,body:{operation:'revoke',input:{action:'revoke',id,revision:2}}})).status).toBe(200);
 expect((await request(contentUrl,{jar:normal})).status).toBe(404);

});

it('allows normal users to create their own vaults over HTTP without assigning owners or gaining administration',async()=>{
 const jar=await login('normal'),session=await (await request('/api/auth/session',{jar})).json();
 const csrf=(await (await request('/api/auth/csrf',{jar})).json()).csrfToken;
 const headers={'x-ignis-context':session.sessionId,'x-ignis-csrf':csrf};
 const create=(body,extra={})=>request('/api/vault/create',{jar,method:'POST',headers,body,...extra});
 expect((await request('/api/vault/create',{method:'POST',body:{name:'Anonymous'}})).status).toBe(401);
 expect((await create({name:'NoCSRF'},{headers:{'x-ignis-context':session.sessionId}})).status).toBe(403);
 expect((await create({name:'ForeignOrigin'},{headers:{...headers,origin:'https://evil.example'}})).status).toBe(403);
 const adminId=db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
 expect((await create({name:'Forged',ownerId:adminId})).status).toBe(400);
 expect((await create({name:'../Escape'})).status).toBe(400);
 const result=await create({name:'Personal'});expect(result.status).toBe(200);const {uuid}=await result.json();
 expect(db.prepare('SELECT user_id,role FROM memberships WHERE vault_id=?').all(uuid)).toEqual([{user_id:'normal',role:'owner'}]);
 expect((await create({name:'Personal'})).status).toBe(409);
 expect((await request('/api/vault/owners',{jar})).status).toBe(403);
 expect((await request('/api/vault/register',{jar,method:'POST',headers,body:{directory:'vault',ownerId:'normal'}})).status).toBe(403);
 const admin=await login('admin');expect((await request('/api/bootstrap?vault='+uuid,{jar:admin})).status).toBe(404);
 expect((await request('/api/bootstrap?vault='+uuid,{jar})).status).toBe(200);
});

it('lets normal owners rename and delete via HTTP but denies other members and missing CSRF',async()=>{
 const jar=await login('normal'),session=await (await request('/api/auth/session',{jar})).json();
 const csrf=(await (await request('/api/auth/csrf',{jar})).json()).csrfToken;
 const headers={'x-ignis-context':session.sessionId,'x-ignis-csrf':csrf};
 const post=(route,body,extra={})=>request('/api/vault/'+route+(route==='remove'?'?vault='+encodeURIComponent(body.vault):''),{jar,method:route==='remove'?'DELETE':'POST',headers,...(route==='remove'?{}:{body}),...extra});
 const created=await post('create',{name:'Personal'});expect(created.status).toBe(200);const {uuid}=await created.json();
 expect((await post('rename',{vault:uuid,name:'Renamed'},{headers:{}})).status).toBe(403);
 expect((await post('remove',{vault:uuid},{headers:{...headers,origin:'https://evil.example'}})).status).toBe(403);
 const rename=await post('rename',{vault:uuid,name:'Renamed'});expect(rename.status).toBe(200);expect((await rename.json()).uuid).toBe(uuid);
 const {registerVault}=require('./store'),adminId=db.prepare("SELECT id FROM users WHERE login='admin'").get().id,foreign=registerVault(db,root,'vault',adminId);
 db.prepare("INSERT INTO memberships VALUES (?,'normal','editor')").run(foreign.id);
 expect((await post('rename',{vault:foreign.id,name:'Stolen'})).status).toBe(404);
 expect((await post('remove',{vault:foreign.id})).status).toBe(404);
 expect((await post('remove',{vault:uuid})).status).toBe(200);
 expect(db.prepare('SELECT id FROM vaults WHERE id=?').get(uuid)).toBeUndefined();
 expect(fs.existsSync(path.join(root,'vault','note.md'))).toBe(true);
});

it('guards deletion preview and confirmation with admin freshness, context, CSRF and exact scope',async()=>{
 const jar=await login();
 const session=await (await request('/api/auth/session',{jar})).json();
 const body={operation:'preview',userId:'normal'};
 const headers={'x-ignis-context':session.sessionId,'x-ignis-csrf':await csrf(jar)};
 expect((await request('/api/auth/users/delete',{method:'POST',body})).status).toBe(401);
 expect((await request('/api/auth/users/delete',{jar:await login('normal'),method:'POST',body})).status).toBe(403);
 expect((await request('/api/auth/users/delete',{jar,method:'POST',body})).status).toBe(403);
 expect((await request('/api/auth/users/delete',{jar,method:'POST',headers:{...headers,origin:'https://evil.example'},body})).status).toBe(403);
 expect((await request('/api/auth/users/delete',{jar,method:'POST',headers:{...headers,'x-ignis-context':'wrong'},body})).status).toBe(409);
 expect((await request('/api/auth/users/delete',{jar,method:'POST',headers,body:{...body,deleteVaults:true}})).status).toBe(400);
 const preview=await request('/api/auth/users/delete',{jar,method:'POST',headers,body});
 expect(preview.status).toBe(200);
 const plan=await preview.json();expect(plan.vaults).toEqual([]);
 clock+=300001;
 expect((await request('/api/auth/users/delete',{jar,method:'POST',headers,body:{operation:'delete',userId:'normal',revision:plan.revision,confirmLogin:'normal',deleteVaults:false}})).status).toBe(403);
 expect(db.prepare("SELECT * FROM users WHERE id='normal'").get()).toBeTruthy();
});
it('deletes an account via HTTP, invalidates its existing session and prevents replay',async()=>{
 const target=await login('normal'),jar=await login();
 const session=await (await request('/api/auth/session',{jar})).json();
 const headers={'x-ignis-context':session.sessionId,'x-ignis-csrf':await csrf(jar)};
 const plan=await (await request('/api/auth/users/delete',{jar,method:'POST',headers,body:{operation:'preview',userId:'normal'}})).json();
 const body={operation:'delete',userId:'normal',revision:plan.revision,confirmLogin:'normal',deleteVaults:false};
 const result=await request('/api/auth/users/delete',{jar,method:'POST',headers,body});
 expect(result.status).toBe(200);expect(await result.json()).toEqual({ok:true});
 expect((await request('/api/auth/session',{jar:target})).status).toBe(401);
 expect((await request('/api/auth/users/delete',{jar,method:'POST',headers,body})).status).toBe(403);
 expect((await request('/api/auth/session',{jar})).status).toBe(200);
 expect(db.prepare("SELECT * FROM users WHERE id='normal'").get()).toBeUndefined();
});

it('requires context, CSRF and an exact explicit confirmation for shared subtree deletion',async()=>{
 const {registerVault}=require('./store'),adminId=db.prepare("SELECT id FROM users WHERE login='admin'").get().id;
 const vault=registerVault(db,root,'vault',adminId);fs.mkdirSync(path.join(root,'vault','Project','sub'),{recursive:true});fs.writeFileSync(path.join(root,'vault','Project','sub','note.md'),'shared');
 const admin=await login('admin'),normal=await login('normal');
 const headersFor=async jar=>({'x-ignis-context':(await (await request('/api/auth/session',{jar})).json()).sessionId,'x-ignis-csrf':(await (await request('/api/auth/csrf',{jar})).json()).csrfToken});
 const ah=await headersFor(admin),nh=await headersFor(normal);
 const created=await request('/api/shares',{jar:admin,method:'POST',headers:ah,body:{operation:'create',input:{vault:vault.id,path:'Project',login:'normal',role:'editor'}}});expect(created.status).toBe(200);const {id}=await created.json();
 const preview=await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:{operation:'previewRemoval',input:{id,path:'sub'}}});expect(preview.status).toBe(200);
 const {revision}=await preview.json(),body={operation:'removeConfirmed',input:{id,path:'sub',revision,confirm:true}};
 expect((await request('/api/shares',{method:'POST',body})).status).toBe(401);
 expect((await request('/api/shares',{jar:normal,method:'POST',body})).status).toBe(403);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:{...nh,'x-ignis-context':'wrong'},body})).status).toBe(409);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:{...nh,origin:'https://evil.example'},body})).status).toBe(403);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:{...body,input:{...body.input,confirm:false}}})).status).toBe(400);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:nh,body:{...body,input:{...body.input,extra:true}}})).status).toBe(400);
 expect((await request('/api/shares',{jar:normal,method:'POST',headers:nh,body})).status).toBe(200);
 expect(fs.existsSync(path.join(root,'vault','Project','sub'))).toBe(false);
});

it('lets a normal owner trash and restore private files and revoke shares when trashing shared folders',async()=>{
 const {registerVault}=require('./store'),userId=db.prepare("SELECT id FROM users WHERE login='normal'").get().id;
 const vault=registerVault(db,root,'vault',userId),jar=await login('normal');
 const session=await (await request('/api/auth/session',{jar})).json(),csrf=(await (await request('/api/auth/csrf',{jar})).json()).csrfToken;
 const headers={'x-ignis-context':session.sessionId,'x-ignis-csrf':csrf};
 const post=(route,body)=>request(route+'?vault='+vault.id,{jar,method:'POST',headers,body});
 fs.mkdirSync(path.join(root,'vault','.trash'));
 expect((await post('/api/fs/rename',{oldPath:'note.md',newPath:'.trash/note.md'})).status).toBe(200);
 expect((await post('/api/fs/rename',{oldPath:'.trash/note.md',newPath:'note.md'})).status).toBe(200);
 fs.mkdirSync(path.join(root,'vault','Shared'));fs.writeFileSync(path.join(root,'vault','Shared','file.md'),'content');
 const created=await request('/api/shares',{jar,method:'POST',headers,body:{operation:'create',input:{vault:vault.id,path:'Shared',login:'admin',role:'editor'}}});expect(created.status).toBe(200);const {id}=await created.json();
 expect((await post('/api/fs/rename',{oldPath:'Shared',newPath:'.trash/Shared'})).status).toBe(200);
 expect(db.prepare('SELECT id FROM shared_resources WHERE id=?').get(id)).toBeUndefined();
 expect(fs.readFileSync(path.join(root,'vault','.trash','Shared','file.md'),'utf8')).toBe('content');
});

it("forces a local-password change through the admin API and issues no vault session until completion", async () => {
  const jar = await login(); const user = await login("normal");
  const context = (await (await request("/api/auth/session", { jar })).json()).sessionId;
  const body = { userId: "normal", status: "active", expectedStatus: "active", requirePasswordChange: true, expectedPasswordChangeRequired: false };
  const endpoint = "/api/auth/users/status";
  expect((await request(endpoint, { jar: user, method: "POST", body, headers: { "x-ignis-csrf": await csrf(user) } })).status).toBe(403);
  expect((await request(endpoint, { jar, method: "POST", body, headers: { "x-ignis-csrf": await csrf(jar), "x-ignis-context": "wrong" } })).status).toBe(409);
  expect((await request(endpoint, { jar, method: "POST", body, headers: { "x-ignis-csrf": await csrf(jar), "x-ignis-context": context } })).status).toBe(200);
  expect((await request("/api/auth/session", { jar: user })).status).toBe(401);
  const response = await request("/api/auth/login", { jar: user, method: "POST", body: { login: "normal", password: PASSWORD }, headers: { "x-ignis-csrf": await csrf(user) } });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ passwordResetRequired: true });
  for (const url of ["/api/auth/session", "/api/vault/list", "/api/auth/users", "/api/fs/readFile?vault=vault&path=note.md"])
    expect((await request(url, { jar: user })).status).toBe(401);
  const grant = await (await request("/api/auth/reset-password", { jar: user })).json();
  const resetHeaders = { "x-ignis-csrf": await csrf(user), "x-ignis-reset-context": grant.context };
  const same = await request("/api/auth/reset-password", { jar: user, method: "POST", body: { password: PASSWORD }, headers: resetHeaders });
  expect(same.status).toBe(400); expect((await same.json()).code).toBe("PASSWORD_UNCHANGED");
  const done = await request("/api/auth/reset-password", { jar: user, method: "POST", body: { password: "new-required-password!" }, headers: resetHeaders });
  expect(done.status).toBe(200);
  const final = await request("/api/auth/login", { jar: user, method: "POST", body: { login: "normal", password: "new-required-password!" }, headers: { "x-ignis-csrf": await csrf(user) } });
  expect(final.status).toBe(200); expect((await final.json()).user.login).toBe("normal");
});
