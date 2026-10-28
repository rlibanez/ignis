import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { scrypt, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const {
  openDatabase,
  transaction,
  backupDatabase,
  restoreDatabase,
} = require("./database");
const { bootstrapAdmin, normalizeLogin, registerVault } = require("./store");
const { hashPassword } = require("./password");
const fixtureHash =
  "scrypt$131072$8$1$" + "ab".repeat(16) + "$" + "cd".repeat(64);
let root, db;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-identity-"));
  db = openDatabase(path.join(root, "data"));
});
afterEach(() => {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function child(code) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.on("error", reject);
    proc.on("close", (status) => resolve({ status, stderr }));
  });
}

describe("identity persistence", () => {
  it("migrates idempotently, retains stable identities and uses private files", () => {
    const user = bootstrapAdmin(db, "Admin", fixtureHash);
    fs.mkdirSync(path.join(root, "Team"));
    const vault = registerVault(db, root, "Team", user.id);
    expect(
      db
        .prepare("SELECT role FROM memberships WHERE vault_id = ?")
        .get(vault.id).role,
    ).toBe("owner");
    db.close();
    db = null;
    db = openDatabase(path.join(root, "data"));
    expect(db.prepare("SELECT id FROM users").get().id).toBe(user.id);
    expect(db.prepare("SELECT id FROM vaults").get().id).toBe(vault.id);
    expect(
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n,
    ).toBe(5);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(root, "data/auth")).mode & 0o777).toBe(
        0o700,
      );
      expect(
        fs.statSync(path.join(root, "data/auth/identity.sqlite")).mode & 0o777,
      ).toBe(0o600);
    }
    expect(() => registerVault(db, root, "Team", user.id)).toThrow();
  });

  it("enforces constraints, foreign keys, rollback and last administrator invariants", () => {
    const user = bootstrapAdmin(db, "Admin", fixtureHash);
    expect(() => bootstrapAdmin(db, "other", fixtureHash)).toThrow(/already/);
    expect(() =>
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id),
    ).toThrow(/last/);
    expect(() =>
      db.prepare("UPDATE users SET status = 'disabled'").run(),
    ).toThrow(/last/);
    expect(() => db.prepare("UPDATE users SET role = 'user'").run()).toThrow(
      /last/,
    );
    expect(() =>
      db
        .prepare("INSERT INTO memberships VALUES ('missing', ?, 'owner')")
        .run(user.id),
    ).toThrow();
    expect(() => db.prepare("UPDATE users SET role = 'root'").run()).toThrow();
    expect(() =>
      transaction(db, () => {
        db.prepare("UPDATE users SET login = 'changed'").run();
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.prepare("SELECT login FROM users").get().login).toBe("admin");
    expect(() => transaction(db, () => Promise.resolve())).toThrow(
      /synchronous/,
    );
  });

  it("rejects future or modified migration history without bootstrapping over it", () => {
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered'").run();
    db.close();
    db = null;
    expect(() => openDatabase(path.join(root, "data"))).toThrow(/schema/);
  });

  it("rejects corrupt databases instead of replacing them", () => {
    db.close();
    db = null;
    const file = path.join(root, "data/auth/identity.sqlite");
    fs.writeFileSync(file, "not a sqlite database");
    expect(() => openDatabase(path.join(root, "data"))).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("not a sqlite database");
  });

  it("takes a consistent WAL snapshot and restores only into a fresh directory", () => {
    const user = bootstrapAdmin(db, "Admin", fixtureHash);
    const backup = path.join(root, "backup.sqlite");
    backupDatabase(db, backup);
    expect(() => backupDatabase(db, backup)).toThrow();
    restoreDatabase(backup, path.join(root, "restored"));
    const restored = openDatabase(path.join(root, "restored"));
    try {
      expect(restored.prepare("SELECT id FROM users").get().id).toBe(user.id);
      expect(() => bootstrapAdmin(restored, "newadmin", fixtureHash)).toThrow(
        /already/,
      );
    } finally {
      restored.close();
    }
    expect(() => restoreDatabase(backup, path.join(root, "data"))).toThrow();
    expect(() =>
      restoreDatabase(backup, path.join(root, "restored")),
    ).toThrow();
  });

  it("rejects invalid restores and removes incomplete restore targets", () => {
    const bad = path.join(root, "bad.sqlite");
    fs.writeFileSync(bad, "invalid");
    expect(() => restoreDatabase(bad, path.join(root, "restore"))).toThrow();
    expect(fs.existsSync(path.join(root, "restore/auth"))).toBe(false);
  });

  it("does not register missing owners, traversal or linked vaults", () => {
    const user = bootstrapAdmin(db, "Admin", fixtureHash);
    fs.mkdirSync(path.join(root, "Team"));
    expect(() => registerVault(db, root, "Team", "missing")).toThrow(/active/);
    expect(() => registerVault(db, root, "../Team", user.id)).toThrow(
      /directory/,
    );
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(root, "Team"), path.join(root, "Alias"));
      expect(() => registerVault(db, root, "Alias", user.id)).toThrow(
        /real directory/,
      );
    }
    expect(db.prepare("SELECT count(*) AS n FROM vaults").get().n).toBe(0);
  });

  it("rejects database aliases", () => {
    if (process.platform === "win32") return;
    db.close();
    db = null;
    fs.linkSync(
      path.join(root, "data/auth/identity.sqlite"),
      path.join(root, "alias"),
    );
    expect(() => openDatabase(path.join(root, "data"))).toThrow(/Unsafe/);
  });

  it("serializes fresh migrations and administrator bootstrap across processes", async () => {
    const location = path.join(root, "concurrent");
    const code = `const {openDatabase}=require(${JSON.stringify(require.resolve("./database"))});
      const {bootstrapAdmin}=require(${JSON.stringify(require.resolve("./store"))});
      const db=openDatabase(${JSON.stringify(location)});
      try {bootstrapAdmin(db,'admin',${JSON.stringify(fixtureHash)});}
      catch(e) {if(e.message.includes('already')) process.exitCode=3; else throw e;}
      finally {db.close();}`;
    const results = await Promise.all([child(code), child(code), child(code)]);
    expect(
      results.map((r) => r.status).sort(),
      JSON.stringify(results),
    ).toEqual([0, 3, 3]);
    const concurrent = openDatabase(location);
    try {
      expect(
        concurrent.prepare("SELECT count(*) AS n FROM users").get().n,
      ).toBe(1);
      expect(
        concurrent.prepare("SELECT count(*) AS n FROM audit_events").get().n,
      ).toBe(1);
    } finally {
      concurrent.close();
    }
  });

  it("has session uniqueness, user references and timestamp constraints", () => {
    const user = bootstrapAdmin(db, "Admin", fixtureHash);
    const insert = db.prepare(
      "INSERT INTO sessions VALUES (?, hex(randomblob(16)), ?, 1, 100, 100, ?, 50, 'local', NULL, NULL, 100)",
    );
    insert.run("a".repeat(64), user.id, 200);
    expect(() => insert.run("a".repeat(64), user.id, 200)).toThrow();
    expect(() => insert.run("b".repeat(64), "missing", 200)).toThrow();
    expect(() => insert.run("c".repeat(64), user.id, 99)).toThrow();
  });

  it("rejects future schema on restore", () => {
    const file = path.join(root, "future.sqlite");
    backupDatabase(db, file);
    const future = new DatabaseSync(file);
    future
      .prepare("INSERT INTO schema_migrations VALUES (99, ?, 0)")
      .run("future");
    future.close();
    expect(() =>
      restoreDatabase(file, path.join(root, "future-target")),
    ).toThrow(/schema/);
  });
});

