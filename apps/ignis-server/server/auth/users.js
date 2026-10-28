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

module.exports = { createLocalUser, listUsers };
