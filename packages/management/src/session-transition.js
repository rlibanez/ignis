// A provider redirect must not carry another session's caches or editor data.
export async function clearSessionStorage(host, signal, {forSignIn=false}={}) {
  signal?.throwIfAborted();
  host.localStorage.clear();host.sessionStorage.clear();
  host.IgnisI18n?.rememberLanguage({forSignIn});
  if(host.caches)for(const key of await host.caches.keys()){
    signal?.throwIfAborted();await host.caches.delete(key);
  }
  signal?.throwIfAborted();
  if(host.indexedDB?.databases)for(const {name} of await host.indexedDB.databases()){
    signal?.throwIfAborted();
    await new Promise((resolve,reject)=>{
      const request=host.indexedDB.deleteDatabase(name);
      request.onsuccess=resolve;request.onerror=reject;request.onblocked=reject;
    });
  }
  signal?.throwIfAborted();
}
