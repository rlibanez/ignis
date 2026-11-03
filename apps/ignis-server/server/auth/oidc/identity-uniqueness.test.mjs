import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const schema = require("../../platform/persistence/schema");
const { transaction } = require("../../platform/persistence/database");
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(schema.sql);
  db.exec(
    "INSERT INTO users(id,login,role,created_at) VALUES ('a','alice','user',0),('b','bob','user',0)",
  );
  return db;
}
it("preserves valid links and enforces both directions even for direct SQL", () => {
  const db = database();
  try {
    const insert = db.prepare(
      "INSERT INTO oidc_identities VALUES (?, ?, ?, 0)",
    );
    insert.run("https://idp.example", "one", "a");
    const before = db.prepare("SELECT * FROM oidc_identities").all();
    expect(db.prepare("SELECT * FROM oidc_identities").all()).toEqual(before);
    expect(() => insert.run("https://idp.example", "two", "a")).toThrow(
      /UNIQUE/,
    );
    expect(() => insert.run("https://idp.example", "one", "b")).toThrow(
      /UNIQUE/,
    );
    insert.run("https://other.example", "one", "a");
    insert.run("https://idp.example", "two", "b");
    expect(() =>
      db
        .prepare(
          "UPDATE oidc_identities SET user_id='a' WHERE issuer=? AND subject='two'",
        )
        .run("https://idp.example"),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare("UPDATE oidc_identities SET issuer=? WHERE issuer=?")
        .run("https://idp.example", "https://other.example"),
    ).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT count(*) n FROM oidc_identities").get().n).toBe(
      3,
    );
  } finally {
    db.close();
  }
});
it("rolls back a conflicting identity batch without modifying existing links", () => {
  const db=database();
  try {
    db.exec("INSERT INTO oidc_identities VALUES ('https://idp.example','existing','a',0)");
    const before=db.prepare("SELECT * FROM oidc_identities").all();
    expect(() => transaction(db,()=>db.exec("INSERT INTO oidc_identities VALUES ('https://idp.example','one','b',0),('https://idp.example','two','b',0)"))).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT * FROM oidc_identities").all()).toEqual(before);
  } finally {db.close();}
});
