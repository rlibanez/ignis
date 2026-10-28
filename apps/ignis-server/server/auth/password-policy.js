function readPasswordPolicy(env = process.env) {
  function integer(name, fallback, min, max) {
    const value = env[name] ?? String(fallback);
    if (
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      Number(value) < min ||
      Number(value) > max
    )
      throw new Error(`Invalid ${name}`);
    return Number(value);
  }
  const minLength = integer("IGNIS_PASSWORD_MIN_LENGTH", 8, 8, 128);
  const minSpecialChars = integer(
    "IGNIS_PASSWORD_MIN_SPECIAL_CHARS",
    0,
    0,
    minLength,
  );
  return Object.freeze({ minLength, minSpecialChars, maxBytes: 1024 });
}

function meetsPasswordPolicy(password, policy) {
  return (
    typeof password === "string" &&
    Buffer.byteLength(password) <= policy.maxBytes &&
    [...password].length >= policy.minLength &&
    (password.match(/[\p{P}\p{S}]/gu) || []).length >= policy.minSpecialChars
  );
}

module.exports = { readPasswordPolicy, meetsPasswordPolicy };
