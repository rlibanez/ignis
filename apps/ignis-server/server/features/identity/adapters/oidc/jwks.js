// The library caches successful key sets; also bound failed refreshes and key count.
function createJwksFetch(transport, { now = Date.now } = {}) {
  let inFlight;
  let lastAttempt = -Infinity;
  return async (url, init) => {
    if (!inFlight) {
      if (now() - lastAttempt < 60000)
        throw new Error("OIDC key refresh unavailable");
      lastAttempt = now();
      inFlight = (async () => {
        try {
          const response = await transport(url, init);
          if (response.status !== 200) throw new Error();
          const body = await response.clone().arrayBuffer();
          const jwks = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
          if (
            !jwks ||
            !Array.isArray(jwks.keys) ||
            !jwks.keys.length ||
            jwks.keys.length > 32 ||
            jwks.keys.some(
              (key) =>
                !key ||
                typeof key !== "object" ||
                Array.isArray(key) ||
                "d" in key ||
                "k" in key ||
                JSON.stringify(key).length > 16384,
            )
          )
            throw new Error();
          for (const key of jwks.keys) {
            if (key.kty !== "RSA") continue;
            if (
              typeof key.n !== "string" ||
              typeof key.e !== "string" ||
              !/^[A-Za-z0-9_-]+$/.test(key.n) ||
              !/^[A-Za-z0-9_-]+$/.test(key.e)
            )
              throw new Error();
            const modulus = Buffer.from(key.n, "base64url");
            const exponent = Buffer.from(key.e, "base64url");
            if (
              modulus.length < 256 ||
              modulus.length > 1024 ||
              !exponent.length ||
              exponent.length > 8
            )
              throw new Error();
          }
          return response;
        } catch {
          throw new Error("OIDC key refresh unavailable");
        }
      })();
      // All callers get clones; never share a consumed response body.
      inFlight
        .finally(() => {
          inFlight = undefined;
        })
        .catch(() => {});
    }
    return (await inFlight).clone();
  };
}
module.exports = { createJwksFetch };
