const { randomBytes, scrypt } = require("node:crypto");
const { promisify } = require("node:util");
const derive = promisify(scrypt);

// Node 22 provides scrypt without native addon installation. Versioned for future rehash.
async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    [...password].length < 15 ||
    Buffer.byteLength(password) > 1024
  ) {
    throw new Error(
      "Password must contain at least 15 characters and at most 1024 bytes",
    );
  }
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 64, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$131072$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

module.exports = { hashPassword };
