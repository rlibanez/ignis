import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createJwksFetch } = require("./jwks");
const valid = () => Response.json({ keys: [{ kty: "EC", kid: "synthetic" }] });
it("coalesces concurrent refreshes without sharing a consumed response body", async () => {
  let release,
    count = 0,
    time = 0;
  const get = createJwksFetch(
    () => {
      count++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    { now: () => time },
  );
  const first = get("url"),
    second = get("url");
  release(valid());
  const responses = await Promise.all([first, second]);
  expect(await responses[0].json()).toEqual(await responses[1].json());
  expect(count).toBe(1);
  await expect(get("url")).rejects.toThrow();
  time = 60000;
  const next = get("url");
  release(valid());
  await next;
  expect(count).toBe(2);
});
it.each([
  { keys: [] },
  { keys: [null] },
  { keys: [{ kty: "oct", k: "secret" }] },
  { keys: [{ kid: "x".repeat(16385) }] },
])("rejects invalid or excessive key material", async (body) => {
  const get = createJwksFetch(async () => Response.json(body));
  await expect(get("url")).rejects.toThrow(/^OIDC key refresh unavailable$/);
});

it.each([128, 1025])(
  "rejects out-of-policy RSA modulus size %s",
  async (bytes) => {
    const get = createJwksFetch(async () =>
      Response.json({
        keys: [
          {
            kty: "RSA",
            n: Buffer.alloc(bytes, 255).toString("base64url"),
            e: "AQAB",
          },
        ],
      }),
    );
    await expect(get("url")).rejects.toThrow();
  },
);
