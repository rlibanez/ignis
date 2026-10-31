const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { transaction } = require("./database");
const { hashPassword, verifyPassword } = require("./password");
const { meetsPasswordPolicy } = require("./password-policy");
const digest = secret => createHash("sha256").update(secret).digest("hex");
const fail = code => { throw Object.assign(new Error("Password reset rejected"), { code }); };

function issuePasswordReset(db, actorId, userId, { isCurrent, now = Date.now } = {}) {
  return transaction(db, () => {
    // null is reserved for the privileged local CLI, never derived from HTTP input.
    if (actorId !== null && (typeof actorId !== "string" || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active'").get(actorId) ||
        typeof isCurrent !== "function" || !isCurrent(true))) fail("SESSION_CHANGED");
    if (!db.prepare("SELECT 1 FROM users u JOIN local_credentials c ON c.user_id=u.id WHERE u.id=? AND u.status='active'").get(userId)) fail("RESET_UNAVAILABLE");
    db.prepare("UPDATE users SET password_change_required=0 WHERE id=?").run(userId);
    const secret = randomBytes(24).toString("base64url");
    const expiresAt = now() + 60 * 60000;
    db.prepare("DELETE FROM password_reset_grants WHERE user_id=?").run(userId);
    db.prepare("UPDATE users SET auth_version=auth_version+1 WHERE id=?").run(userId);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
    const version = db.prepare("SELECT auth_version FROM users WHERE id=?").get(userId).auth_version;
    db.prepare("INSERT INTO password_resets VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, auth_version=excluded.auth_version, expires_at=excluded.expires_at")
      .run(userId, digest(secret), version, expiresAt);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actorId, "issue-password-reset", userId, now());
    return { secret, expiresAt };
  });
}

async function completePasswordReset(db, secret, password, policy, { now = Date.now } = {}) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(secret)) fail("INVALID_RESET");
  return completeByHash(db, digest(secret), password, policy, now);
}

async function completeByHash(db, tokenHash, password, policy, now) {
  const read = () => db.prepare(`SELECT r.*, u.password_change_required, c.password_hash FROM password_resets r JOIN users u ON u.id=r.user_id
    JOIN local_credentials c ON c.user_id=u.id
    WHERE r.token_hash=? AND r.expires_at>? AND u.status='active' AND u.auth_version=r.auth_version`).get(tokenHash, now());
  const before = read();
  if (!before) fail("INVALID_RESET");
  if (!meetsPasswordPolicy(password, policy)) fail("PASSWORD_POLICY");
  if (before.password_change_required && await verifyPassword(password, before.password_hash)) fail("PASSWORD_UNCHANGED");
  const hash = await hashPassword(password, policy);
  return transaction(db, () => {
    const current = read();
    if (!current || current.user_id !== before.user_id || current.auth_version !== before.auth_version) fail("INVALID_RESET");
    db.prepare("DELETE FROM password_resets WHERE token_hash=?").run(tokenHash);
    db.prepare("UPDATE users SET password_change_required=0 WHERE id=?").run(current.user_id);
    db.prepare("UPDATE local_credentials SET password_hash=?, updated_at=? WHERE user_id=?").run(hash, now(), current.user_id);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), current.user_id, "complete-password-reset", current.user_id, now());
    // No session is issued: normal authentication is required after completion.
  });
}
// Exchange the delivered secret once for an HttpOnly credential scoped only to reset.
function beginPasswordReset(db, login, secret, { now = Date.now } = {}) {
  if (typeof login !== "string" || typeof secret !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(secret)) return null;
  return transaction(db, () => {
    const reset = db.prepare(`SELECT r.* FROM password_resets r JOIN users u ON u.id=r.user_id
      JOIN local_credentials c ON c.user_id=u.id WHERE u.login=? AND r.token_hash=?
      AND r.expires_at>? AND u.status='active' AND u.auth_version=r.auth_version`).get(login, digest(secret), now());
    if (!reset) return null;
    const token = randomBytes(32).toString("hex");
    const resetHash = digest(randomBytes(32));
    db.prepare("DELETE FROM password_reset_grants WHERE user_id=?").run(reset.user_id);
    db.prepare("UPDATE password_resets SET token_hash=? WHERE user_id=?").run(resetHash, reset.user_id);
    db.prepare("INSERT INTO password_reset_grants VALUES (?, ?, ?)").run(digest(token), reset.user_id, resetHash);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), reset.user_id, "begin-password-reset", reset.user_id, now());
    return { token, expiresAt: reset.expires_at };
  });
}
function readPasswordResetGrant(db, token, { now = Date.now } = {}) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT g.token_hash AS context, r.token_hash AS resetHash, u.login FROM password_reset_grants g
    JOIN password_resets r ON r.user_id=g.user_id AND r.token_hash=g.reset_hash
    JOIN users u ON u.id=r.user_id JOIN local_credentials c ON c.user_id=u.id
    WHERE g.token_hash=? AND r.expires_at>? AND u.status='active' AND u.auth_version=r.auth_version`).get(digest(token), now()) || null;
}
async function completePasswordResetGrant(db, token, context, password, policy, { now = Date.now } = {}) {
  const grant = readPasswordResetGrant(db, token, { now });
  if (!grant || grant.context !== context) fail("INVALID_RESET");
  return completeByHash(db, grant.resetHash, password, policy, now);
}
module.exports = { issuePasswordReset, completePasswordReset, beginPasswordReset, readPasswordResetGrant, completePasswordResetGrant };

// Called only inside loginLocal's transaction after password and auth_version checks.
function beginRequiredPasswordChange(db, user, at) {
  const token = randomBytes(32).toString("hex");
  const resetHash = digest(randomBytes(32));
  const expiresAt = at + 60 * 60000;
  db.prepare("DELETE FROM password_resets WHERE user_id=?").run(user.id);
  db.prepare("INSERT INTO password_resets VALUES (?, ?, ?, ?)").run(user.id, resetHash, user.auth_version, expiresAt);
  db.prepare("INSERT INTO password_reset_grants VALUES (?, ?, ?)").run(digest(token), user.id, resetHash);
  return { token, expiresAt };
}
module.exports.beginRequiredPasswordChange = beginRequiredPasswordChange;