describe("migration and crash recovery", () => {
  it("rolls back every statement of a failed migration", () => {
    const migrations = require("./schema");
    migrations.push({
      version: 4,
      sql: "CREATE TABLE incomplete(id TEXT); INVALID SQL;",
    });
    db.close();
    db = null;
    try {
      expect(() => openDatabase(path.join(root, "data"))).toThrow();
    } finally {
      migrations.pop();
    }
    db = openDatabase(path.join(root, "data"));
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'incomplete'")
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n,
    ).toBe(5);
  });

  it("recovers after a process exits in an uncommitted write transaction", async () => {
    bootstrapAdmin(db, "Admin", fixtureHash);
    const code = `const {openDatabase}=require(${JSON.stringify(require.resolve("./database"))});
      const db=openDatabase(${JSON.stringify(path.join(root, "data"))});
      db.exec("BEGIN IMMEDIATE; UPDATE users SET login = 'uncommitted'");
      process.exit(7);`;
    const result = await child(code);
    expect(result.status, result.stderr).toBe(7);
    db.close();
    db = null;
    db = openDatabase(path.join(root, "data"));
    expect(db.prepare("SELECT login FROM users").get().login).toBe("admin");
  });
});

describe("bootstrap credentials and CLI", () => {
  it("normalizes only an explicit ASCII login alphabet", () => {
    expect(normalizeLogin("Alice.Test")).toBe("alice.test");
    for (const bad of ["", "ab", " admin", "admın", "a/b", null]) {
      expect(() => normalizeLogin(bad)).toThrow();
    }
  });

  it("hashes with random salt and the documented cost, without storing plaintext", async () => {
    const password = "a long bootstrap passphrase";
    const encoded = await hashPassword(password);
    const second = await hashPassword(password);
    expect(encoded).not.toEqual(second);
    expect(encoded).not.toContain(password);
    const [algorithm, n, r, p, salt, hash] = encoded.split("$");
    expect(algorithm).toBe("scrypt");
    const result = await promisify(scrypt)(
      password,
      Buffer.from(salt, "hex"),
      64,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 },
    );
    expect(result.toString("hex")).toBe(hash);
    await expect(hashPassword("short")).rejects.toThrow();
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow();
  });

  it("refuses password arguments and non-interactive bootstrap", () => {
    const cli = require.resolve("./cli");
    const env = { ...process.env, DATA_ROOT: path.join(root, "cli") };
    const extra = spawnSync(process.execPath, [cli, "bootstrap", "password"], {
      env,
      encoding: "utf8",
    });
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("Usage:");
    const pipe = spawnSync(process.execPath, [cli, "bootstrap"], {
      env,
      encoding: "utf8",
      input: "secret\n",
    });
    expect(pipe.status).toBe(1);
    expect(pipe.stderr).toContain("interactive terminal");
    expect(pipe.stderr).not.toContain("secret");
  });
});

