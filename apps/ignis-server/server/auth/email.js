const { randomUUID } = require("node:crypto");
const { transaction } = require("./database");

// Deliberate application policy: ASCII dot-atom addresses, case-insensitive matching.
// Do not strip dots, plus tags, or apply provider-specific aliases.
function normalizeEmail(value) {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim())
    throw new Error("Invalid email address");
  const parts = value.split("@");
  if (
    parts.length !== 2 ||
    parts[0].length > 64 ||
    !/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(
      parts[0],
    ) ||
    !parts[1].includes(".") ||
    parts[1]
      .split(".")
      .some(
        (label) =>
          !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      )
  )
    throw new Error("Invalid email address");
  return value.toLowerCase();
}
// Trusted local administration entry point. actorId=null denotes CLI operator.
function setUserEmail(db, userId, value, trust = "unverified", actorId = null) {
  const email = value === null ? null : normalizeEmail(value);
  if (
    !["unverified", "admin_confirmed"].includes(trust) ||
    (email === null && trust !== "unverified")
  )
    throw new Error("Invalid email trust");
  return transaction(db, () => {
    if (
      actorId !== null &&
      !db
        .prepare(
          "SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active'",
        )
        .get(actorId)
    )
      throw new Error("Administrator required");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId))
      throw new Error("User not found");
    if (
      email &&
      db
        .prepare("SELECT 1 FROM users WHERE email = ? AND id != ?")
        .get(email, userId)
    )
      throw new Error("Email already assigned");
    db.prepare("UPDATE users SET email = ?, email_trust = ? WHERE id = ?").run(
      email,
      trust,
      userId,
    );
    db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(),
      actorId,
      "set-user-email",
      userId,
      Date.now(),
    );
    return { email, trust };
  });
}
module.exports = { normalizeEmail, setUserEmail };
