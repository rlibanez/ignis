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
          resolve({ status: res.statusCode, text, headers: res.headers });
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
  for (const filename of ["active.html", "active.js", "active.svg", "image.png"]) {
    fs.writeFileSync(path.join(root, "vaults", "Team", filename), "<script>window.evil = true</script>");
  }
  const password = "synthetic-real-server-password";
  const db = openDatabase(path.join(root, "data"));
  bootstrapAdmin(db, "admin", await hashPassword(password));
  db.exec("INSERT INTO users(id,login,role,created_at) VALUES ('normal-owner','normal-owner','user',0)");
  db.exec("INSERT INTO local_credentials SELECT 'normal-owner', password_hash, updated_at FROM local_credentials LIMIT 1");
  db.exec("INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('interrupted','Interrupted','Interrupted','pending',0)");
  fs.mkdirSync(path.join(root, "vaults", "Interrupted", ".obsidian", "plugins", "ignis-bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "vaults", "Interrupted", ".obsidian", "plugins", "ignis-bridge", "keep"), "preserve");
  fs.symlinkSync(path.join(root, "vaults", "Interrupted"), path.join(root, "vaults", "Alias"));
  fs.mkdirSync(path.join(root, "vaults", ".ignis-trash", "preserved"), { recursive: true });
  fs.writeFileSync(path.join(root, "vaults", ".ignis-trash", "preserved", "keep"), "staged-private-marker");
  fs.symlinkSync(path.join(root, "vaults", ".ignis-trash", "preserved"), path.join(root, "vaults", "TrashAlias"));
  db.close();
  const processState = await launch(root);
  try {
    const port = await processState.ready;
    for (const route of [
      "/api/vault/list",
      "/api/vault/registration",
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
    for (const filename of ["active.html", "active.js", "active.svg", "image.png"]) {
      const media = await request(port, `/vault-files/Team/${filename}`, jar);
      expect(media.status).toBe(200);
      expect(media.headers["content-type"]).toBe(filename === "image.png" ? "image/png" : "application/octet-stream");
      expect(media.headers["content-disposition"]).toBe(filename === "image.png" ? "inline" : "attachment");
      expect(media.headers["content-security-policy"]).toContain("sandbox;");
      expect(media.headers["x-content-type-options"]).toBe("nosniff");
      expect(media.headers["cache-control"]).toBe("no-store");
    }
    expect((await request(port, "/vault-files/Team/", jar)).status).toBe(404);
    expect((await request(port, "/vault-files/Team/index.html", jar)).status).toBe(404);
    expect((await request(port, "/api/bootstrap?vault=Team", jar)).status).toBe(
      200,
    );
    expect((await request(port, "/api/vault/list", jar)).status).toBe(200);
    const visibleVaults = JSON.parse((await request(port, "/api/vault/list", jar)).text);
    expect(visibleVaults.some(vault => ["Interrupted", "Alias", ".ignis-trash", "TrashAlias"].includes(vault.id))).toBe(false);
    expect((await request(port, "/vault-files/Alias/.obsidian/plugins/ignis-bridge/keep", jar)).status).toBe(404);
    expect((await request(port, "/api/vault/info?vault=Interrupted", jar)).status).toBe(404);
    expect((await request(port, "/vault-files/Interrupted/.obsidian/plugins/ignis-bridge/keep", jar)).status).toBe(404);
    expect(fs.readFileSync(path.join(root, "vaults", "Interrupted", ".obsidian", "plugins", "ignis-bridge", "keep"), "utf8")).toBe("preserve");
    expect((await request(port, "/vault-files/TrashAlias/keep", jar)).status).toBe(404);
    expect((await request(port, "/vault-files/.ignis-trash/preserved/keep", jar)).status).toBe(404);
    expect((await request(port, "/api/fs/readFile?vault=TrashAlias&path=keep", jar)).status).toBe(404);
    expect(fs.readFileSync(path.join(root, "vaults", ".ignis-trash", "preserved", "keep"), "utf8")).toBe("staged-private-marker");
    const createCsrf = JSON.parse((await request(port, "/api/auth/csrf", jar)).text).csrfToken;
    expect((await request(port, "/api/vault/rename", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { vault: "Team", name: "Moved" } })).status).toBe(409);
    expect((await request(port, "/api/vault/remove?vault=Team", jar, { method: "DELETE", headers: { "x-ignis-csrf": createCsrf } })).status).toBe(409);
    const registration = JSON.parse((await request(port, "/api/vault/registration", jar)).text);
    const candidate = registration.vaults.find(vault => vault.directory === "Team");
    expect(candidate.eligible).toBe(true);
    const registerBody = { directory: "Team", ownerId: "normal-owner", identity: candidate.identity };
    expect((await request(port, "/api/vault/register", jar, { method: "POST", body: registerBody })).status).toBe(403);
    expect((await request(port, "/api/vault/register", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { ...registerBody, role: "owner" } })).status).toBe(400);
    expect((await request(port, "/api/vault/register", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { ...registerBody, identity: "0".repeat(64) } })).status).toBe(409);
    const registered = await request(port, "/api/vault/register", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: registerBody });
    expect(registered.status).toBe(200);
    for (const route of ["/api/fs/rm?vault=Team&path=.&recursive=true", "/api/fs/rmdir?vault=Team&path="]) {
      expect((await request(port, route, jar, { method: "DELETE", headers: { "x-ignis-csrf": createCsrf } })).status).toBe(403);
    }
    expect((await request(port, "/api/fs/rename", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { vault: "Team", oldPath: ".", newPath: "moved" } })).status).toBe(403);
    expect((await request(port, "/api/fs/stat?vault=Team&path=", jar)).status).toBe(200);

    const ownerJar = {};
    const ownerChallenge = JSON.parse((await request(port, "/api/auth/csrf", ownerJar)).text).csrfToken;
    expect((await request(port, "/api/auth/login", ownerJar, { method: "POST", headers: { "x-ignis-csrf": ownerChallenge }, body: { login: "normal-owner", password } })).status).toBe(200);
    expect((await request(port, "/api/vault/registration", ownerJar)).status).toBe(403);
    expect((await request(port, "/api/vault/register", ownerJar, { method: "POST", body: registerBody })).status).toBe(403);
    expect((await request(port, "/api/fs/readFile?vault=Team&path=note.md", ownerJar)).status).toBe(200);

    const ownerCsrf = JSON.parse((await request(port, "/api/auth/csrf", ownerJar)).text).csrfToken;
    const ownUuid = JSON.parse(registered.text).uuid;
    const ownerList = JSON.parse((await request(port, "/api/vault/list", ownerJar)).text);
    expect(ownerList.map(v => v.id)).toEqual(["Team"]);
    expect(ownerList[0].path).toBeUndefined();
    const ownBoot = await request(port, `/api/bootstrap?vault=${ownUuid}`, ownerJar);
    expect(ownBoot.status).toBe(200);
    expect(JSON.parse(ownBoot.text)).toMatchObject({ configurationMode: "private", plugins: [], virtualPlugins: [] });
    expect((await request(port, `/api/fs/writeFile?vault=${ownUuid}`, ownerJar, {
      method: "POST", headers: { "x-ignis-csrf": ownerCsrf }, body: { path: "owner-note.md", content: "owner-write" },
    })).status).toBe(200);
    expect((await request(port, `/api/fs/readFile?vault=${ownUuid}&path=owner-note.md`, ownerJar)).text).toBe("owner-write");
    expect((await request(port, `/api/fs/writeFile?vault=${ownUuid}`, ownerJar, {
      method: "POST", body: { path: "no-csrf.md", content: "forbidden" },
    })).status).toBe(403);
    expect((await request(port, `/api/fs/readFile?vault=${ownUuid}&path=.obsidian/app.json`, ownerJar)).status).toBe(404);
    for (const route of ["/api/settings", "/api/plugins", "/api/ext/headless-sync/status"]) {
      expect((await request(port, route, ownerJar)).status).toBe(403);
    }
    expect((await request(port, "/api/fs/writeFile", ownerJar, {
      method: "POST", headers: { "x-ignis-csrf": ownerCsrf }, body: { path: "implicit.md", content: "forbidden" },
    })).status).toBe(404);
    expect(JSON.parse(registered.text)).toMatchObject({ id: "Team", ok: true });
    const registrationDb = openDatabase(path.join(root, "data"));
    try {
      expect(registrationDb.prepare("SELECT user_id,role FROM memberships WHERE vault_id=?").get(JSON.parse(registered.text).uuid)).toEqual({ user_id: "normal-owner", role: "owner" });
    } finally { registrationDb.close(); }
    expect((await request(port, "/api/vault/register", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: registerBody })).status).toBe(409);
    expect(fs.readFileSync(path.join(root, "vaults", "Team", "note.md"), "utf8")).toBe("private-note-marker");

    expect((await request(port, "/api/vault/create", jar, { method: "POST", body: { name: "Created" } })).status).toBe(403);
    expect((await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Created", ownerId: "other" } })).status).toBe(409);
    const ownerOptions = JSON.parse((await request(port, "/api/vault/owners", jar)).text);
    expect(ownerOptions.owners.some(user => user.id === "normal-owner")).toBe(true);
    expect((await request(port, "/api/vault/owners", ownerJar)).status).toBe(403);
    expect((await request(port, "/api/vault/create", ownerJar, { method: "POST", body: { name: "Unauthorized", ownerId: "normal-owner" } })).status).toBe(403);
    for (const ownerId of [null, "", [], {}]) {
      expect((await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "InvalidOwner", ownerId } })).status).toBe(400);
    }
    const owned = await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Owned", ownerId: "normal-owner" } });
    expect(owned.status).toBe(200);
    const ownedDb = openDatabase(path.join(root, "data"));
    try {
      expect(ownedDb.prepare("SELECT user_id,role FROM memberships WHERE vault_id=?").all(JSON.parse(owned.text).uuid)).toEqual([{ user_id: "normal-owner", role: "owner" }]);
    } finally { ownedDb.close(); }
    const created = await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Created" } });
    expect(created.status).toBe(200);
    const result = JSON.parse(created.text);
    expect(result.id).toBe("Created"); expect(result.uuid).toMatch(/^[a-f0-9-]{36}$/);
    const mixedDir = path.join(root, "vaults", "Created", "Mixed");
    fs.mkdirSync(path.join(mixedDir, ".ignis-secret"), { recursive: true });
    fs.writeFileSync(path.join(mixedDir, "public.md"), "public data");
    fs.writeFileSync(path.join(mixedDir, ".ignis-secret", "unique-private.md"), "secret data");

    const checkDb = openDatabase(path.join(root, "data"));
    try {
      expect(checkDb.prepare("SELECT v.status,u.login,m.role FROM vaults v JOIN memberships m ON m.vault_id=v.id JOIN users u ON u.id=m.user_id WHERE v.id=?").get(result.uuid))
        .toEqual({ status: "active", login: "admin", role: "owner" });
    } finally { checkDb.close(); }
    expect(fs.existsSync(path.join(root, "vaults", "Created", ".obsidian"))).toBe(true);
    expect((await request(port, `/api/vault/info?vault=${result.uuid}`, jar)).status).toBe(200);
    const uuidBootstrap = await request(port, `/api/bootstrap?vault=${result.uuid}`, jar);
    expect(uuidBootstrap.status).toBe(200);
    expect(JSON.parse(uuidBootstrap.text).vault).toMatchObject({ id: "Created", uuid: result.uuid });
    expect(JSON.parse(uuidBootstrap.text).vaultList.find(v => v.id === "Created").uuid).toBe(result.uuid);
    expect(JSON.parse(uuidBootstrap.text).tree).toHaveProperty("Mixed/public.md");
    expect(Object.keys(JSON.parse(uuidBootstrap.text).tree).some(p => p.includes(".ignis-secret"))).toBe(false);
    const treeResult = await request(port, `/api/fs/tree?vault=${result.uuid}`, jar);
    expect(treeResult.status).toBe(200);
    expect(treeResult.text).not.toContain("unique-private.md");
    const batch = await request(port, `/api/fs/batch-read?vault=${result.uuid}`, jar, {
      method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { paths: ["Mixed/public.md", "Mixed/.ignis-secret/unique-private.md"] },
    });
    expect(JSON.parse(batch.text).files).toEqual({ "Mixed/public.md": "public data" });
    const zip = await request(port, `/api/fs/download-zip?vault=${result.uuid}&path=Mixed`, jar);
    expect(zip.status).toBe(200);
    expect(zip.text).toContain("public.md");
    expect(zip.text).not.toContain("unique-private.md");
    const recursiveDelete = await request(port, `/api/fs/rm?vault=${result.uuid}&path=Mixed&recursive=true`, jar, { method: "DELETE", headers: { "x-ignis-csrf": createCsrf } });
    expect(recursiveDelete.status).toBe(404);
    const move = await request(port, `/api/fs/rename?vault=${result.uuid}`, jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { oldPath: "Mixed", newPath: "Moved" } });
    expect(move.status).toBe(404);
    expect(fs.readFileSync(path.join(mixedDir, "public.md"), "utf8")).toBe("public data");
    expect(fs.existsSync(path.join(root, "vaults", "Created", "Moved"))).toBe(false);

    // Registered file routes run the capability evaluator, including admin requests.
    for (const endpoint of ["writeFile", "appendFile", "utimes"]) {
      const deniedFile = await request(port, `/api/fs/${endpoint}?vault=${result.uuid}`, jar, {
        method: "POST", headers: { "x-ignis-csrf": createCsrf },
        body: { path: ".ignis-private/secret.md", content: "must not write", atime: 0, mtime: 0 },
      });
      expect(deniedFile.status).toBe(404);
    }
    expect(fs.existsSync(path.join(root, "vaults", "Created", ".ignis-private"))).toBe(false);
    for (const endpoint of ["readFile", "download"])
      expect((await request(port, `/api/fs/${endpoint}?vault=${result.uuid}&path=.ignis-private/secret.md`, jar)).status).toBe(404);

    expect((await request(port, `/api/fs/tree?vault=${result.uuid}`, ownerJar)).status).toBe(404);
    expect((await request(port, `/api/fs/writeFile?vault=${result.uuid}`, jar, {
      method: "POST", headers: { "x-ignis-csrf": createCsrf },
      body: { vault: "Created", path: "identity.md", content: "stable identity" },
    })).status).toBe(200);
    expect((await request(port, `/api/fs/writeFile?vault=${result.uuid}`, jar, {
      method: "POST", headers: { "x-ignis-csrf": createCsrf },
      body: { vault: "Team", path: "conflict.md", content: "must not write" },
    })).status).toBe(400);
    expect(fs.existsSync(path.join(root, "vaults", "Team", "conflict.md"))).toBe(false);

    expect((await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Created" } })).status).toBe(409);
    expect((await request(port, "/api/vault/rename", jar, { method: "POST", body: { vault: "Created", name: "Renamed" } })).status).toBe(403);
    const renamed = await request(port, "/api/vault/rename", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { vault: "Created", name: "Renamed" } });
    expect(renamed.status).toBe(200);
    expect(JSON.parse(renamed.text)).toMatchObject({ id: "Renamed", uuid: result.uuid });
    expect(fs.existsSync(path.join(root, "vaults", "Renamed", ".obsidian"))).toBe(true);
    expect(fs.existsSync(path.join(root, "vaults", "Created"))).toBe(false);
    const byUuid = await request(port, `/api/fs/readFile?vault=${result.uuid}&path=identity.md`, jar);
    expect(byUuid.status).toBe(200);
    expect(byUuid.text).toContain("stable identity");
    const attachment = await request(port, `/vault-files/${result.uuid}/identity.md`, jar);
    expect(attachment.status).toBe(200);
    expect(attachment.text).toBe("stable identity");
    expect(attachment.headers["content-type"]).toBe("application/octet-stream");
    expect(attachment.headers["content-disposition"]).toBe("attachment");
    expect(attachment.headers["content-security-policy"]).toContain("sandbox;");
    expect((await request(port, "/api/fs/tree?vault=Created", jar)).status).toBe(404);

    expect((await request(port, "/api/vault/remove?vault=Renamed", jar, { method: "DELETE", headers: { "x-ignis-csrf": createCsrf } })).status).toBe(409);
    const listed = JSON.parse((await request(port, "/api/vault/list", jar)).text);
    expect(listed.find(vault => vault.id === "Renamed").uuid).toBe(result.uuid);
    const removeUrl = "/api/vault/remove?vault=" + result.uuid;
    expect((await request(port, removeUrl, jar, { method: "DELETE" })).status).toBe(403);
    const removed = await request(port, removeUrl, jar, { method: "DELETE", headers: { "x-ignis-csrf": createCsrf } });
    expect(removed.status).toBe(200);
    expect(JSON.parse(removed.text)).toMatchObject({ uuid: result.uuid, cleanupPending: false });
    expect(fs.existsSync(path.join(root, "vaults", "Renamed"))).toBe(false);
    const replacement = await request(port, "/api/vault/create", jar, { method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { name: "Renamed" } });
    expect(replacement.status).toBe(200);
    expect(JSON.parse(replacement.text).uuid).not.toBe(result.uuid);
    expect((await request(port, `/api/fs/tree?vault=${result.uuid}`, jar)).status).toBe(404);
    expect((await request(port, `/api/bootstrap?vault=${result.uuid}`, jar)).status).toBe(404);
    expect((await request(port, `/api/fs/writeFile?vault=${result.uuid}`, jar, {
      method: "POST", headers: { "x-ignis-csrf": createCsrf }, body: { path: "old.md", content: "must not write" },
    })).status).toBe(404);
    expect(fs.existsSync(path.join(root, "vaults", "Renamed", "old.md"))).toBe(false);
    expect((await request(port, `/vault-files/${result.uuid}/identity.md`, jar)).status).toBe(404);

    expect((await request(port, removeUrl, jar, { method: "DELETE", headers: { "x-ignis-csrf": createCsrf } })).status).toBe(410);
    expect(fs.existsSync(path.join(root, "vaults", "Renamed"))).toBe(true);


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