describe("authentication methods independent of users", () => {
  it("migrates v1 credentials and memberships while revoking legacy sessions", () => {
    const filename = path.join(root, "legacy/auth/identity.sqlite");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const legacy = new DatabaseSync(filename);
    const migration = require("./schema")[0];
    legacy.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
    );
    legacy.exec(migration.sql);
    legacy
      .prepare("INSERT INTO schema_migrations VALUES (1, ?, 1)")
      .run(createHash("sha256").update(migration.sql).digest("hex"));
    legacy
      .prepare(
        "INSERT INTO users(id, login, password_hash, role, created_at) VALUES ('existing', 'admin', ?, 'admin', 1)",
      )
      .run(fixtureHash);
    legacy.exec(
      "INSERT INTO bootstrap_state VALUES (1, 1); INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('vault','Team','Team','active',1); INSERT INTO memberships VALUES ('vault','existing','owner')",
    );
    legacy
      .prepare("INSERT INTO sessions VALUES (?, 'existing', 1, 1, 1, 100)")
      .run("a".repeat(64));
    legacy.close();
    const upgraded = openDatabase(path.join(root, "legacy"));
    try {
      expect(upgraded.prepare("SELECT * FROM users").get()).not.toHaveProperty(
        "password_hash",
      );
      expect(
        upgraded.prepare("SELECT * FROM local_credentials").get(),
      ).toMatchObject({ user_id: "existing", password_hash: fixtureHash });
      expect(
        upgraded.prepare("SELECT user_id FROM memberships").get().user_id,
      ).toBe("existing");
      expect(
        upgraded.prepare("SELECT user_id FROM sessions").get(),
      ).toBeUndefined();
      expect(() => bootstrapAdmin(upgraded, "second", fixtureHash)).toThrow(
        /already/,
      );
    } finally {
      upgraded.close();
    }
  });

  it("supports external-only users and keys identities by exact issuer and subject", () => {
    db.exec(
      "INSERT INTO users(id,login,role,created_at) VALUES ('external','external-user','user',1)",
    );
    db.exec(
      "INSERT INTO users(id,login,role,created_at) VALUES ('other','another-user','user',1)",
    );
    const insert = db.prepare(
      "INSERT INTO oidc_identities VALUES (?, ?, ?, 1)",
    );
    insert.run("https://issuer.example", "subject", "external");
    insert.run("https://another.example", "subject", "external");
    insert.run("https://issuer.example", "Subject", "other");
    expect(() =>
      insert.run("https://issuer.example", "subject", "other"),
    ).toThrow();
    expect(() =>
      insert.run("https://issuer.example", "unknown", "missing"),
    ).toThrow();
    expect(
      db
        .prepare("SELECT * FROM local_credentials WHERE user_id = 'external'")
        .get(),
    ).toBeUndefined();
    db.exec("DELETE FROM users WHERE id = 'external'");
    expect(
      db.prepare("SELECT count(*) AS n FROM oidc_identities").get().n,
    ).toBe(1);
  });

  it("bootstraps a local credential separately from the internal account", () => {
    const user = bootstrapAdmin(db, "Admin", fixtureHash);
    expect(
      db.prepare("SELECT * FROM users WHERE id = ?").get(user.id),
    ).not.toHaveProperty("password_hash");
    expect(
      db
        .prepare(
          "SELECT password_hash FROM local_credentials WHERE user_id = ?",
        )
        .get(user.id).password_hash,
    ).toBe(fixtureHash);
    expect(
      db.prepare("SELECT count(*) AS n FROM oidc_identities").get().n,
    ).toBe(0);
  });
});
