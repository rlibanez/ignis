const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { transaction } = require("./database");
const { normalizeLogin } = require("./store");
const { verifyPassword } = require("./password");

function tokenHash(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

// Trusted backend service, NOT an authorization boundary for callers. No HTTP adapters yet.
function createSessionService(
  db,
  {
    now = Date.now,
    idleMs = 30 * 60 * 1000,
    absoluteMs = 12 * 60 * 60 * 1000,
    maxSessionsPerUser = 10,
  } = {},
) {
  if (
    ![idleMs, absoluteMs, maxSessionsPerUser].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    idleMs > absoluteMs ||
    absoluteMs > 30 * 24 * 60 * 60 * 1000 ||
    maxSessionsPerUser > 100
  ) {
    throw new Error("Invalid session policy");
  }
  function time() {
    const value = now();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      !Number.isSafeInteger(value + absoluteMs)
    ) {
      throw new Error("Invalid session clock");
    }
    return value;
  }
  function publicSession(row) {
    return {
      id: row.id,
      user: {
        id: row.user_id,
        login: row.login,
        role: row.role,
        authVersion: row.auth_version,
      },
      method: row.method,
      issuer: row.issuer,
      subject: row.subject,
      authenticatedAt: row.authenticated_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      idleExpiresAt: Math.min(
        row.last_activity + row.idle_timeout_ms,
        row.expires_at,
      ),
    };
  }
  function prune(at) {
    return db
      .prepare(
        `DELETE FROM sessions WHERE expires_at <= ?
      OR last_activity + idle_timeout_ms <= ?
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id
        AND u.status = 'active' AND u.auth_version = sessions.auth_version)`,
      )
      .run(at, at).changes;
  }
  function insert(user, method, issuer, subject, authenticatedAt, at) {
    prune(at);
    // Bound per-user sessions; evict oldest before insertion so the new session survives ties.
    db.prepare(
      `DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = ?
      ORDER BY created_at, id LIMIT max(0, (SELECT count(*) FROM sessions WHERE user_id = ?) - ? + 1))`,
    ).run(user.id, user.id, maxSessionsPerUser);
    const token = randomBytes(32).toString("hex");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tokenHash(token),
      id,
      user.id,
      user.auth_version,
      at,
      at,
      at + absoluteMs,
      idleMs,
      method,
      issuer,
      subject,
      authenticatedAt,
    );
    return {
      token,
      session: publicSession({
        id,
        user_id: user.id,
        login: user.login,
        role: user.role,
        auth_version: user.auth_version,
        created_at: at,
        last_activity: at,
        expires_at: at + absoluteMs,
        idle_timeout_ms: idleMs,
        method,
        issuer,
        subject,
        authenticated_at: authenticatedAt,
      }),
    };
  }
  async function loginLocal(login, password) {
    let normalized = null;
    try {
      normalized = normalizeLogin(login);
    } catch {
      /* Uniform credential failure. */
    }
    const before = db
      .prepare(
        `SELECT u.*, c.password_hash FROM users u
      JOIN local_credentials c ON c.user_id = u.id WHERE u.login = ?`,
      )
      .get(normalized);
    // Unknown, disabled and external-only accounts perform the same bounded KDF work.
    const matches = await verifyPassword(password, before?.password_hash);
    if (!matches || !before || before.status !== "active") return null;
    return transaction(db, () => {
      const current = db
        .prepare(
          `SELECT u.*, c.password_hash FROM users u
        JOIN local_credentials c ON c.user_id = u.id WHERE u.id = ?`,
        )
        .get(before.id);
      if (
        !current ||
        current.status !== "active" ||
        current.auth_version !== before.auth_version ||
        current.password_hash !== before.password_hash
      )
        return null;
      const at = time();
      return insert(current, "local", null, null, at, at);
    });
  }
  // Future OIDC adapter may call ONLY after full protocol/token validation and controlled linking.
  // No JWT parsing, discovery, provisioning, role claims or email matching happens here.
  function issueForVerifiedOidcIdentity({ issuer, subject, authenticatedAt }) {
    if (
      typeof issuer !== "string" ||
      !issuer ||
      issuer.length > 2048 ||
      typeof subject !== "string" ||
      !subject ||
      subject.length > 255
    )
      return null;
    return transaction(db, () => {
      const at = time();
      if (
        !Number.isSafeInteger(authenticatedAt) ||
        authenticatedAt < 0 ||
        authenticatedAt > at ||
        authenticatedAt <= at - absoluteMs
      )
        return null;
      const user = db
        .prepare(
          `SELECT u.* FROM users u JOIN oidc_identities i ON i.user_id = u.id
        WHERE i.issuer = ? AND i.subject = ? AND u.status = 'active'`,
        )
        .get(issuer, subject);
      if (!user) return null;
      return insert(user, "oidc", issuer, subject, authenticatedAt, at);
    });
  }
  function find(hash, at) {
    const row = db
      .prepare(
        `SELECT s.*, u.login, u.role, u.status, u.auth_version AS current_version
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hash);
    if (!row) return null;
    let valid =
      row.status === "active" &&
      row.current_version === row.auth_version &&
      row.created_at <= at &&
      row.last_activity <= at &&
      at < row.expires_at &&
      at < row.last_activity + row.idle_timeout_ms;
    if (valid && row.method === "oidc") {
      valid = !!db
        .prepare(
          "SELECT 1 FROM oidc_identities WHERE user_id = ? AND issuer = ? AND subject = ?",
        )
        .get(row.user_id, row.issuer, row.subject);
    } else if (valid) {
      valid = !!db
        .prepare("SELECT 1 FROM local_credentials WHERE user_id = ?")
        .get(row.user_id);
    }
    if (!valid) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    return row;
  }
  function resolve(token, { touch = false, withinTransaction = false } = {}) {
    const hash = tokenHash(token);
    if (!hash) return null;
    const read = () => {
      const at = time();
      const row = find(hash, at);
      if (!row) return null;
      if (touch === true) {
        db.prepare(
          "UPDATE sessions SET last_activity = ? WHERE token_hash = ?",
        ).run(at, hash);
        row.last_activity = at;
      }
      return publicSession(row);
    };
    // Internal callers may already hold the same database write transaction.
    return withinTransaction ? read() : transaction(db, read);
  }
  function rotate(token) {
    const hash = tokenHash(token);
    if (!hash) return null;
    return transaction(db, () => {
      const row = find(hash, time());
      if (!row) return null;
      const replacement = randomBytes(32).toString("hex");
      const id = randomUUID();
      db.prepare(
        "UPDATE sessions SET token_hash = ?, id = ? WHERE token_hash = ?",
      ).run(tokenHash(replacement), id, hash);
      row.id = id;
      return { token: replacement, session: publicSession(row) };
    });
  }
  function revoke(token) {
    const hash = tokenHash(token);
    return hash
      ? db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash)
          .changes > 0
      : false;
  }
  function revokeUser(userId) {
    return transaction(db, () => {
      // Invalidates an authentication attempt already hashing a password as well.
      db.prepare(
        "UPDATE users SET auth_version = auth_version + 1 WHERE id = ?",
      ).run(userId);
      return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId)
        .changes;
    });
  }
  function revokeIssuer(issuer) {
    return transaction(db, () => {
      // Fail safe: also revoke other methods for affected users.
      db.prepare(
        `UPDATE users SET auth_version = auth_version + 1 WHERE id IN
        (SELECT user_id FROM oidc_identities WHERE issuer = ?)`,
      ).run(issuer);
      return db
        .prepare(
          `DELETE FROM sessions WHERE user_id IN
        (SELECT user_id FROM oidc_identities WHERE issuer = ?)`,
        )
        .run(issuer).changes;
    });
  }
  return {
    loginLocal,
    issueForVerifiedOidcIdentity,
    resolve,
    rotate,
    revoke,
    revokeUser,
    revokeIssuer,
    purgeExpired: () => prune(time()),
  };
}

module.exports = { createSessionService };
