// Append migrations; never edit an applied migration.
module.exports = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL UNIQUE CHECK(length(login) BETWEEN 3 AND 64),
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version > 0),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        auth_version INTEGER NOT NULL CHECK(auth_version > 0),
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        CHECK(last_activity >= created_at AND expires_at > created_at)
      ) STRICT;
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      CREATE TABLE vaults (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        directory TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'quarantine')),
        policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE memberships (
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('reader', 'editor', 'owner')),
        PRIMARY KEY(vault_id, user_id)
      ) STRICT;
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_id TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE bootstrap_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        completed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER protect_last_admin_update BEFORE UPDATE OF role, status ON users
      WHEN OLD.role = 'admin' AND OLD.status = 'active'
        AND (NEW.role != 'admin' OR NEW.status != 'active')
        AND (SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active') = 1
      BEGIN SELECT RAISE(ABORT, 'Cannot disable the last administrator'); END;
      CREATE TRIGGER protect_last_admin_delete BEFORE DELETE ON users
      WHEN OLD.role = 'admin' AND OLD.status = 'active'
        AND (SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active') = 1
      BEGIN SELECT RAISE(ABORT, 'Cannot delete the last administrator'); END;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE local_credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL CHECK(length(password_hash) > 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_credentials(user_id, password_hash, updated_at)
        SELECT id, password_hash, created_at FROM users;
      ALTER TABLE users DROP COLUMN password_hash;
      CREATE TABLE oidc_identities (
        issuer TEXT NOT NULL CHECK(length(issuer) > 0),
        subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(issuer, subject)
      ) STRICT;
      CREATE INDEX oidc_identities_user ON oidc_identities(user_id);
    `,
  },
];
