// Namespacing prevents accidental reuse by Obsidian; it is not a sandbox for
// untrusted same-origin scripts. Do not import legacy unscoped values.
export function scopedStorage(storage, account, currentAccount) {
  const prefix = "ignis-account-v1:" + encodeURIComponent(account) + ":";
  function check() {
    if (!account || currentAccount() !== account) throw new Error("Account storage unavailable");
  }
  function keys() {
    check();
    const result = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) result.push(key.slice(prefix.length));
    }
    return result;
  }
  const methods = {
    getItem(key) { check(); return storage.getItem(prefix + String(key)); },
    setItem(key, value) { check(); storage.setItem(prefix + String(key), String(value)); },
    removeItem(key) { check(); storage.removeItem(prefix + String(key)); },
    clear() { for (const key of keys()) storage.removeItem(prefix + key); },
    key(index) { return keys()[Number(index)] ?? null; },
  };
  return new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === "length") return keys().length;
      if (Object.hasOwn(methods, key)) return methods[key];
      if (typeof key === "symbol") return undefined;
      return methods.getItem(key) ?? undefined;
    },
    set(_target, key, value) { methods.setItem(key, value); return true; },
    deleteProperty(_target, key) { methods.removeItem(key); return true; },
    ownKeys: keys,
    has(_target, key) { return Object.hasOwn(methods, key) || keys().includes(key); },
    getOwnPropertyDescriptor(_target, key) {
      if (keys().includes(key)) return { configurable: true, enumerable: true, writable: true, value: methods.getItem(key) };
    },
  });
}

export function installAccountStorage(host = window) {
  const account = host.__ignisAuth?.userId;
  if (!account || host.__ignisAuth.blocked) throw new Error("Authenticated browser identity required");
  const current = () => host.__ignisAuth?.blocked ? null : host.__ignisAuth?.userId;
  for (const name of ["localStorage", "sessionStorage"]) {
    const storage = scopedStorage(host[name], account, current);
    Object.defineProperty(host, name, { configurable: true, get: () => storage });
  }
}
