const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");
const { normalizeLogin } = require("./store");
const { normalizeEmail } = require("./email");
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

async function createLocalUser(db, actorId, login, password, policy = readPasswordPolicy(), { isCurrent = () => true, email = null, emailVerified = false, requirePasswordChange = false } = {}) {
  if (typeof requirePasswordChange !== "boolean") throw new Error("Invalid password change requirement");
  email = email === null || email === "" ? null : normalizeEmail(email);
  if (typeof emailVerified !== "boolean" || (emailVerified && !email)) throw new Error("Invalid email confirmation");
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
    db.prepare("UPDATE users SET email=?, email_trust=? WHERE id=?").run(email, emailVerified ? "admin_confirmed" : "unverified", id);
    db.prepare("INSERT INTO local_credentials VALUES (?, ?, ?)").run(id, hash, now);
    if (requirePasswordChange) db.prepare("UPDATE users SET password_change_required=1 WHERE id=?").run(id);
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actorId, "create-local-user", id, now);
    return { id, login, role: "user", status: "active" };
  });
}

function listUsers(db, actorId) {
  authorize(db, actorId);
  return db.prepare("SELECT id, login, role, status, email, email_trust, password_change_required FROM users ORDER BY login").all();
}

function changeUserStatus(db, actorId, userId, status, expectedStatus, { isCurrent = () => true, emailUpdate, roleUpdate, passwordUpdate } = {}) {
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
    if (db.prepare("SELECT 1 FROM user_deletions WHERE user_id=?").get(userId)) fail("USER_DELETION_IN_PROGRESS");
    if (user.status !== expectedStatus) fail("USER_STATE_CHANGED");
    if (emailUpdate) {
      const previous = db.prepare("SELECT email, email_trust FROM users WHERE id=?").get(userId);
      if (previous.email !== emailUpdate.expectedEmail || previous.email_trust !== emailUpdate.expectedEmailTrust)
        fail("USER_STATE_CHANGED");
    }
    const role = roleUpdate ? roleUpdate.role : user.role;
    if (roleUpdate) {
      if (!["admin", "user"].includes(role) || !["admin", "user"].includes(roleUpdate.expectedRole) || typeof roleUpdate.confirmAdmin !== "boolean") fail("INVALID_ROLE");
      if (user.role !== roleUpdate.expectedRole) fail("USER_STATE_CHANGED");
      if (role !== user.role && role === "admin" && !roleUpdate.confirmAdmin) fail("ADMIN_CONFIRMATION_REQUIRED");
    }
    if (passwordUpdate) {
      if (typeof passwordUpdate.requirePasswordChange !== "boolean" || typeof passwordUpdate.expectedPasswordChangeRequired !== "boolean") fail("INVALID_PASSWORD_REQUIREMENT");
      const previous = !!db.prepare("SELECT password_change_required FROM users WHERE id=?").get(userId).password_change_required;
      if (previous !== passwordUpdate.expectedPasswordChangeRequired) fail("USER_STATE_CHANGED");
      if (passwordUpdate.requirePasswordChange && !db.prepare("SELECT 1 FROM local_credentials WHERE user_id=?").get(userId)) fail("LOCAL_PASSWORD_REQUIRED");
      if (previous !== passwordUpdate.requirePasswordChange) {
        db.prepare("UPDATE users SET password_change_required=? WHERE id=?").run(Number(passwordUpdate.requirePasswordChange), userId);
        db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actorId, passwordUpdate.requirePasswordChange ? "require-password-change" : "cancel-password-change", userId, Date.now());
      }
    }
    if (status === user.status && role === user.role && !emailUpdate) return user;
    if (user.status === "active" && user.role === "admin" && (role !== "admin" || status !== "active") &&
        db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND status='active'").get().n <= 1) fail("LAST_ADMIN");
    if (role !== user.role && actorId === userId) fail("SELF_ROLE_CHANGE");
    if (status !== user.status && status === "disabled" && actorId === userId) fail("SELF_DISABLE");
    if (status !== user.status || role !== user.role) db.prepare("UPDATE users SET status = ?, role = ? WHERE id = ?").run(status, role, userId);
    if (emailUpdate) {
      let email;
      try { email = emailUpdate.email === "" || emailUpdate.email === null ? null : normalizeEmail(emailUpdate.email); }
      catch { fail("INVALID_EMAIL"); }
      if (typeof emailUpdate.emailVerified !== "boolean" || (emailUpdate.emailVerified && !email)) fail("INVALID_EMAIL");
      if (email && db.prepare("SELECT 1 FROM users WHERE email=? AND id!=?").get(email, userId)) fail("EMAIL_IN_USE");
      const trust = emailUpdate.emailVerified
        ? email === emailUpdate.expectedEmail && emailUpdate.expectedEmailTrust === "oidc_verified" ? "oidc_verified" : "admin_confirmed"
        : "unverified";
      db.prepare("UPDATE users SET email=?, email_trust=? WHERE id=?").run(email, trust, userId);
      db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(randomUUID(), actorId, "set-user-email", userId, Date.now());
    }
    // Existing triggers revoke all sessions and increment auth_version.
    if (status !== user.status) db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), actorId, status === "disabled" ? "disable-user" : "enable-user", userId, Date.now(),
    );
    if (role !== user.role) db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), actorId, role === "admin" ? "promote-user-admin" : "demote-user-admin", userId, Date.now(),
    );
    return { ...user, status, role };
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

async function setInitialLocalPassword(db, actorId, userId, password, policy, { isCurrent } = {}) {
  const fail = code => { throw Object.assign(new Error("Local password setup rejected"), { code }); };
  const check = (withinTransaction = false) => {
    if (typeof actorId !== "string" || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active'").get(actorId)) fail("SESSION_CHANGED");
    if (typeof isCurrent !== "function" || !isCurrent(withinTransaction)) fail("SESSION_CHANGED");
    const user = db.prepare("SELECT auth_version FROM users WHERE id=?").get(userId);
    if (!user) fail("USER_NOT_FOUND");
    if (db.prepare("SELECT 1 FROM local_credentials WHERE user_id=?").get(userId)) fail("LOCAL_PASSWORD_EXISTS");
    if (!db.prepare("SELECT 1 FROM oidc_identities WHERE user_id=?").get(userId)) fail("OIDC_NOT_LINKED");
    return user.auth_version;
  };
  const version = check();
  if (!require("./password-policy").meetsPasswordPolicy(password, policy)) fail("PASSWORD_POLICY");
  const hash = await hashPassword(password, policy);
  return transaction(db, () => {
    if (check(true) !== version) fail("USER_STATE_CHANGED");
    // Inserting credentials revokes every target session and increments auth_version.
    db.prepare("INSERT INTO local_credentials VALUES (?, ?, ?)").run(userId, hash, Date.now());
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), actorId, "set-initial-local-password", userId, Date.now(),
    );
  });
}

module.exports = { setInitialLocalPassword, createLocalUser, listUsers, changeUserStatus, revokeUserSessions, unlinkUserOidc };
