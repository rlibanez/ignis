import { it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const migrations = require("../schema");
const { setUserEmail, normalizeEmail } = require("../email");
const { resolveOidcAccount, linkOidcAccount } = require("./accounts");
const { readOidcConfig } = require("./config");
let db;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const m of migrations) db.exec(m.sql);
});
afterEach(() => db.close());
function user(id = "u01", role = "user") {
  db.prepare(
    "INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)",
  ).run(id, id, role);
  return id;
}
const config = (accountLinking = "disabled", autoProvision = false) => ({
  issuer: "https://idp.example",
  accountLinking,
  autoProvision,
});
const identity = (patch) => ({
  issuer: "https://idp.example",
  subject: "subject",
  preferredUsername: "u01",
  email: "User@example.com",
  emailVerified: true,
  ...patch,
});
it("adds nullable emails to existing accounts without changing IDs or credentials", () => {
  const old = new DatabaseSync(":memory:");
  try {
    for (const m of migrations.slice(0, 3)) old.exec(m.sql);
    old
      .prepare(
        "INSERT INTO users(id,login,role,created_at) VALUES ('old','old','admin',0)",
      )
      .run();
    old
      .prepare("INSERT INTO local_credentials VALUES ('old','synthetic',0)")
      .run();
    old.exec(migrations[3].sql);
    expect(
      old.prepare("SELECT id,email,email_trust FROM users").get(),
    ).toMatchObject({ id: "old", email: null, email_trust: "unverified" });
    expect(
      old.prepare("SELECT password_hash FROM local_credentials").get()
        .password_hash,
    ).toBe("synthetic");
  } finally {
    old.close();
  }
});
it("normalizes email conservatively and rejects invalid addresses", () => {
  expect(normalizeEmail("User+tag@EXAMPLE.COM")).toBe("user+tag@example.com");
  for (const value of [
    "",
    " a@b.com",
    "a..b@c.com",
    "a@localhost",
    "a@-example.com",
    "a@ex\nample.com",
    "a@b.com@c.com",
    "ü@example.com",
  ])
    expect(() => normalizeEmail(value)).toThrow();
});
it("admin confirmation is explicit, emails are unique, and changing them resets trust", () => {
  user();
  user("u02");
  user("admin", "admin");
  setUserEmail(db, "u01", "User@example.com", "admin_confirmed", "admin");
  expect(() => setUserEmail(db, "u02", "USER@example.com")).toThrow();
  expect(() =>
    setUserEmail(db, "u02", "other@example.com", "admin_confirmed", "u01"),
  ).toThrow();
  setUserEmail(db, "u01", "new@example.com");
  expect(
    db
      .prepare("SELECT email_trust, auth_version FROM users WHERE id='u01'")
      .get(),
  ).toMatchObject({ email_trust: "unverified", auth_version: 3 });
  setUserEmail(db, "u01", null);
  expect(
    db.prepare("SELECT email FROM users WHERE id='u01'").get().email,
  ).toBeNull();
});
it.each([
  "preferred_username",
  "verified_email",
  "preferred_username_and_verified_email",
])("links via %s once and thereafter uses only issuer/sub", (mode) => {
  user();
  setUserEmail(db, "u01", "user@example.com", "admin_confirmed");
  expect(resolveOidcAccount(db, config(mode), identity())).toEqual({
    userId: "u01",
    created: false,
  });
  expect(
    resolveOidcAccount(
      db,
      config("disabled"),
      identity({ email: "changed@example.com", preferredUsername: "changed" }),
    ),
  ).toEqual({ userId: "u01", created: false });
  expect(db.prepare("SELECT email FROM users").get().email).toBe(
    "user@example.com",
  );
});
it("provisions a normal account atomically without a password or vault access", () => {
  user("setup-admin", "admin");
  const result = resolveOidcAccount(db, config("disabled", true), identity());
  expect(result.created).toBe(true);
  expect(
    db
      .prepare("SELECT role,email,email_trust FROM users WHERE role='user'")
      .get(),
  ).toMatchObject({
    role: "user",
    email: "user@example.com",
    email_trust: "oidc_verified",
  });
  expect(db.prepare("SELECT count(*) n FROM local_credentials").get().n).toBe(
    0,
  );
  expect(db.prepare("SELECT count(*) n FROM memberships").get().n).toBe(0);
  expect(resolveOidcAccount(db, config("disabled", true), identity())).toEqual({
    userId: result.userId,
    created: false,
  });
});
it("does not provision with default policy, and generates a handle if the claim is unusable", () => {
  user("setup-admin", "admin");
  expect(() => resolveOidcAccount(db, config(), identity())).toThrow();
  resolveOidcAccount(
    db,
    config("disabled", true),
    identity({ preferredUsername: "not valid", emailVerified: false }),
  );
  expect(
    db.prepare("SELECT login,email FROM users WHERE role='user'").get(),
  ).toMatchObject({
    login: expect.stringMatching(/^oidc-/),
    email: null,
  });
});
it.each([
  "disabled",
  "verified_email",
  "preferred_username_and_verified_email",
])(
  "does not fall back to username or provisioning when %s email criteria fail",
  (mode) => {
    user();
    setUserEmail(db, "u01", "user@example.com", "admin_confirmed");
    expect(() =>
      resolveOidcAccount(
        db,
        config(mode, true),
        identity({ emailVerified: false }),
      ),
    ).toThrow();
    expect(db.prepare("SELECT count(*) n FROM users").get().n).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(
      0,
    );
  },
);
it("rejects unconfirmed local email and matches split between different accounts", () => {
  user();
  user("u02");
  setUserEmail(db, "u01", "user@example.com");
  expect(() =>
    resolveOidcAccount(db, config("verified_email"), identity()),
  ).toThrow();
  setUserEmail(db, "u01", "user@example.com", "admin_confirmed");
  expect(() =>
    resolveOidcAccount(
      db,
      config("preferred_username_and_verified_email", true),
      identity({ preferredUsername: "u02" }),
    ),
  ).toThrow();
});
it("never automatically links administrators or reactivates disabled accounts", () => {
  user("u01", "admin");
  expect(() =>
    resolveOidcAccount(db, config("preferred_username"), identity()),
  ).toThrow();
  user("u02");
  db.prepare("UPDATE users SET status='disabled' WHERE id='u02'").run();
  expect(() =>
    resolveOidcAccount(
      db,
      config("preferred_username", true),
      identity({ preferredUsername: "u02" }),
    ),
  ).toThrow();
});
it("manual linking requires current account version and never overwrites identities", () => {
  user("u01", "admin");
  user("u02");
  linkOidcAccount(db, config(), identity(), "u01", 1);
  expect(() => linkOidcAccount(db, config(), identity(), "u02", 1)).toThrow();
  expect(() =>
    linkOidcAccount(db, config(), identity({ subject: "another" }), "u01", 1),
  ).toThrow();
  expect(() =>
    linkOidcAccount(db, config(), identity({ subject: "another" }), "u01", 2),
  ).toThrow();
});
it("parses the four policy modes and requests only the matching scopes", () => {
  const base = {
    IGNIS_OIDC_ENABLED: "true",
    IGNIS_OIDC_ISSUER: "https://idp.example",
    IGNIS_OIDC_CLIENT_ID: "ignis",
    IGNIS_OIDC_CLIENT_SECRET: "synthetic",
  };
  const transport = {
    publicOrigin: "https://ignis.example",
    allowHttpLoopback: false,
  };
  for (const [mode, scope] of [
    ["disabled", "openid"],
    ["preferred_username", "openid profile"],
    ["verified_email", "openid email"],
    ["preferred_username_and_verified_email", "openid profile email"],
  ])
    expect(
      readOidcConfig({ ...base, IGNIS_OIDC_ACCOUNT_LINKING: mode }, transport)
        .scope,
    ).toBe(scope);
  expect(
    readOidcConfig({ ...base, IGNIS_OIDC_AUTO_PROVISION: "true" }, transport)
      .scope,
  ).toBe("openid profile email");
  for (const patch of [
    { IGNIS_OIDC_ACCOUNT_LINKING: "username" },
    { IGNIS_OIDC_AUTO_PROVISION: "yes" },
  ])
    expect(() => readOidcConfig({ ...base, ...patch }, transport)).toThrow();
});

it("updates and clears email through the CLI using an isolated database", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-email-cli-"));
  let database;
  try {
    const { openDatabase } = require("../database");
    database = openDatabase(directory);
    database
      .prepare(
        "INSERT INTO users(id,login,role,created_at) VALUES ('cli','cli','admin',0)",
      )
      .run();
    database.close();
    database = null;
    const run = (email, trust) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../cli.js", import.meta.url)),
          "set-email",
          "cli",
          email,
          trust,
        ],
        { env: { ...process.env, DATA_ROOT: directory }, encoding: "utf8" },
      );
    expect(run("CLI@example.com", "admin_confirmed").status).toBe(0);
    database = openDatabase(directory);
    expect(
      database.prepare("SELECT email,email_trust FROM users").get(),
    ).toMatchObject({
      email: "cli@example.com",
      email_trust: "admin_confirmed",
    });
    database.close();
    database = null;
    expect(run("-", "unverified").status).toBe(0);
    expect(run("invalid", "admin_confirmed").status).toBe(1);
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("cannot provision before an administrator exists", () => {
  expect(() =>
    resolveOidcAccount(db, config("disabled", true), identity()),
  ).toThrow();
  expect(db.prepare("SELECT count(*) n FROM users").get().n).toBe(0);
});
