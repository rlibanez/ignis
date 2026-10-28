const {
  readPasswordPolicy,
  meetsPasswordPolicy,
} = require("./password-policy");
const { randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const derive = promisify(scrypt);
const FORMAT = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const DUMMY = `scrypt$131072$8$1$${"00".repeat(16)}$${"00".repeat(64)}`;
// Each job uses about 128 MiB. No unbounded queue before the HTTP limiter exists.
const MAX_PASSWORD_JOBS = 2;
let activeJobs = 0;

function validInput(password) {
  return (
    typeof password === "string" &&
    password.length > 0 &&
    password.length <= 1024 &&
    Buffer.byteLength(password) <= 1024
  );
}

async function deriveBounded(password, salt) {
  if (activeJobs >= MAX_PASSWORD_JOBS) {
    const error = new Error("Authentication is temporarily busy");
    error.code = "AUTH_BUSY";
    throw error;
  }
  activeJobs++;
  try {
    return await derive(password, salt, 64, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
  } finally {
    activeJobs--;
  }
}

async function hashPassword(password, policy = readPasswordPolicy()) {
  if (!validInput(password) || !meetsPasswordPolicy(password, policy)) {
    throw new Error(
      `Password must contain at least ${policy.minLength} characters and ${policy.minSpecialChars} punctuation or symbol characters, and at most ${policy.maxBytes} bytes`,
    );
  }
  const salt = randomBytes(16);
  const hash = await deriveBounded(password, salt);
  return `scrypt$131072$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  if (!validInput(password)) return false;
  // Never execute parameters read from a stored hash. Only the supported format is accepted.
  const match =
    typeof encoded === "string" && encoded.length === DUMMY.length
      ? FORMAT.exec(encoded)
      : null;
  const fields = match || FORMAT.exec(DUMMY);
  const actual = await deriveBounded(password, Buffer.from(fields[1], "hex"));
  const equal = timingSafeEqual(actual, Buffer.from(fields[2], "hex"));
  return !!match && equal;
}

module.exports = { hashPassword, verifyPassword };
