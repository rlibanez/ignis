import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const express = require("express");
const proxyaddr = require("proxy-addr");
function trust(subnets) {
  const app = express();
  app.set("trust proxy", subnets);
  return app.get("trust proxy fn");
}
it("does not trust unrelated IPv4 peers through short IPv6 prefixes", () => {
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    const policy = trust([subnet]);
    expect(policy("198.51.100.23", 0)).toBe(false);
    const request = {
      socket: { remoteAddress: "198.51.100.23" },
      headers: { "x-forwarded-for": "10.0.0.5" },
    };
    expect(proxyaddr(request, policy)).toBe("198.51.100.23");
  }
});
it("preserves intended IPv4 and correctly mapped IPv6 proxy trust", () => {
  for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
    const policy = trust([subnet]);
    expect(policy("10.1.2.3", 0)).toBe(true);
    expect(policy("::ffff:10.1.2.3", 0)).toBe(true);
    expect(policy("198.51.100.23", 0)).toBe(false);
    expect(
      proxyaddr(
        {
          socket: { remoteAddress: "10.1.2.3" },
          headers: { "x-forwarded-for": "198.51.100.23" },
        },
        policy,
      ),
    ).toBe("198.51.100.23");
  }
});
it("keeps forwarding disabled by default and supports explicit IPv6 subnets", () => {
  expect(trust([])("127.0.0.1", 0)).toBe(false);
  const policy = trust(["2001:db8:1::/48"]);
  expect(policy("2001:db8:1::123", 0)).toBe(true);
  expect(policy("2001:db8:2::123", 0)).toBe(false);
  expect(policy("198.51.100.23", 0)).toBe(false);
});
