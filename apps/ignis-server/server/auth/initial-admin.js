const fs = require("node:fs");
const { createHash, timingSafeEqual } = require("node:crypto");
const {
  readPasswordPolicy,
  meetsPasswordPolicy,
} = require("./password-policy");
const { hashPassword } = require("./password");
const { bootstrapAdmin, normalizeLogin } = require("./store");
const digest = (value) => createHash("sha256").update(value).digest();

function readInitialAdminKey(env) {
  const inline = env.IGNIS_INITIAL_ADMIN_KEY || "";
  const filename = env.IGNIS_INITIAL_ADMIN_KEY_FILE || "";
  if (inline && filename)
    throw new Error("Configure only one initial admin key source");
  let value = inline;
  if (filename) {
    let fd;
    try {
      fd = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 34)
        throw new Error("Invalid initial admin key file");
      const buffer = Buffer.alloc(35);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      value = buffer
        .subarray(0, count)
        .toString("utf8")
        .replace(/\r?\n$/, "");
    } catch (error) {
      // An unavailable secret disables web setup; local CLI recovery remains available.
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null;
      throw new Error("Invalid initial admin key file");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (!value) return null;
  if (!/^[a-f0-9]{32}$/.test(value))
    throw new Error("Invalid initial admin key format");
  return digest(value);
}

function createInitialAdminSetup(
  db,
  { keyDigest, initialized, passwordPolicy = readPasswordPolicy() },
) {
  return {
    available: () => !initialized() && !!keyDigest,
    async create(body) {
      if (initialized())
        return { status: 409, error: "Initial setup is closed" };
      if (
        !keyDigest ||
        typeof body?.initialAdminKey !== "string" ||
        !/^[a-f0-9]{32}$/.test(body.initialAdminKey) ||
        !timingSafeEqual(keyDigest, digest(body.initialAdminKey))
      )
        return { status: 403, error: "Setup request rejected" };
      let login;
      try {
        login = normalizeLogin(body.login);
      } catch {
        return { status: 400, error: "Invalid account details" };
      }
      const password = body.password;
      if (
        typeof password !== "string" ||
        password !== body.passwordConfirmation ||
        !meetsPasswordPolicy(password, passwordPolicy)
      )
        return { status: 400, error: "Invalid account details" };
      const hash = await hashPassword(password, passwordPolicy);
      try {
        // The same transaction as the CLI chooses one winner across processes.
        bootstrapAdmin(db, login, hash);
      } catch (error) {
        if (initialized())
          return { status: 409, error: "Initial setup is closed" };
        throw error;
      }
      return { status: 201 };
    },
  };
}

module.exports = { readInitialAdminKey, createInitialAdminSetup };
