// Bound both browser storage and network waits. A timed-out attempt must never
// progress to a later stage, even if a non-cancellable storage call finishes late.
(function (root) {
  async function start({ clear, request, timeoutMs = 15000 }) {
    const controller = new AbortController();
    let stage = "storage", timer;
    try {
      return await Promise.race([
        (async () => {
          await clear(controller.signal);
          controller.signal.throwIfAborted();
          stage = "network";
          const response = await request(controller.signal);
          controller.signal.throwIfAborted();
          const body = await response.json();
          controller.signal.throwIfAborted();
          return { status:response.status, ok:response.ok, body };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = Object.assign(new Error("OIDC start timed out"), {code:"OIDC_START_TIMEOUT",stage});
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      // Storage errors can be DOM events, not Error objects. Do not expose them.
      if (error?.code === "OIDC_START_TIMEOUT") throw error;
      throw Object.assign(new Error("OIDC start failed"), {stage});
    } finally { clearTimeout(timer); }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { start };
  else root.ignisOidcStart = start;
})(typeof window === "undefined" ? undefined : window);
