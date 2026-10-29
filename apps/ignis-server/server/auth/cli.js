#!/usr/bin/env node
// Local administration shares the identity store and password policy with web setup.
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { Writable } = require("node:stream");
const { openDatabase, backupDatabase, restoreDatabase } = require("./database");
const { bootstrapAdmin, normalizeLogin, registerVault } = require("./store");
const { readPasswordPolicy } = require("./password-policy");
const { setUserEmail } = require("./email");
const { hashPassword } = require("./password");
const { createLocalUser, listUsers } = require("./users");

function question(prompt, hidden = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(
      new Error("Password input requires an interactive terminal"),
    );
  }
  return new Promise((resolve, reject) => {
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!hidden) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    let answered = false;
    process.stdout.write(prompt);
    rl.once("SIGINT", () => rl.close());
    rl.once("close", () => {
      if (!answered) reject(new Error("Input cancelled"));
    });
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const arity = {
    init: 0,
    bootstrap: 0,
    status: 0,
    "create-user": 0,
    "list-users": 0,
    "list-vaults": 0,
    "resolve-vault": 1,
    "reset-password": 1,
    "register-vault": 2,
    "set-email": 3,
    backup: 1,
    restore: 1,
  };
  if (!Object.hasOwn(arity, command) || rest.length !== arity[command]) {
    throw new Error(
      "Usage: npm run auth -- init|bootstrap|status|create-user|list-users|list-vaults|resolve-vault <id-or-directory>|reset-password <login>|set-email <login> <email|-> <unverified|admin_confirmed>|register-vault <directory> <owner-login>|backup <absolute-file>|restore <absolute-file>",
    );
  }
  const root = path.resolve(__dirname, "../../../..");
  const dataRoot = process.env.DATA_ROOT || path.join(root, "data");
  if (command === "restore") {
    restoreDatabase(rest[0], dataRoot);
    console.log(
      "Identity database restored into a new auth directory. Vault files are not restored.",
    );
    return;
  }
  if (
    !["init", "bootstrap"].includes(command) &&
    !fs.existsSync(path.join(dataRoot, "auth", "identity.sqlite"))
  ) {
    throw new Error("Identity database does not exist; run init first");
  }
  const db = openDatabase(dataRoot);
  try {
    if (command === "bootstrap") {
      if (
        db.prepare("SELECT 1 FROM bootstrap_state").get() ||
        db.prepare("SELECT 1 FROM users").get()
      ) {
        throw new Error("Administrator bootstrap has already been completed");
      }
      const policy = readPasswordPolicy();
      const login = normalizeLogin(await question("Administrator login: "));
      let password = await question(
        `Password (${policy.minLength}+ characters, ${policy.minSpecialChars}+ punctuation/symbols): `,
        true,
      );
      let confirmation = await question("Confirm password: ", true);
      if (password !== confirmation) throw new Error("Passwords do not match");
      const hash = await hashPassword(password, policy);
      password = confirmation = null;
      const user = bootstrapAdmin(db, login, hash);
      console.log(`Administrator created: ${user.login} (${user.id})`);
    } else if (command === "create-user") {
      if (!db.prepare(
        "SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'",
      ).get()) {
        throw new Error("Create the first administrator before adding users");
      }
      const policy = readPasswordPolicy();
      const login = normalizeLogin(await question("User login: "));
      let password = await question(
        `Password (${policy.minLength}+ characters, ${policy.minSpecialChars}+ punctuation/symbols): `,
        true,
      );
      let confirmation = await question("Confirm password: ", true);
      if (password !== confirmation) throw new Error("Passwords do not match");
      const user = await createLocalUser(db, null, login, password, policy);
      password = confirmation = null;
      console.log(`User created: ${user.login} (${user.id})`);
    } else if (command === "reset-password") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Reset secret requires an interactive terminal");
      const user = db.prepare("SELECT id FROM users WHERE login=?").get(normalizeLogin(rest[0]));
      if (!user) throw new Error("User not found");
      if (await question("Close all sessions and require a new password? Type yes: ") !== "yes") throw new Error("Cancelled");
      const result = require("./password-reset").issuePasswordReset(db, null, user.id);
      console.log(`Temporary password (shown once): ${result.secret}`);
      console.log(`Expires: ${new Date(result.expiresAt).toISOString()}. Sign in with your username and this temporary password to choose a new password.`);
    } else if (command === "list-vaults") {
      console.log(JSON.stringify(require("./vault-catalog").listRegisteredVaults(db), null, 2));
    } else if (command === "resolve-vault") {
      const vault = require("./vault-catalog").resolveRegisteredVault(db, process.env.VAULT_ROOT || path.join(root, "vaults"), rest[0]);
      console.log(JSON.stringify({ id: vault.id, name: vault.name, directory: vault.directory, status: vault.status }, null, 2));
    } else if (command === "list-users") {
      console.log(JSON.stringify(listUsers(db, null), null, 2));
    } else if (command === "set-email") {
      const user = db
        .prepare("SELECT id FROM users WHERE login = ?")
        .get(normalizeLogin(rest[0]));
      if (!user) throw new Error("User not found");
      setUserEmail(db, user.id, rest[1] === "-" ? null : rest[1], rest[2]);
      console.log("User email updated; existing sessions revoked if changed.");
    } else if (command === "register-vault") {
      const owner = db
        .prepare("SELECT id FROM users WHERE login = ?")
        .get(normalizeLogin(rest[1]));
      if (!owner) throw new Error("Owner does not exist");
      const vault = registerVault(
        db,
        process.env.VAULT_ROOT || path.join(root, "vaults"),
        rest[0],
        owner.id,
      );
      console.log(`Vault registered: ${vault.name} (${vault.id})`);
    } else if (command === "backup") {
      backupDatabase(db, rest[0]);
      console.log(
        "Identity database snapshot saved. Vault files require a separate backup.",
      );
    } else {
      console.log(
        JSON.stringify({
          schema: db
            .prepare("SELECT max(version) AS version FROM schema_migrations")
            .get().version,
          users: db.prepare("SELECT count(*) AS count FROM users").get().count,
          vaults: db.prepare("SELECT count(*) AS count FROM vaults").get()
            .count,
        }),
      );
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[auth] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
