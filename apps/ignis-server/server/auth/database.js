const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const migrations = require("./schema");

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new Error("Database transactions must be synchronous");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function checkIntegrity(db) {
  const rows = db.prepare("PRAGMA integrity_check").all();
  if (
    rows.length !== 1 ||
    rows[0].integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  ) {
    throw new Error("Identity database integrity check failed");
  }
}

function validateMigrations(db) {
  const applied = db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  for (let i = 0; i < applied.length; i++) {
    const expected = migrations[i];
    if (
      !expected ||
      applied[i].version !== expected.version ||
      applied[i].checksum !== checksum(expected.sql)
    ) {
      throw new Error("Unsupported or modified identity database schema");
    }
  }
  return applied.length;
}

function migrate(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
    ) STRICT`);
    const count = validateMigrations(db);
    for (const migration of migrations.slice(count)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
        migration.version,
        checksum(migration.sql),
        Date.now(),
      );
    }
  });
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (
    !fs.lstatSync(directory).isDirectory() ||
    fs.lstatSync(directory).isSymbolicLink()
  ) {
    throw new Error("Identity directory must be a real directory");
  }
  fs.chmodSync(directory, 0o700);
}

// SQLite may return BUSY immediately during the initial journal-mode transition,
// without invoking its busy timeout. Retry only this idempotent startup operation.
function enableWal(db) {
  const deadline = Date.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const result = db.prepare("PRAGMA journal_mode = WAL").get();
      if (result.journal_mode !== "wal") throw new Error("WAL is unavailable");
      return;
    } catch (error) {
      if (error.errcode !== 5 || Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 20);
    }
  }
}

function openDatabase(dataRoot) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) {
    throw new Error("DATA_ROOT must be an absolute path");
  }
  const directory = path.join(dataRoot, "auth");
  privateDirectory(directory);
  const filename = path.join(directory, "identity.sqlite");
  // Refuse symlinks/hardlinks, including SQLite sidecars. The operator owns DATA_ROOT.
  for (const name of [
    filename,
    filename + "-wal",
    filename + "-shm",
    filename + "-journal",
  ]) {
    try {
      const stat = fs.lstatSync(name);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Unsafe identity database file");
      fs.chmodSync(name, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const fd = fs.openSync(
    filename,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.closeSync(fd);
  let db;
  try {
    db = new DatabaseSync(filename, {
      timeout: 5000,
      enableForeignKeyConstraints: true,
    });
    db.exec("PRAGMA trusted_schema = OFF");
    enableWal(db);
    db.exec("PRAGMA synchronous = FULL");
    migrate(db);
    checkIntegrity(db);
    return db;
  } catch (error) {
    db?.close();
    throw error;
  }
}

// Consistent SQLite snapshot, including committed WAL data. Destination must not exist.
function backupDatabase(db, destination) {
  if (!path.isAbsolute(destination))
    throw new Error("Backup path must be absolute");
  const parent = path.dirname(destination);
  const temp = fs.mkdtempSync(path.join(parent, ".ignis-backup-"));
  const snapshot = path.join(temp, "snapshot.sqlite");
  try {
    db.prepare("VACUUM INTO ?").run(snapshot);
    fs.chmodSync(snapshot, 0o600);
    const check = new DatabaseSync(snapshot, { readOnly: true });
    try {
      checkIntegrity(check);
      validateMigrations(check);
    } finally {
      check.close();
    }
    const fd = fs.openSync(snapshot, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Atomic no-replace publication on the same filesystem.
    fs.linkSync(snapshot, destination);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Restore into a NEW auth directory only. Never replace a running database or its WAL.
function restoreDatabase(source, dataRoot) {
  if (!path.isAbsolute(source) || !path.isAbsolute(dataRoot))
    throw new Error("Paths must be absolute");
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe backup file");
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const directory = path.join(dataRoot, "auth");
  fs.mkdirSync(directory, { mode: 0o700 }); // Fails if target already exists.
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    checkIntegrity(db);
    if (validateMigrations(db) !== migrations.length)
      throw new Error("Backup schema is not current");
    backupDatabase(db, path.join(directory, "identity.sqlite"));
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    db?.close();
  }
}

module.exports = { openDatabase, transaction, backupDatabase, restoreDatabase };
