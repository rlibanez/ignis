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
  return require("./vault-registration").registerExistingVault(db, vaultRoot, directory, ownerId);
}

module.exports = { normalizeLogin, bootstrapAdmin, registerVault };
