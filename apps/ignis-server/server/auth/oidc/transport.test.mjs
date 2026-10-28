import { it, expect, beforeAll, afterAll } from "vitest";
import https from "node:https";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createOidcTransport, isPublicAddress } = require("./transport");
const cert = fs.readFileSync(
  new URL("./fixtures/localhost-cert.pem", import.meta.url),
);
const key = fs.readFileSync(
  new URL("./fixtures/localhost-key.pem", import.meta.url),
);
let server,
  origin,
  hits = 0;
beforeAll(async () => {
  server = https.createServer({ cert, key }, (req, res) => {
    hits++;
    if (req.url === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          jwks_uri: origin + "/keys",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }
    if (req.url === "/slow-body") {
      res.writeHead(200);
      res.write("x");
      const timer = setInterval(() => res.write("x"), 10);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/hang") return;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: origin + "/ok" });
      res.end();
      return;
    }
    if (req.url === "/compressed") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end("abc");
      return;
    }
    if (req.url === "/large-header") {
      res.writeHead(200, { "x-large": "a".repeat(20000) });
      res.end();
      return;
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-length": "50000" });
      res.end("a".repeat(50000));
      return;
    }
    if (req.url === "/chunked") {
      res.writeHead(200);
      res.write("a".repeat(300));
      res.end("b".repeat(300));
      return;
    }
    if (req.url === "/truncated") {
      res.writeHead(200, { "content-length": "1000" });
      res.write("x");
      setTimeout(() => res.destroy(), 5);
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(req.url === "/error" ? 400 : 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({
          body,
          authorization: req.headers.authorization ?? null,
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://oidc.test.invalid:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
function transport(
  options = {},
  lookup = (_host, _options, cb) =>
    cb(null, [{ address: "127.0.0.1", family: 4 }]),
) {
  return createOidcTransport(
    {
      origins: [origin],
      privateAddresses: { [origin]: ["127.0.0.1"] },
      ca: cert,
      ...options,
    },
    { lookup },
  );
}
it("classifies IPv4, IPv6 and reserved/transition destinations conservatively", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    expect(isPublicAddress(ip)).toBe(true);
  for (const ip of [
    "invalid",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.2.1",
    "198.18.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "64:ff9b::808:808",
    "3fff::1",
  ])
    expect(isPublicAddress(ip)).toBe(false);
});
it("connects with verified TLS, pins one lookup and supports token form bodies", async () => {
  let calls = 0;
  const fetcher = transport({}, (host, options, cb) => {
    calls++;
    expect(host).toBe("oidc.test.invalid");
    expect(options.all).toBe(true);
    cb(null, [
      { address: calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 },
    ]);
  });
  const res = await fetcher(origin + "/ok", {
    method: "POST",
    body: new URLSearchParams({ code: "synthetic" }),
    headers: { authorization: "Basic synthetic" },
  });
  expect(await res.json()).toEqual({
    body: "code=synthetic",
    authorization: "Basic synthetic",
  });
  expect(calls).toBe(1);
  await expect(fetcher(origin + "/ok")).rejects.toThrow(
    "OIDC transport request failed",
  );
});
it("rejects private DNS without an exception, mixed DNS, and lookup failures without contacting the server", async () => {
  const before = hits;
  await expect(
    transport({ privateAddresses: {} })(origin + "/ok"),
  ).rejects.toThrow();
  for (const records of [
    [],
    [
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
    [{ address: "127.0.0.1", family: 6 }],
  ])
    await expect(
      transport({}, (_h, _o, cb) => cb(null, records))(origin + "/ok"),
    ).rejects.toThrow();
  await expect(
    transport({}, (_h, _o, cb) => cb(new Error("synthetic-secret")))(
      origin + "/ok",
    ),
  ).rejects.toThrow(/^OIDC transport request failed$/);
  expect(hits).toBe(before);
});
it("rejects untrusted certificates and wrong TLS hostnames", async () => {
  await expect(transport({ ca: undefined })(origin + "/ok")).rejects.toThrow();
  const ipOrigin = origin.replace("oidc.test.invalid", "127.0.0.1");
  await expect(
    createOidcTransport({
      origins: [ipOrigin],
      privateAddresses: { [ipOrigin]: ["127.0.0.1"] },
      ca: cert,
    })(ipOrigin),
  ).rejects.toThrow();
});
it("rejects URLs and request overrides before DNS or connection", async () => {
  let calls = 0;
  const fetcher = transport({}, () => calls++);
  for (const url of [
    "http://oidc.test.invalid",
    "https://other.invalid",
    origin + "/#",
    origin + "/\nx",
    origin.replace("https://", "https://user:secret@"),
  ])
    await expect(fetcher(url)).rejects.toThrow();
  for (const init of [
    { method: "DELETE" },
    { headers: { host: "evil" } },
    { body: "secret" },
    { method: "POST", body: "x".repeat(65537) },
  ])
    await expect(fetcher(origin, init)).rejects.toThrow();
  expect(calls).toBe(0);
  const ipOrigin = "https://169.254.169.254";
  await expect(
    createOidcTransport({ origins: [ipOrigin] })(ipOrigin),
  ).rejects.toThrow();
});
it.each([
  "redirect",
  "compressed",
  "large-header",
  "large",
  "chunked",
  "truncated",
])("rejects %s responses with sanitized errors", async (route) => {
  const before = hits;
  await expect(
    transport({ maxBytes: 512 })(origin + "/" + route),
  ).rejects.toThrow(/^OIDC transport request failed$/);
  expect(hits).toBe(before + 1);
});
it("times out DNS and slow responses, supports abort and frees concurrency slots", async () => {
  await expect(
    transport({ timeoutMs: 30 }, () => {})(origin),
  ).rejects.toThrow();
  const fetcher = transport({ timeoutMs: 100, maxConcurrent: 1 });
  const pending = fetcher(origin + "/hang");
  const rejected = expect(pending).rejects.toThrow();
  await expect(fetcher(origin + "/ok")).rejects.toThrow();
  await rejected;
  expect((await fetcher(origin + "/ok")).status).toBe(200);
  const controller = new AbortController();
  const aborted = expect(
    fetcher(origin + "/hang", { signal: controller.signal }),
  ).rejects.toThrow();
  controller.abort("synthetic-secret");
  await aborted;
  await expect(
    fetcher(origin, { signal: controller.signal }),
  ).rejects.toThrow();
});
it("preserves bounded OAuth error responses for the library", async () => {
  const response = await transport()(origin + "/error");
  expect(response.status).toBe(400);
  expect(await response.json()).toHaveProperty("body");
});
it("rejects broad or dangerous private exceptions and invalid limits", () => {
  for (const address of ["10.0.0.0/8", "169.254.169.254", "0.0.0.0", "8.8.8.8"])
    expect(() =>
      transport({ privateAddresses: { [origin]: [address] } }),
    ).toThrow();
  for (const options of [
    { timeoutMs: 0 },
    { maxBytes: Infinity },
    { maxConcurrent: 0 },
    { origins: ["http://example.test"] },
    { privateAddresses: { "https://unknown": ["127.0.0.1"] } },
  ])
    expect(() => transport(options)).toThrow();
});

it("integrates with the pinned OIDC library customFetch contract", async () => {
  const client = await import("openid-client");
  const result = await client.discovery(
    new URL(origin),
    "synthetic-client",
    undefined,
    client.ClientSecretBasic("synthetic-secret"),
    { [client.customFetch]: transport() },
  );
  expect(result.serverMetadata().issuer).toBe(origin);
});
it("bounds total body time despite continuing data", async () => {
  await expect(
    transport({ timeoutMs: 60 })(origin + "/slow-body"),
  ).rejects.toThrow();
});
it("bounds outstanding DNS work after timeout and ignores late answers", async () => {
  let callback,
    calls = 0;
  const fetcher = transport(
    { timeoutMs: 30, maxConcurrent: 1 },
    (_h, _o, cb) => {
      calls++;
      callback = cb;
    },
  );
  await expect(fetcher(origin)).rejects.toThrow();
  await expect(fetcher(origin)).rejects.toThrow();
  expect(calls).toBe(1);
  const before = hits;
  callback(null, [{ address: "127.0.0.1", family: 4 }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(hits).toBe(before);
});
