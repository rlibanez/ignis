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
  {
    version: 3,
    sql: `
      -- v1/v2 sessions were storage fixtures, never issued by an authentication service.
      -- Revoke them rather than inventing provenance or authentication times.
      DROP TABLE sessions;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
        id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        auth_version INTEGER NOT NULL CHECK(auth_version > 0),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        last_activity INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        idle_timeout_ms INTEGER NOT NULL CHECK(idle_timeout_ms > 0),
        method TEXT NOT NULL CHECK(method IN ('local', 'oidc')),
        issuer TEXT,
        subject TEXT,
        authenticated_at INTEGER NOT NULL CHECK(authenticated_at >= 0 AND authenticated_at <= created_at),
        CHECK(last_activity >= created_at AND expires_at > last_activity),
        CHECK((method = 'local' AND issuer IS NULL AND subject IS NULL) OR
          (method = 'oidc' AND length(issuer) > 0 AND length(subject) BETWEEN 1 AND 255
           AND issuer IS NOT NULL AND subject IS NOT NULL))
      ) STRICT;
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      CREATE TRIGGER revoke_user_sessions AFTER UPDATE OF role, status ON users
      WHEN OLD.role != NEW.role OR OLD.status != NEW.status
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id = NEW.id;
        DELETE FROM sessions WHERE user_id = NEW.id;
      END;
      CREATE TRIGGER revoke_local_insert AFTER INSERT ON local_credentials
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id = NEW.user_id;
        DELETE FROM sessions WHERE user_id = NEW.user_id;
      END;
      CREATE TRIGGER revoke_local_update AFTER UPDATE ON local_credentials
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id IN (OLD.user_id, NEW.user_id);
        DELETE FROM sessions WHERE user_id IN (OLD.user_id, NEW.user_id);
      END;
      CREATE TRIGGER revoke_local_delete AFTER DELETE ON local_credentials
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id = OLD.user_id;
        DELETE FROM sessions WHERE user_id = OLD.user_id;
      END;
      CREATE TRIGGER revoke_oidc_insert AFTER INSERT ON oidc_identities
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id = NEW.user_id;
        DELETE FROM sessions WHERE user_id = NEW.user_id;
      END;
      CREATE TRIGGER revoke_oidc_update AFTER UPDATE ON oidc_identities
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id IN (OLD.user_id, NEW.user_id);
        DELETE FROM sessions WHERE user_id IN (OLD.user_id, NEW.user_id);
      END;
      CREATE TRIGGER revoke_oidc_delete AFTER DELETE ON oidc_identities
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id = OLD.user_id;
        DELETE FROM sessions WHERE user_id = OLD.user_id;
      END;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE users ADD COLUMN email TEXT CHECK(email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email = lower(email)));
      ALTER TABLE users ADD COLUMN email_trust TEXT NOT NULL DEFAULT 'unverified'
        CHECK(email_trust IN ('unverified', 'admin_confirmed', 'oidc_verified') AND (email IS NOT NULL OR email_trust = 'unverified'));
      CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
      CREATE TRIGGER revoke_email_update AFTER UPDATE OF email, email_trust ON users
      WHEN OLD.email IS NOT NEW.email OR OLD.email_trust != NEW.email_trust
      BEGIN
        UPDATE users SET auth_version = auth_version + 1 WHERE id = NEW.id;
        DELETE FROM sessions WHERE user_id = NEW.id;
      END;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE UNIQUE INDEX oidc_identities_user_issuer ON oidc_identities(user_id, issuer);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE password_resets (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
        auth_version INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE password_reset_grants (
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
        user_id TEXT NOT NULL UNIQUE REFERENCES password_resets(user_id) ON DELETE CASCADE,
        reset_hash TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE vault_renames (
        vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
        source TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        CHECK(source != target)
      ) STRICT;
      CREATE TRIGGER reserve_rename_insert BEFORE INSERT ON vaults
      WHEN EXISTS (SELECT 1 FROM vault_renames WHERE source=NEW.directory OR target=NEW.directory OR target=NEW.id)
      BEGIN SELECT RAISE(ABORT, 'Vault name reserved'); END;
      CREATE TRIGGER reserve_rename_update BEFORE UPDATE OF directory ON vaults
      WHEN EXISTS (SELECT 1 FROM vault_renames WHERE vault_id!=NEW.id AND (source=NEW.directory OR target=NEW.directory))
      BEGIN SELECT RAISE(ABORT, 'Vault name reserved'); END;
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE vault_deletions (
        vault_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        trash_name TEXT NOT NULL UNIQUE,
        device TEXT NOT NULL,
        inode TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','retired','purged')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX pending_vault_deletion ON vault_deletions(source) WHERE state='pending';
      CREATE TRIGGER reserve_deleted_identity_insert BEFORE INSERT ON vaults
      WHEN EXISTS (SELECT 1 FROM vault_deletions WHERE vault_id=NEW.id OR vault_id=NEW.directory OR (state='pending' AND source=NEW.directory))
      BEGIN SELECT RAISE(ABORT, 'Vault identity reserved'); END;
      CREATE TRIGGER reserve_deleted_identity_update BEFORE UPDATE OF directory ON vaults
      WHEN EXISTS (SELECT 1 FROM vault_deletions WHERE vault_id=NEW.directory OR (state='pending' AND source=NEW.directory))
      BEGIN SELECT RAISE(ABORT, 'Vault identity reserved'); END;
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE vault_preferences (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        content TEXT NOT NULL CHECK(length(CAST(content AS BLOB)) <= 1048576),
        revision INTEGER NOT NULL CHECK(revision > 0),
        PRIMARY KEY(user_id, vault_id, path)
      ) STRICT;
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE shared_resources (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
        device TEXT NOT NULL,
        inode TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        UNIQUE(vault_id,path)
      ) STRICT;
      CREATE TABLE resource_grants (
        resource_id TEXT NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('reader','editor')),
        PRIMARY KEY(resource_id,user_id)
      ) STRICT;
    `,
  },
  {
    version: 12,
    sql: `CREATE TABLE resource_destinations (
      resource_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      PRIMARY KEY(resource_id,user_id),
      FOREIGN KEY(resource_id,user_id) REFERENCES resource_grants(resource_id,user_id) ON DELETE CASCADE,
      FOREIGN KEY(vault_id,user_id) REFERENCES memberships(vault_id,user_id) ON DELETE CASCADE
    ) STRICT;`,
  },
  {version:13,sql:`ALTER TABLE resource_destinations ADD COLUMN local_path TEXT NOT NULL DEFAULT '';`},
  {version:14,sql:`ALTER TABLE resource_destinations RENAME COLUMN local_path TO destination_folder; UPDATE resource_destinations SET destination_folder=rtrim(rtrim(destination_folder,replace(destination_folder,'/','')),'/');`},
  {version:15,sql:`ALTER TABLE resource_destinations ADD COLUMN local_path TEXT NOT NULL DEFAULT '';
    UPDATE resource_destinations SET local_path=CASE WHEN destination_folder='' THEN '' ELSE destination_folder||'/' END ||
      (SELECT substr(path,length(rtrim(path,replace(path,'/','')))+1) FROM shared_resources WHERE id=resource_id);`},
  {version:16,sql:`CREATE TABLE csrf_tokens (
    token_hash TEXT PRIMARY KEY,
    browser_hash BLOB NOT NULL,
    session_id TEXT,
    expires_at INTEGER NOT NULL
  ) STRICT; CREATE INDEX csrf_tokens_expiry ON csrf_tokens(expires_at);`},
  {version:17,sql:`CREATE TABLE user_deletions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vaults TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER prevent_reactivating_deleting_user BEFORE UPDATE OF status ON users
  WHEN NEW.status!='disabled' AND EXISTS (SELECT 1 FROM user_deletions WHERE user_id=OLD.id)
  BEGIN SELECT RAISE(ABORT, 'Account deletion in progress'); END;`},
];
