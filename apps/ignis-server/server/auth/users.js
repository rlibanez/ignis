const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");
const { normalizeLogin } = require("./store");
const { hashPassword } = require("./password");
const { readPasswordPolicy } = require("./password-policy");

// null explicitly identifies the privileged local CLI, never an anonymous request.
function authorize(db, actorId) {
  if (actorId === null) return;
  if (
    typeof actorId !== "string" ||
    !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(actorId)
  ) throw new Error("Administrator required");
}

async function createLocalUser(db, actorId, login, password, policy = readPasswordPolicy(), { isCurrent = () => true } = {}) {
  authorize(db, actorId);
  if (!isCurrent()) throw new Error("Administrator session required");
  login = normalizeLogin(login);
  const hash = await hashPassword(password, policy);
  return transaction(db, () => {
    // Authorization can change while password hashing is in flight.
    authorize(db, actorId);
    if (!isCurrent(true)) throw new Error("Administrator session required");
    if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'").get())
      throw new Error("Create the first administrator before adding users");
    if (db.prepare("SELECT 1 FROM users WHERE login = ?").get(login))
      throw new Error("Login already exists");
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO users(id, login, role, created_at) VALUES (?, ?, 'user', ?)").run(id, login, now);
    db.prepare("INSERT INTO local_credentials VALUES (?, ?, ?)").run(id, hash, now);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actorId, "create-local-user", id, now);
    return { id, login, role: "user", status: "active" };
  });
}

function listUsers(db, actorId) {
  authorize(db, actorId);
  return db.prepare("SELECT id, login, role, status FROM users ORDER BY login").all();
}

function changeUserStatus(db, actorId, userId, status, expectedStatus, { isCurrent = () => true } = {}) {
  if (typeof userId !== "string" ||
      !["active", "disabled"].includes(status) ||
      !["active", "disabled"].includes(expectedStatus))
    throw new Error("Invalid user status request");
  return transaction(db, () => {
    authorize(db, actorId);
    if (!isCurrent(true)) throw new Error("Administrator session required");
    const fail = (code) => { throw Object.assign(new Error("User status change rejected"), { code }); };
    const user = db.prepare("SELECT id, login, role, status FROM users WHERE id = ?").get(userId);
    if (!user) fail("USER_NOT_FOUND");
    if (user.status !== expectedStatus) fail("USER_STATE_CHANGED");
    if (status === user.status) return user;
    if (status === "disabled" && user.role === "admin" &&
        db.prepare("SELECT count(*) n FROM users WHERE role = 'admin' AND status = 'active'").get().n <= 1)
      fail("LAST_ADMIN");
    if (status === "disabled" && actorId === userId) fail("SELF_DISABLE");
    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
    // Existing triggers revoke all sessions and increment auth_version.
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), actorId, status === "disabled" ? "disable-user" : "enable-user", userId, Date.now(),
    );
    return { ...user, status };
  });
}

function revokeUserSessions(db, actorId, userId, { isCurrent = () => true } = {}) {
  if (typeof userId !== "string") throw new Error("Invalid user");
  return transaction(db, () => {
    authorize(db, actorId);
    if (!isCurrent(true)) throw new Error("Administrator session required");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId))
      throw Object.assign(new Error("User not found"), { code: "USER_NOT_FOUND" });
    // Also invalidates a local login or link that was already in progress.
    db.prepare("UPDATE users SET auth_version = auth_version + 1 WHERE id = ?").run(userId);
    const count = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes;
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), actorId, "revoke-user-sessions", userId, Date.now(),
    );
    return { revokedSessions: count };
  });
}

function unlinkUserOidc(db, actorId, userId, issuer, { isCurrent = () => true } = {}) {
  if (typeof userId !== "string" || typeof issuer !== "string" || !issuer)
    throw new Error("Invalid unlink request");
  return transaction(db, () => {
    authorize(db, actorId);
    if (!isCurrent(true)) throw new Error("Administrator session required");
    const fail = (code) => { throw Object.assign(new Error("OIDC unlink rejected"), { code }); };
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) fail("USER_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM oidc_identities WHERE user_id = ? AND issuer = ?").get(userId, issuer))
      fail("OIDC_NOT_LINKED");
    // Other issuers might not be configured anymore; require a usable local credential.
    if (!db.prepare("SELECT 1 FROM local_credentials WHERE user_id = ?").get(userId))
      fail("LOCAL_PASSWORD_REQUIRED");
    // Existing delete trigger invalidates auth_version and removes all sessions.
    db.prepare("DELETE FROM oidc_identities WHERE user_id = ? AND issuer = ?").run(userId, issuer);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), actorId, "unlink-oidc-user", userId, Date.now(),
    );
    return { unlinked: true };
  });
}

module.exports = { createLocalUser, listUsers, changeUserStatus, revokeUserSessions, unlinkUserOidc };
