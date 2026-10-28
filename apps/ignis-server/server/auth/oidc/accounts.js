const { randomUUID } = require("node:crypto");
const { transaction } = require("../database");
const { normalizeLogin } = require("../store");
const { normalizeEmail } = require("../email");
const modes = [
  "disabled",
  "preferred_username",
  "verified_email",
  "preferred_username_and_verified_email",
];
function checkIdentity(config, identity) {
  if (
    !identity ||
    identity.issuer !== config.issuer ||
    typeof identity.subject !== "string" ||
    !/^[\x20-\x7e]{1,255}$/.test(identity.subject)
  )
    throw new Error("OIDC account unavailable");
}
function bind(db, userId, identity, actorId, action) {
  // One identity from this issuer per account; never replace an existing binding.
  if (
    db
      .prepare("SELECT 1 FROM oidc_identities WHERE user_id = ? AND issuer = ?")
      .get(userId, identity.issuer)
  )
    throw new Error("OIDC account unavailable");
  db.prepare("INSERT INTO oidc_identities VALUES (?, ?, ?, ?)").run(
    identity.issuer,
    identity.subject,
    userId,
    Date.now(),
  );
  db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
    randomUUID(),
    actorId,
    action,
    userId,
    Date.now(),
  );
}
// Trusted backend only: identity must come from the fully validated OIDC flow.
function resolveOidcAccount(db, config, identity) {
  try {
    checkIdentity(config, identity);
    if (
      !modes.includes(config.accountLinking) ||
      typeof config.autoProvision !== "boolean"
    )
      throw new Error();
    return transaction(db, () => {
      const existing = db
        .prepare(
          "SELECT u.* FROM users u JOIN oidc_identities i ON i.user_id = u.id WHERE i.issuer = ? AND i.subject = ?",
        )
        .get(identity.issuer, identity.subject);
      if (existing) {
        if (existing.status !== "active") throw new Error();
        return { userId: existing.id, created: false };
      }
      let login = null,
        email = null;
      if (identity.preferredUsername !== undefined) {
        try {
          login = normalizeLogin(identity.preferredUsername);
        } catch {
          /* Generate a safe handle on provisioning. */
        }
      }
      if (identity.email !== undefined) email = normalizeEmail(identity.email);
      const byLogin = login
        ? db.prepare("SELECT * FROM users WHERE login = ?").get(login)
        : null;
      const byEmail = email
        ? db.prepare("SELECT * FROM users WHERE email = ?").get(email)
        : null;
      if (byLogin && byEmail && byLogin.id !== byEmail.id) throw new Error();
      const trustedEmail =
        byEmail &&
        byEmail.email_trust !== "unverified" &&
        identity.emailVerified === true;
      let candidate;
      switch (config.accountLinking) {
        case "preferred_username":
          candidate = byLogin;
          break;
        case "verified_email":
          candidate = trustedEmail ? byEmail : null;
          break;
        case "preferred_username_and_verified_email":
          candidate =
            byLogin && trustedEmail && byLogin.id === byEmail.id
              ? byLogin
              : null;
          break;
      }
      if (candidate) {
        if (candidate.status !== "active" || candidate.role !== "user")
          throw new Error();
        bind(db, candidate.id, identity, null, "oidc-auto-link");
        return { userId: candidate.id, created: false };
      }
      // A failed linking criterion must never fall through to a shadow account.
      if (byLogin || byEmail || !config.autoProvision) throw new Error();
      // Provisioning cannot preempt first-administrator setup.
      if (
        !db
          .prepare(
            "SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'",
          )
          .get()
      )
        throw new Error();
      const userId = randomUUID();
      const handle = login || `oidc-${randomUUID()}`;
      const storedEmail = identity.emailVerified === true ? email : null;
      db.prepare(
        "INSERT INTO users(id, login, role, created_at, email, email_trust) VALUES (?, ?, 'user', ?, ?, ?)",
      ).run(
        userId,
        handle,
        Date.now(),
        storedEmail,
        storedEmail ? "oidc_verified" : "unverified",
      );
      bind(db, userId, identity, null, "oidc-provision");
      return { userId, created: true };
    });
  } catch {
    throw new Error("OIDC account unavailable");
  }
}
function linkOidcAccount(db, config, identity, userId, authVersion) {
  try {
    checkIdentity(config, identity);
    return transaction(db, () => {
      const user = db
        .prepare(
          "SELECT * FROM users WHERE id = ? AND status = 'active' AND auth_version = ?",
        )
        .get(userId, authVersion);
      if (!user) throw new Error();
      bind(db, user.id, identity, user.id, "oidc-manual-link");
      return { userId: user.id };
    });
  } catch {
    throw new Error("OIDC account unavailable");
  }
}
module.exports = { resolveOidcAccount, linkOidcAccount };
