import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  readPasswordPolicy,
  meetsPasswordPolicy,
} = require("./password-policy");
const { hashPassword, verifyPassword } = require("./password");
it("defaults to eight Unicode characters without composition requirements", () => {
  const policy = readPasswordPolicy({});
  expect(policy).toEqual({ minLength: 8, minSpecialChars: 0, maxBytes: 1024 });
  expect(meetsPasswordPolicy("12345678", policy)).toBe(true);
  expect(meetsPasswordPolicy("1234567", policy)).toBe(false);
  expect(meetsPasswordPolicy("😀".repeat(7), policy)).toBe(false);
  expect(meetsPasswordPolicy("😀".repeat(8), policy)).toBe(true);
  expect(meetsPasswordPolicy("é".repeat(513), policy)).toBe(false);
});
it("counts punctuation and symbols, excluding letters, whitespace and combining marks", () => {
  const policy = readPasswordPolicy({ IGNIS_PASSWORD_MIN_SPECIAL_CHARS: "2" });
  for (const password of ["password!*", "password€😀"])
    expect(meetsPasswordPolicy(password, policy)).toBe(true);
  for (const password of [
    "password!",
    "password  ",
    "passwordéñ",
    "password\u0301\u0301",
  ])
    expect(meetsPasswordPolicy(password, policy)).toBe(false);
});
it("rejects invalid or contradictory configuration rather than silently falling back", () => {
  for (const value of [
    "",
    "7",
    "129",
    "8.5",
    "8x",
    "-8",
    " 8",
    "Infinity",
    "08",
  ])
    expect(() =>
      readPasswordPolicy({ IGNIS_PASSWORD_MIN_LENGTH: value }),
    ).toThrow();
  for (const value of ["-1", "9", "1.5", "", "x"])
    expect(() =>
      readPasswordPolicy({ IGNIS_PASSWORD_MIN_SPECIAL_CHARS: value }),
    ).toThrow();
  expect(
    readPasswordPolicy({
      IGNIS_PASSWORD_MIN_LENGTH: "20",
      IGNIS_PASSWORD_MIN_SPECIAL_CHARS: "1",
    }).minLength,
  ).toBe(20);
});
it("enforces the same policy at hashing without applying new rules to existing login", async () => {
  const password = "abcdefgh";
  const hash = await hashPassword(password, readPasswordPolicy({}));
  const stricter = readPasswordPolicy({
    IGNIS_PASSWORD_MIN_LENGTH: "15",
    IGNIS_PASSWORD_MIN_SPECIAL_CHARS: "1",
  });
  await expect(hashPassword(password, stricter)).rejects.toThrow(/15/);
  expect(await verifyPassword(password, hash)).toBe(true);
  await expect(hashPassword("short", readPasswordPolicy({}))).rejects.toThrow();
});
