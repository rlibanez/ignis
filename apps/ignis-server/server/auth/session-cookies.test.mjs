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

it("requires opt-in for literal RFC1918 HTTP origins for all cookie purposes", () => {
  for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.2.9"]) {
    expect(() => createSessionCookies({ publicOrigin: `http://${host}:8080` })).toThrow();
    for (const purpose of ["session", "csrf", "oidc"]) {
      const cookies = createSessionCookies({ publicOrigin: `http://${host}:8080`, allowHttpPrivateNetwork: true, purpose });
      expect(cookies.name).toBe(`ignis-dev-${purpose}`);
      expect(cookies.serialize(token, 60000, 1000)).toContain("HttpOnly; SameSite=Lax");
      expect(cookies.serialize(token, 60000, 1000)).not.toContain("Secure");
    }
  }
  for (const host of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "localhost", "127.0.0.1", "ignis.local", "[::1]", "[fd00::1]"]) {
    expect(() => createSessionCookies({ publicOrigin: `http://${host}`, allowHttpPrivateNetwork: true })).toThrow();
  }
  expect(createSessionCookies({ publicOrigin: "https://ignis.example", allowHttpPrivateNetwork: true }).serialize(token, 60000, 1000)).toContain("; Secure");
});
it("parses the LAN exception strictly and leaves it disabled by default", () => {
  const { readAuthConfig } = require("./http-policy");
  const env = { IGNIS_PUBLIC_ORIGIN: "http://192.168.2.9:8080" };
  expect(readAuthConfig(env).allowHttpPrivateNetwork).toBe(false);
  expect(readAuthConfig({ ...env, IGNIS_ALLOW_HTTP_PRIVATE_NETWORK: "true" }).allowHttpPrivateNetwork).toBe(true);
  for (const value of ["1", "TRUE", "", "yes"])
    expect(() => readAuthConfig({ ...env, IGNIS_ALLOW_HTTP_PRIVATE_NETWORK: value })).toThrow();
});
