import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createSessionCookies } = require("./session-cookies");
const token = "ab".repeat(32);

describe("session cookie policy", () => {
  it("uses host-only secure HttpOnly cookies and clears with the same scope", () => {
    const cookies = createSessionCookies({
      publicOrigin: "https://ignis.example",
    });
    const header = cookies.serialize(token, 60000, 1000);
    expect(header).toContain("__Host-ignis-session=" + token);
    expect(header).toContain("Path=/; HttpOnly; SameSite=Lax; Secure");
    expect(header).toContain("Max-Age=59");
    expect(header).not.toContain("Domain=");
    expect(cookies.clear()).toContain(
      "Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
    );
    expect(cookies.read(`unrelated=value; ${cookies.name}=${token}`)).toBe(
      token,
    );
  });
  it("requires an explicit loopback-only HTTP exception", () => {
    expect(() =>
      createSessionCookies({ publicOrigin: "http://localhost:8080" }),
    ).toThrow();
    for (const publicOrigin of [
      "http://localhost:8080",
      "http://127.0.0.1",
      "http://[::1]",
    ]) {
      const cookies = createSessionCookies({
        publicOrigin,
        allowHttpLoopback: true,
      });
      expect(cookies.name).toBe("ignis-dev-session");
      expect(cookies.serialize(token, 60000, 1000)).not.toContain("Secure");
    }
    for (const publicOrigin of [
      "http://ignis.example",
      "http://192.168.1.2",
      "ftp://localhost",
      "https://user:secret@ignis.example",
      "https://ignis.example/path",
      "https://ignis.example/?x=1",
    ]) {
      expect(() =>
        createSessionCookies({ publicOrigin, allowHttpLoopback: true }),
      ).toThrow();
    }
  });
  it("rejects ambiguous and malformed cookies and does not mix production and development", () => {
    const cookies = createSessionCookies({
      publicOrigin: "https://ignis.example",
    });
    for (const header of [
      undefined,
      "",
      `${cookies.name}=${token}; ${cookies.name}=${token}`,
      `${cookies.name}=`,
      `${cookies.name}`,
      `${cookies.name}=%61${token.slice(1)}`,
      `${cookies.name}="${token}"`,
      `${cookies.name}=${token}\r\n`,
      "x".repeat(8193),
      `ignis-dev-session=${token}`,
    ]) {
      expect(cookies.read(header)).toBeNull();
    }
  });
  it("rejects token injection and invalid expiry values", () => {
    const cookies = createSessionCookies({
      publicOrigin: "https://ignis.example",
    });
    expect(() =>
      cookies.serialize(token + "; Domain=evil.example", 60000, 1000),
    ).toThrow();
    for (const expires of [1000, 999, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => cookies.serialize(token, expires, 1000)).toThrow();
    }
  });
});
