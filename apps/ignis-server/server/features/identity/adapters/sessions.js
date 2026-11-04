const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { transaction } = require("../../../platform/persistence/database");
const { normalizeLogin } = require("./store.js");
const { verifyPassword } = require("./password.js");

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
    rememberDays = 90,
  } = {},
) {
  if (
    ![idleMs, absoluteMs, maxSessionsPerUser].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    idleMs > absoluteMs ||
    absoluteMs > 30 * 24 * 60 * 60 * 1000 ||
    maxSessionsPerUser > 100 || !Number.isInteger(rememberDays) || rememberDays < 1 || rememberDays > 365
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
  const rememberMs = rememberDays * 86400000;
  // Short grace for concurrent requests. Secrets never enter SQLite. After a
  // restart, a retired credential fails closed instead of recreating a grant.
  const renewals = new Map();
  function prune(at) {
    for (const [hash, entry] of renewals) if (entry.until <= at) renewals.delete(hash);
    db.prepare("DELETE FROM remembered_retired_tokens WHERE expires_at <= ?").run(at);
    db.prepare("DELETE FROM sessions WHERE id IN (SELECT session_id FROM remembered_sessions WHERE expires_at <= ?)").run(at);
    return db
      .prepare(
        `DELETE FROM sessions WHERE ((expires_at <= ?
      OR last_activity + idle_timeout_ms <= ?) AND NOT EXISTS
        (SELECT 1 FROM remembered_sessions r WHERE r.session_id=sessions.id))
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id
        AND u.status = 'active' AND u.auth_version = sessions.auth_version)`,
      )
      .run(at, at).changes;
  }
  function insert(user, method, issuer, subject, authenticatedAt, at) {
    if (user.password_change_required || db.prepare("SELECT 1 FROM password_resets WHERE user_id=?").get(user.id)) return null;
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
      if (current.password_change_required) return { passwordChange: require("./password-reset.js").beginRequiredPasswordChange(db, current, at) };
      return insert(current, "local", null, null, at, at);
    });
  }
  // Reconfirm the existing identity without replacing the editor's session
  // context. Rotate the bearer secret; never accept the previous credential.
  async function reauthenticateLocal(token, expectedId, password) {
    const hash = tokenHash(token);
    const before = hash && find(hash, time());
    const credential = before && db.prepare("SELECT password_hash FROM local_credentials WHERE user_id=?").get(before.user_id);
    const matches = await verifyPassword(password, credential?.password_hash);
    if (!matches || !before || before.id !== expectedId) return null;
    return transaction(db, () => {
      const at = time();
      const row = find(hash, at);
      const current = db.prepare("SELECT password_hash FROM local_credentials WHERE user_id=?").get(before.user_id);
      if (!row || row.id !== expectedId ||
          row.auth_version !== before.auth_version || current?.password_hash !== credential.password_hash) return null;
      const replacement = randomBytes(32).toString("hex");
      db.prepare("UPDATE sessions SET token_hash=?, authenticated_at=?, created_at=?, last_activity=?, method='local', issuer=NULL, subject=NULL WHERE id=?")
        .run(tokenHash(replacement), at, at, at, row.id);
      db.prepare("DELETE FROM remembered_sessions WHERE session_id=?").run(row.id);
      row.created_at = at;
      row.method = "local";
      row.issuer = row.subject = null;
      row.authenticated_at = at;
      row.last_activity = at;
      return { token: replacement, session: publicSession(row) };
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
  function find(hash, at, renewal = false) {
    const row = db
      .prepare(
        `SELECT s.*, u.login, u.role, u.status, u.password_change_required, u.auth_version AS current_version
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hash);
    if (!row) return null;
    let valid =
      row.status === "active" && !row.password_change_required &&
      !db.prepare("SELECT 1 FROM password_resets WHERE user_id=?").get(row.user_id) &&
      row.current_version === row.auth_version &&
      row.created_at <= at &&
      row.last_activity <= at &&
      (renewal || (at < row.expires_at &&
      at < row.last_activity + row.idle_timeout_ms));
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
      // Keep expired short leases only while the separate device grant is valid.
      if (!renewal && db.prepare("SELECT 1 FROM remembered_sessions WHERE session_id=? AND expires_at>?").get(row.id,at)) {
        if (find(hash, at, true)) return null;
      }
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
  function remembered(token) {
    const hash=tokenHash(token);
    return !!hash && !!db.prepare("SELECT 1 FROM sessions s JOIN remembered_sessions r ON r.session_id=s.id WHERE s.token_hash=? AND r.expires_at>?").get(hash,time());
  }
  function remember(token) {
    return transaction(db,()=>{
      const at=time(), row=find(tokenHash(token),at);
      if(!row)return null;
      const secret=randomBytes(32).toString("hex"),expiresAt=at+rememberMs;
      db.prepare("DELETE FROM remembered_sessions WHERE session_id=?").run(row.id);
      db.prepare("INSERT INTO remembered_sessions VALUES (?,?,?)").run(row.id,tokenHash(secret),expiresAt);
      return {token:secret,expiresAt};
    });
  }
  function forget(secret) {
    const hash=tokenHash(secret);if(!hash)return;
    db.prepare(`DELETE FROM sessions WHERE id IN
      (SELECT session_id FROM remembered_sessions WHERE token_hash=? UNION SELECT session_id FROM remembered_retired_tokens WHERE token_hash=?)`).run(hash,hash);
  }
  function resume(secret, sessionToken) {
    const hash=tokenHash(secret);if(!hash)return null;
    return transaction(db,()=>{
      const at=time();
      for(const [key,entry] of renewals)if(entry.until<=at)renewals.delete(key);
      let device=db.prepare("SELECT r.*,s.token_hash AS session_hash FROM remembered_sessions r JOIN sessions s ON s.id=r.session_id WHERE r.token_hash=?").get(hash);
      if(!device){
        const retired=db.prepare("SELECT session_id FROM remembered_retired_tokens WHERE token_hash=? AND expires_at>?").get(hash,at);
        const cached=renewals.get(hash);
        if(retired && cached && cached.until>at && find(tokenHash(cached.result.token),at)){
          const active=tokenHash(sessionToken) && find(tokenHash(sessionToken),at);
          return !active || active.id===cached.result.session.id ? cached.result : null;
        }
        if(retired)db.prepare("DELETE FROM sessions WHERE id=?").run(retired.session_id);
        return null;
      }
      if(device.expires_at<=at){db.prepare("DELETE FROM sessions WHERE id=?").run(device.session_id);return null;}
      const row=find(device.session_hash,at,true);
      if(!row)return null;
      // Never restore another account over a valid browser session.
      const active=tokenHash(sessionToken) && find(tokenHash(sessionToken),at);
      if(active && active.id!==row.id)return null;
      if(active && device.expires_at-at>rememberMs-86400000)return null;
      const token=randomBytes(32).toString("hex"),rememberToken=randomBytes(32).toString("hex");
      const expiresAt=at+rememberMs;
      db.prepare("INSERT INTO remembered_retired_tokens VALUES (?,?,?)").run(hash,row.id,device.expires_at);
      db.prepare("UPDATE remembered_sessions SET token_hash=?,expires_at=? WHERE session_id=?").run(tokenHash(rememberToken),expiresAt,row.id);
      db.prepare("UPDATE sessions SET token_hash=?,last_activity=?,expires_at=? WHERE id=?").run(tokenHash(token),at,at+absoluteMs,row.id);
      row.last_activity=at;row.expires_at=at+absoluteMs;
      const result={token,session:publicSession(row),remember:{token:rememberToken,expiresAt}};
      renewals.set(hash,{until:at+10000,result});
      return result;
    });
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
    remember, remembered, resume, forget,
    loginLocal, reauthenticateLocal,
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
