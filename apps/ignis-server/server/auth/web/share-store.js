// Temporary incoming shares only; no application assets or credentials are cached.
(() => {
  const config = globalThis.__ignisIncomingConfig || {maxMiB: 32, maxFiles: 100, ttlMinutes: 60};
  const TTL = config.ttlMinutes * 60 * 1000, MAX_BYTES = config.maxMiB * 1024 * 1024, MAX_FILES = config.maxFiles;
  function expired(item, now = Date.now()) {
    // Persist deadlines at receipt so a configuration update does not revive old data.
    const deadline = Object.hasOwn(item, 'expiresAt') ? item.expiresAt : (item.createdAt + 60 * 60 * 1000);
    return deadline !== null && deadline <= now;
  }
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ignis-incoming-shares', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('shares', {keyPath: 'id'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Temporary storage unavailable.'));
    });
  }
  async function change(id, update) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('shares', 'readwrite'), store = tx.objectStore('shares');
        let result;
        const request = store.get(id);
        request.onsuccess = () => {
          try {
            const current = request.result;
            result = update(current && !expired(current) ? current : null);
            if (result) store.put(result); else store.delete(id);
          } catch (error) { reject(error); tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(new Error('Temporary storage unavailable.'));
        tx.onabort = () => reject(new Error('Temporary storage unavailable.'));
      });
    } finally { db.close(); }
  }
  async function purge() {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('shares', 'readwrite'), request = tx.objectStore('shares').openCursor();
        request.onsuccess = () => { const cursor = request.result; if (!cursor) return;
          if (expired(cursor.value)) cursor.delete(); cursor.continue(); };
        tx.oncomplete = resolve; tx.onerror = reject;
      });
    } finally { db.close(); }
  }
  async function pending(owner) {
    if (!owner) return [];
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const items = [];
        const tx = db.transaction('shares', 'readonly');
        const request = tx.objectStore('shares').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const item = cursor.value;
          if (item.owner === owner && item.state === 'pending' && !expired(item)) {
            items.push({id:item.id, title:item.title, names:item.names, createdAt:item.createdAt});
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(items.sort((a,b) => b.createdAt-a.createdAt));
        tx.onerror = () => reject(new Error('Temporary storage unavailable.'));
      });
    } finally { db.close(); }
  }
  function textContent(title, text, url) {
    // Android commonly supplies links in text rather than url. Keep that text intact.
    const parts = [text, url].filter(Boolean);
    if (parts.length === 2 && parts[0].includes(parts[1])) parts.pop();
    return parts.join('\n\n') || title;
  }
  function safeName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 240 &&
      // eslint-disable-next-line no-control-regex
      !/[\\/\u0000-\u001f\u007f]/.test(name) && !name.startsWith('.') && !/[. ]$/.test(name);
  }
  globalThis.IgnisIncoming = { TTL, MAX_BYTES, MAX_FILES, config, expired, change, purge, pending, textContent, safeName };
})();
