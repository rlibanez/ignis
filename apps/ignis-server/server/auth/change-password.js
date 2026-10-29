const { transaction } = require("./database");
const { randomUUID } = require("node:crypto");
const { hashPassword, verifyPassword } = require("./password");
const { meetsPasswordPolicy } = require("./password-policy");

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
module.exports = { changePassword };
