const { transaction } = require("../../../platform/persistence/database");
const { randomUUID } = require("node:crypto");
const { hashPassword, verifyPassword } = require("./password.js");
const { meetsPasswordPolicy } = require("./password-policy.js");

async function changePassword(db, userId, currentPassword, newPassword, policy, { isCurrent } = {}) {
  const fail = (code) => { throw Object.assign(new Error("Password change rejected"), { code }); };
  if (typeof isCurrent !== "function" || !isCurrent()) fail("SESSION_CHANGED");
  if (!meetsPasswordPolicy(newPassword, policy)) fail("PASSWORD_POLICY");
  const read = () => db.prepare(`SELECT u.auth_version, c.password_hash FROM users u
    JOIN local_credentials c ON c.user_id=u.id WHERE u.id=? AND u.status='active'`).get(userId);
  const before = read();
  if (!before || !await verifyPassword(currentPassword, before.password_hash)) fail("INVALID_PASSWORD");
  if (currentPassword === newPassword) fail("PASSWORD_UNCHANGED");
  const hash = await hashPassword(newPassword, policy);
  return transaction(db, () => {
    const current = read();
    if (!isCurrent(true) || !current || current.auth_version !== before.auth_version ||
        current.password_hash !== before.password_hash) fail("SESSION_CHANGED");
    // The credential update trigger revokes every session and increments auth_version.
    db.prepare("UPDATE local_credentials SET password_hash=?, updated_at=? WHERE user_id=?").run(hash, Date.now(), userId);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), userId, "change-password", userId, Date.now(),
    );
  });
}
// Self-service never accepts a target account or an administrator override.
async function setOwnLocalPassword(db, userId, password, policy, { resolveSession, now = Date.now } = {}) {
  const fail = code => { throw Object.assign(new Error("Local password setup rejected"), { code }); };
  const check = (withinTransaction = false) => {
    const session = resolveSession?.(withinTransaction), at = now();
    if (!session || session.user.id !== userId || session.method !== "oidc" ||
        !Number.isSafeInteger(session.authenticatedAt) || session.authenticatedAt > at || at - session.authenticatedAt >= 300000)
      fail("REAUTH_REQUIRED");
    const user = db.prepare("SELECT auth_version FROM users WHERE id=? AND status='active'").get(userId);
    if (!user || !db.prepare("SELECT 1 FROM oidc_identities WHERE user_id=? AND issuer=? AND subject=?").get(userId, session.issuer, session.subject)) fail("REAUTH_REQUIRED");
    if (db.prepare("SELECT 1 FROM local_credentials WHERE user_id=?").get(userId)) fail("LOCAL_PASSWORD_EXISTS");
    return user.auth_version;
  };
  const version = check();
  if (!meetsPasswordPolicy(password, policy)) fail("PASSWORD_POLICY");
  const hash = await hashPassword(password, policy);
  transaction(db, () => {
    if (check(true) !== version) fail("SESSION_CHANGED");
    db.prepare("INSERT INTO local_credentials VALUES (?, ?, ?)").run(userId, hash, now());
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), userId, "set-own-local-password", userId, now());
  });
}
module.exports = { changePassword, setOwnLocalPassword };
