import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

it("prints the missing-admin error and exits before asking for credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "ignis-cli-users-"));
  try {
    const db = require("./database").openDatabase(root);
    db.close();
    const result = spawnSync(process.execPath, [
      new URL("./cli.js", import.meta.url).pathname, "create-user",
    ], {
      env: { ...process.env, DATA_ROOT: root },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[auth] Create the first administrator before adding users");
    expect(result.stdout).not.toContain("User login:");
    expect(result.stdout).not.toContain("Password");
    expect(result.stdout).not.toContain("User created:");
    const reopened = require("./database").openDatabase(root);
    try {
      expect(reopened.prepare("SELECT count(*) n FROM users").get().n).toBe(0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
