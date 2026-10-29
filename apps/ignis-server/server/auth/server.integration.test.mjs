import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { bootstrapAdmin } = require("./store");
const { hashPassword } = require("./password");

async function launch(root, env = {}) {
  const child = spawn(
    process.execPath,
    [path.resolve("apps/ignis-server/server/index.js")],
    {
      env: {
        ...process.env,
        PORT: "0",
        DATA_ROOT: path.join(root, "data"),
        VAULT_ROOT: path.join(root, "vaults"),
        OBSIDIAN_ASSETS_PATH: path.join(root, "assets"),
        IGNIS_PUBLIC_ORIGIN: "http://localhost:8080",
        IGNIS_ALLOW_HTTP_LOOPBACK: "true",
        IGNIS_TRUSTED_PROXIES: "[]",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Server startup timed out"));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/Server running on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code})`));
    });
  });
  return { child, ready, logs: () => log };
}
function request(port, route, jar = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
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
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          for (const cookie of res.headers["set-cookie"] || []) {
            const [k, v] = cookie.split(";")[0].split("=");
            jar[k] = v;
          }
          resolve({ status: res.statusCode, text });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}
async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
it("protects real server routes, persists auth and does not log request secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-real-auth-"));
  fs.mkdirSync(path.join(root, "vaults", "Team"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(
    path.join(root, "assets", "index.html"),
    '<script src="app.js"></script>',
  );
  fs.writeFileSync(
    path.join(root, "vaults", "Team", "note.md"),
    "private-note-marker",
  );
  const password = "synthetic-real-server-password";
  const db = openDatabase(path.join(root, "data"));
  bootstrapAdmin(db, "admin", await hashPassword(password));
  db.exec("INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('interrupted','Interrupted','Interrupted','pending',0)");
  fs.mkdirSync(path.join(root, "vaults", "Interrupted", ".obsidian", "plugins", "ignis-bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "vaults", "Interrupted", ".obsidian", "plugins", "ignis-bridge", "keep"), "preserve");
  fs.symlinkSync(path.join(root, "vaults", "Interrupted"), path.join(root, "vaults", "Alias"));
  db.close();
  const processState = await launch(root);
  try {
    const port = await processState.ready;
    for (const route of [
      "/api/vault/list",
      "/api/bootstrap?vault=Team",
      "/api/fs/readFile?vault=Team&path=note.md",
      "/vault-files/Team/note.md",
      "/api/ext/headless-sync/status",
    ]) {
      const res = await request(port, route);
      expect(res.status).toBe(401);
      expect(res.text).not.toContain("private-note-marker");
    }
    const jar = {};
    const challenge = JSON.parse(
      (await request(port, "/api/auth/csrf", jar)).text,
    ).csrfToken;
    const login = await request(
      port,
      "/api/auth/login?code=SECRET_CALLBACK_MARKER",
      jar,
      {
        method: "POST",
        headers: { "x-ignis-csrf": challenge },
        body: { login: "admin", password },
      },
    );
    expect(login.status).toBe(200);
    const appPage = await request(port, "/", jar);
    // A clean source checkout may run npm test before building the browser bundles.
    if (
      fs.existsSync("packages/ui/dist/ignis-ui.js") &&
      fs.existsSync("packages/shim/dist/shim-loader.js")
    ) {
      expect(appPage.status).toBe(200);
      expect(appPage.text).toContain("/auth/client.js");
      expect(appPage.text).toMatch(/ignis-ui\.js\?v=[^" ]+-[a-f0-9]{16}/);
      expect(appPage.text).toMatch(/shim-loader\.js\?v=[^" ]+-[a-f0-9]{16}/);
      expect(appPage.text).not.toContain("__IGNIS_UI_SRC__");
    } else {
      expect(appPage.status).toBe(500);
    }
    expect(
      (await request(port, "/api/fs/readFile?vault=Team&path=note.md", jar))
        .text,
    ).toBe("private-note-marker");
    expect((await request(port, "/vault-files/Team/note.md", jar)).text).toBe(
      "private-note-marker",
    );
    expect((await request(port, "/api/bootstrap?vault=Team", jar)).status).toBe(
      200,
    );
    expect((await request(port, "/api/vault/list", jar)).status).toBe(200);
    const visibleVaults = JSON.parse((await request(port, "/api/vault/list", jar)).text);
    expect(visibleVaults.some(vault => ["Interrupted", "Alias"].includes(vault.id))).toBe(false);
    expect((await request(port, "/vault-files/Alias/.obsidian/plugins/ignis-bridge/keep", jar)).status).toBe(404);
    expect((await request(port, "/api/vault/info?vault=Interrupted", jar)).status).toBe(404);
    expect((await request(port, "/vault-files/Interrupted/.obsidian/plugins/ignis-bridge/keep", jar)).status).toBe(404);
    expect(fs.readFileSync(path.join(root, "vaults", "Interrupted", ".obsidian", "plugins", "ignis-bridge", "keep"), "utf8")).toBe("preserve");
    const createCsrf = JSON.parse((await request(port, "/api/auth/csrf", jar)).text).csrfToken;
    expect((await request(port, "/api/vault/create", jar, { method: "POST", body: { name: "Created" } })).status).toBe(403);
    expect((await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Created", ownerId: "other" } })).status).toBe(400);
    const created = await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Created" } });
    expect(created.status).toBe(200);
    const result = JSON.parse(created.text);
    expect(result.id).toBe("Created"); expect(result.uuid).toMatch(/^[a-f0-9-]{36}$/);
    const checkDb = openDatabase(path.join(root, "data"));
    try {
      expect(checkDb.prepare("SELECT v.status,u.login,m.role FROM vaults v JOIN memberships m ON m.vault_id=v.id JOIN users u ON u.id=m.user_id WHERE v.id=?").get(result.uuid))
        .toEqual({ status: "active", login: "admin", role: "owner" });
    } finally { checkDb.close(); }
    expect(fs.existsSync(path.join(root, "vaults", "Created", ".obsidian"))).toBe(true);
    expect((await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Created" } })).status).toBe(409);
    expect((await request(port, "/api/vault/rename", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { vault: "Created", name: "Renamed" } })).status).toBe(409);
    expect((await request(port, "/api/vault/remove?vault=Created", jar, { method: "DELETE", headers: { "x-ignis-csrf": createCsrf } })).status).toBe(409);

    const csrf = JSON.parse(
      (await request(port, "/api/auth/csrf", jar)).text,
    ).csrfToken;
    const write = await request(port, "/api/fs/writeFile", jar, {
      method: "POST",
      headers: { "x-ignis-csrf": csrf },
      body: { vault: "Team", path: "new.md", content: "authorized" },
    });
    expect(write.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "vaults/Team/new.md"), "utf8")).toBe(
      "authorized",
    );
    const logout = await request(port, "/api/auth/logout", jar, {
      method: "POST",
      headers: { "x-ignis-csrf": csrf },
      body: {},
    });
    expect(logout.status).toBe(204);
    expect((await request(port, "/api/vault/list", jar)).status).toBe(401);
    expect(processState.logs()).not.toContain(password);
    expect(processState.logs()).not.toContain("SECRET_CALLBACK_MARKER");
    expect(processState.logs()).not.toContain(challenge);
  } finally {
    await stop(processState.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
it("does not listen when security configuration or identity storage is invalid", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-closed-start-"));
  try {
    for (const env of [
      { IGNIS_PUBLIC_ORIGIN: "" },
      {
        IGNIS_PUBLIC_ORIGIN: "http://public.example",
        IGNIS_ALLOW_HTTP_LOOPBACK: "false",
      },
    ]) {
      const state = await launch(root, env);
      await expect(state.ready).rejects.toThrow(/exited/);
      expect(state.logs()).not.toContain("Server running");
      await stop(state.child);
    }
    fs.mkdirSync(path.join(root, "data/auth"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data/auth/identity.sqlite"),
      "corrupt database",
    );
    const state = await launch(root);
    await expect(state.ready).rejects.toThrow(/exited/);
    expect(state.logs()).not.toContain("Server running");
    await stop(state.child);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
