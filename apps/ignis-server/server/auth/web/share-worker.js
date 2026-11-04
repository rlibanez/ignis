/* global IgnisIncoming */
importScripts('/auth/share-store.js');
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== '/share-target' || event.request.method !== 'POST') return;
  event.respondWith((async () => {
    try {
      const declared = Number(event.request.headers.get('content-length'));
      if (declared > IgnisIncoming.MAX_BYTES + 1024 * 1024) throw new Error('large');
      const form = await event.request.formData();
      const value = key => typeof form.get(key) === 'string' ? form.get(key) : '';
      const title = value('title');
      const files = form.getAll('files').filter(value => value instanceof Blob && typeof value.name === 'string' && value.name !== '');
      const text = IgnisIncoming.textContent(files.length ? '' : title, value('text'), value('url'));
      const size = files.reduce((sum, file) => sum + file.size, new Blob([text]).size);
      if (size > IgnisIncoming.MAX_BYTES || files.length > IgnisIncoming.MAX_FILES) throw new Error('large');
      if (!text && !files.length) throw new Error('empty');
      await IgnisIncoming.purge();
      let owner = null;
      try {
        const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
        if (response.ok) owner = (await response.json()).user.id;
      } catch { /* An unauthenticated share can be claimed after signing in. */ }
      const id = crypto.randomUUID();
      await IgnisIncoming.change(id, () => ({id, createdAt: Date.now(), expiresAt: IgnisIncoming.TTL ? Date.now() + IgnisIncoming.TTL : null, owner, title, text, files,
        names: files.map(file => file.name), completed: [], state: 'pending'}));
      return Response.redirect(new URL('/share-target?id=' + id, self.location.origin), 303);
    } catch (error) {
      const reason = ['large', 'empty'].includes(error.message) ? error.message : 'storage';
      return Response.redirect(new URL('/share-target?error=' + reason, self.location.origin), 303);
    }
  })());
});
