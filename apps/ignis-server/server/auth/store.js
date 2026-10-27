const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");

function normalizeLogin(login) {
  if (
    typeof login !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(login)
  ) {
    throw new Error(
      "Login must be 3–64 ASCII letters, digits, dots, underscores or hyphens",
    );
  }
  return login.toLowerCase();
}

function bootstrapAdmin(db, login, passwordHash) {
  login = normalizeLogin(login);
  if (
    !/^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash)
  ) {
    throw new Error("Unsupported password hash");
  }
  return transaction(db, () => {
    if (
      db.prepare("SELECT 1 FROM bootstrap_state").get() ||
      db.prepare("SELECT 1 FROM users").get()
    ) {
      throw new Error("Administrator bootstrap has already been completed");
    }
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO users(id, login, role, created_at) VALUES (?, ?, 'admin', ?)",
    ).run(id, login, now);
    db.prepare("INSERT INTO local_credentials VALUES (?, ?, ?)").run(
      id,
      passwordHash,
      now,
    );
    db.prepare("INSERT INTO bootstrap_state VALUES (1, ?)").run(now);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(),
      id,
      "bootstrap-admin",
      id,
      now,
    );
    return { id, login };
  });
}

// Registration only: no filesystem mutation, implicit discovery or HTTP access grant.
function registerVault(db, vaultRoot, directory, ownerId) {
  // Control characters cannot form portable vault directory names.
  if (
    !path.isAbsolute(vaultRoot) ||
    typeof directory !== "string" ||
    !directory ||
    directory.startsWith(".") ||
    // eslint-disable-next-line no-control-regex
    /[/\\\x00-\x1f]/.test(directory)
  ) {
    throw new Error("Vault directory must be one visible directory name");
  }
  const location = path.join(vaultRoot, directory);
  const stat = fs.lstatSync(location);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Vault must be a real directory");
  return transaction(db, () => {
    const owner = db
      .prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
      .get(ownerId);
    if (!owner) throw new Error("Owner must be an active user");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO vaults(id, name, directory, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run(id, directory, directory, Date.now());
    db.prepare("INSERT INTO memberships VALUES (?, ?, 'owner')").run(
      id,
      ownerId,
    );
    db.prepare("INSERT INTO audit_events VALUES (?, NULL, ?, ?, ?)").run(
      randomUUID(),
      "register-vault-local",
      id,
      Date.now(),
    );
    return { id, name: directory };
  });
}

module.exports = { normalizeLogin, bootstrapAdmin, registerVault };
