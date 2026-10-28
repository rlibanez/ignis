const https = require("node:https");
const dns = require("node:dns");
const { BlockList, isIP } = require("node:net");

function ranges(entries, family) {
  const list = new BlockList();
  for (const [address, prefix] of entries)
    list.addSubnet(address, prefix, family);
  return (address) => list.check(address, family);
}
const reserved4 = ranges(
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ],
  "ipv4",
);
const global6 = ranges([["2000::", 3]], "ipv6");
const reserved6 = ranges(
  [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ],
  "ipv6",
);
const private4 = ranges(
  [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["127.0.0.0", 8],
  ],
  "ipv4",
);
const private6 = ranges(
  [
    ["fc00::", 7],
    ["::1", 128],
  ],
  "ipv6",
);
function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !reserved4(address)
    : family === 6 && global6(address) && !reserved6(address);
}

// Internal customFetch adapter. No caller-supplied agents, proxies or TLS bypass.
function createOidcTransport(
  {
    origins,
    privateAddresses = {},
    ca,
    timeoutMs = 5000,
    maxBytes = 1048576,
    maxConcurrent = 16,
  },
  { lookup = dns.lookup } = {},
) {
  const invalid = () => {
    throw new Error("Invalid OIDC transport configuration");
  };
  if (!Array.isArray(origins) || !origins.length || origins.length > 16)
    invalid();
  const policies = new Map();
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      invalid();
    }
    if (url.protocol !== "https:" || url.origin !== origin) invalid();
    const allowed = new BlockList();
    const addresses = privateAddresses[origin] ?? [];
    if (!Array.isArray(addresses) || addresses.length > 32) invalid();
    for (const address of addresses) {
      const family = isIP(address);
      if (
        !(family === 4 ? private4(address) : family === 6 && private6(address))
      )
        invalid();
      allowed.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    }
    policies.set(
      origin,
      (address) =>
        isPublicAddress(address) ||
        allowed.check(address, isIP(address) === 4 ? "ipv4" : "ipv6"),
    );
  }
  for (const origin of Object.keys(privateAddresses))
    if (!policies.has(origin)) invalid();
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1048576 ||
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 64
  )
    invalid();
  let active = 0;
  let pendingDns = 0;
  return async function restrictedFetch(input, init = {}) {
    const failure = () => new Error("OIDC transport request failed");
    let url, headers, body;
    try {
      const raw = input instanceof URL ? input.href : input;
      if (typeof raw !== "string" || raw.length > 4096 || /[\s\\#]/u.test(raw))
        throw failure();
      url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !policies.has(url.origin)
      )
        throw failure();
      if (!["GET", "POST"].includes(init.method ?? "GET")) throw failure();
      if (init.body !== undefined && init.body !== null) {
        if (
          typeof init.body !== "string" &&
          !(init.body instanceof URLSearchParams)
        )
          throw failure();
        body = Buffer.from(String(init.body));
        if (body.length > 65536 || init.method !== "POST") throw failure();
      }
      headers = new Headers(init.headers);
      for (const name of [
        "host",
        "connection",
        "transfer-encoding",
        "content-length",
        "proxy-authorization",
        "upgrade",
      ])
        if (headers.has(name)) throw failure();
      headers.set("accept-encoding", "identity");
      if (body) headers.set("content-length", String(body.length));
      if (init.signal?.aborted || active >= maxConcurrent) throw failure();
    } catch {
      throw failure();
    }
    active++;
    try {
      return await new Promise((resolve, reject) => {
        let request,
          response,
          done = false;
        const finish = (error, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          init.signal?.removeEventListener("abort", abort);
          if (error) {
            response?.destroy();
            request?.destroy();
            reject(failure());
          } else resolve(value);
        };
        const abort = () => finish(true);
        const timer = setTimeout(abort, timeoutMs);
        init.signal?.addEventListener("abort", abort, { once: true });
        const permitted = policies.get(url.origin);
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        if (isIP(hostname) && !permitted(hostname)) {
          finish(true);
          return;
        }
        try {
          request = https.request(
            url,
            {
              method: init.method ?? "GET",
              headers: Object.fromEntries(headers),
              agent: false,
              autoSelectFamily: false,
              rejectUnauthorized: true,
              minVersion: "TLSv1.2",
              ca,
              maxHeaderSize: 16384,
              lookup(host, _options, callback) {
                // Native DNS cannot be cancelled; bound outstanding lookups separately.
                if (pendingDns >= maxConcurrent) {
                  callback(failure());
                  return;
                }
                pendingDns++;
                // Resolve once, validate ALL results, then pin the socket to that result.
                lookup(
                  host,
                  { all: true, verbatim: true },
                  (error, records) => {
                    pendingDns--;
                    if (
                      done ||
                      error ||
                      !Array.isArray(records) ||
                      !records.length ||
                      records.some(
                        (record) =>
                          !isIP(record.address) ||
                          record.family !== isIP(record.address) ||
                          !permitted(record.address),
                      )
                    ) {
                      callback(failure());
                      return;
                    }
                    callback(null, records[0].address, records[0].family);
                  },
                );
              },
            },
            (incoming) => {
              response = incoming;
              incoming.on("error", abort);
              if (done) {
                incoming.destroy();
                return;
              }
              const status = incoming.statusCode;
              if (
                status < 200 ||
                (status >= 300 && status < 400) ||
                (incoming.headers["content-encoding"] &&
                  incoming.headers["content-encoding"] !== "identity")
              ) {
                finish(true);
                return;
              }
              const length = incoming.headers["content-length"];
              if (
                length !== undefined &&
                (!/^\d+$/.test(length) || Number(length) > maxBytes)
              ) {
                finish(true);
                return;
              }
              const chunks = [];
              let size = 0;
              incoming.on("data", (chunk) => {
                size += chunk.length;
                if (size > maxBytes) finish(true);
                else chunks.push(chunk);
              });
              incoming.on("aborted", abort);
              incoming.on("end", () => {
                if (done) return;
                try {
                  const responseHeaders = new Headers();
                  for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                    responseHeaders.append(
                      incoming.rawHeaders[i],
                      incoming.rawHeaders[i + 1],
                    );
                  finish(
                    false,
                    new Response(
                      [204, 205].includes(status)
                        ? null
                        : Buffer.concat(chunks),
                      { status, headers: responseHeaders },
                    ),
                  );
                } catch {
                  finish(true);
                }
              });
            },
          );
          request.on("error", abort);
          request.end(body);
        } catch {
          finish(true);
        }
      });
    } finally {
      active--;
    }
  };
}
module.exports = { createOidcTransport, isPublicAddress };
