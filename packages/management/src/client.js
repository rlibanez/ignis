// One lifetime per mounted component. No request or callback may outlive its host.
export function createManagementClient({signal, assertContext = () => {}, request = globalThis.fetch}) {
  const check = () => { signal.throwIfAborted(); assertContext(); };
  function guard(response) {
    return {
      ok: response.ok, status: response.status, headers: response.headers,
      clone: () => { check(); return guard(response.clone()); },
      json: async () => { check(); const value = await response.json(); check(); return value; },
    };
  }
  return async (url, options = {}) => {
    check();
    const response = await request(url, {...options, credentials:"same-origin", cache:"no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000), ...(options.signal ? [options.signal] : [])])});
    check();
    return guard(response);
  };
}

export function createComponentScope(root, {signal, cleanups, channels, ...options}) {
  const listen = (target, type, callback, config) => target.addEventListener(type, callback,
    {...(typeof config === "object" ? config : {capture:!!config}), signal});
  return {...options, root, window:root.ownerDocument.defaultView, location:globalThis.location,
    returnUrl:globalThis.location?.href,
    fetch:createManagementClient({signal, assertContext:options.assertContext}), listen,
    assertActive:() => {signal.throwIfAborted();options.assertContext?.();},
    onDispose:fn => cleanups.push(fn),
    channel(name) {
      signal.throwIfAborted();
      if (typeof BroadcastChannel !== "function") return null;
      const channel = new BroadcastChannel(name); channels.push(channel); return channel;
    },
  };
}
