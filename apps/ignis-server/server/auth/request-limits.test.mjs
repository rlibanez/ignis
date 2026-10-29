import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createRequestLimits } = require("./request-limits");
it("bounds account attempts across IPs and expires limits without permanent lockout", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (let i = 0; i < 10; i++)
    expect(limits.login(`ip-${i}`, "account")).toBe(true);
  expect(limits.login("another-ip", "account")).toBe(false);
  at = 15 * 60000;
  expect(limits.login("another-ip", "account")).toBe(true);
});
it("rejects new buckets on capacity exhaustion and recovers after expiry", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at, capacity: 3 });
  expect(limits.login("ip", "account")).toBe(true);
  expect(limits.login("other", "different")).toBe(false);
  at = 15 * 60000;
  expect(limits.login("other", "different")).toBe(true);
});
it("limits global login pressure even when both IP and account vary", () => {
  const limits = createRequestLimits();
  for (let i = 0; i < 60; i++)
    expect(limits.login(`ip-${i}`, `user-${i}`)).toBe(true);
  expect(limits.login("new-ip", "new-user")).toBe(false);
});
it("bounds setup globally across IPs and recovers after the setup window", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (let i = 0; i < 20; i++) expect(limits.setup(`ip-${i}`)).toBe(true);
  expect(limits.setup("another")).toBe(false);
  at = 15 * 60000;
  expect(limits.setup("another")).toBe(true);
});

it("bounds user creation per administrator and globally, then recovers", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (const actor of ["a", "b", "c"]) {
    for (let i = 0; i < 10; i++) expect(limits.createUser(actor)).toBe(true);
    expect(limits.createUser(actor)).toBe(false);
  }
  expect(limits.createUser("d")).toBe(false);
  at = 60000;
  expect(limits.createUser("a")).toBe(true);
});

it("separates assets and auth reads from sensitive request budgets and expires them", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (let i = 0; i < 600; i++) expect(limits.staticRequest("ip")).toBe(true);
  expect(limits.staticRequest("ip")).toBe(false);
  for (let i = 0; i < 300; i++) expect(limits.authRead("ip")).toBe(true);
  expect(limits.authRead("ip")).toBe(false);
  expect(limits.publicRequest("ip")).toBe(true);
  for (let i = 0; i < 10; i++) expect(limits.oidcStart("ip")).toBe(true);
  expect(limits.oidcStart("ip")).toBe(false);
  at = 60000;
  expect(limits.staticRequest("ip")).toBe(true);
  expect(limits.authRead("ip")).toBe(true);
  expect(limits.oidcStart("ip")).toBe(false);
});
