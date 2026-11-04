import { it, expect } from "vitest";
import { scopedStorage } from "./account-storage.js";
function memory() {
  const values = new Map();
  return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
it("isolates global Obsidian values, enumeration and clear between accounts", () => {
  const native = memory();
  native.setItem("obsidian-account", "legacy-secret");
  let account = "alice";
  const alice = scopedStorage(native, account, () => account);
  expect(alice.getItem("obsidian-account")).toBeNull();
  alice.setItem("obsidian-account", "alice-secret");
  alice.language = "es";
  expect(Object.keys(alice)).toEqual(["obsidian-account", "language"]);
  expect(alice.length).toBe(2);
  account = "bob";
  const bob = scopedStorage(native, account, () => account);
  expect(bob.getItem("obsidian-account")).toBeNull();
  expect(() => alice.getItem("obsidian-account")).toThrow();
  expect(() => { alice.language = "en"; }).toThrow();
  bob.setItem("obsidian-account", "bob-secret");
  bob.clear();
  expect(bob.length).toBe(0);
  account = "alice";
  expect(alice.getItem("obsidian-account")).toBe("alice-secret");
  delete alice.language;
  expect(alice.key(0)).toBe("obsidian-account");
  expect(native.getItem("obsidian-account")).toBe("legacy-secret");
  account = null;
  expect(() => alice.clear()).toThrow();
});
