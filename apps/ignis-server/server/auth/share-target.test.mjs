import {it, expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source = name => fs.readFileSync(new URL('./web/' + name, import.meta.url), 'utf8');
function helpers(config) {const context = {__ignisIncomingConfig: config}; vm.runInNewContext(source('share-store.js'), context); return context.IgnisIncoming;}
it('keeps Android text links intact and does not duplicate a URL supplied twice', () => {
  const store = helpers();
  expect(store.textContent('Title', 'Read https://example.com', 'https://example.com')).toBe('Read https://example.com');
  expect(store.textContent('Title', 'Description', 'https://example.com')).toBe('Description\n\nhttps://example.com');
  expect(store.textContent('Only title', '', '')).toBe('Only title');
  for (const name of ['../note.md', '.obsidian', 'a/b', 'a\\b', 'trailing.', 'name\u0000', '']) expect(store.safeName(name), name).toBe(false);
  for (const name of ['nota.md', 'foto.png', 'document.pdf', 'mis notas', 'archivo.sinextension']) expect(store.safeName(name), name).toBe(true);
});
function worker({authenticated = true, storageFails = false, config} = {}) {
  const handlers = {}, stored = new Map(), policy = helpers(config);
  const context = {Blob, URL, Response, crypto: webcrypto, importScripts() {},
    fetch: async () => authenticated ? Response.json({user: {id: 'alice'}}) : new Response('', {status: 401}),
    IgnisIncoming: {...policy, purge: async () => {}, change: async (id, update) => {
      if (storageFails) throw new Error('quota'); stored.set(id, update(stored.get(id)));
    }},
    self: {location: {origin: 'https://ignis.example'}, addEventListener: (name, handler) => {handlers[name] = handler;}}};
  vm.runInNewContext(source('share-worker.js'), context);
  async function share(form, options = {}) {
    let response;
    handlers.fetch({request: {url: options.url || 'https://ignis.example/share-target', method: options.method || 'POST', headers: new Headers(options.headers), formData: async () => form}, respondWith: value => {response = value;}});
    return response ? await response : null;
  }
  return {share, stored};
}
it('receives all file types locally and binds an authenticated share to its account', async () => {
  const {share, stored} = worker(); const form = new FormData();
  form.set('text', 'https://example.com'); form.append('files', new Blob(['PDF bytes'], {type: 'application/pdf'}), 'document.pdf');
  form.append('files', new Blob(['unknown']), 'arbitrary.custom');
  const response = await share(form); expect(response.status).toBe(303);
  const id = new URL(response.headers.get('location')).searchParams.get('id');
  const item = stored.get(id);
  expect(item.owner).toBe('alice'); expect(item.text).toBe('https://example.com');
  expect(item.names).toEqual(['document.pdf', 'arbitrary.custom']); expect(await item.files[1].text()).toBe('unknown');
});
it('does not turn a file-only share title into an unwanted note', async () => {
  const {share, stored} = worker({authenticated: false}); const form = new FormData(); form.set('title', 'photo.png'); form.append('files', new Blob(['image']), 'photo.png');
  await share(form); expect([...stored.values()][0]).toMatchObject({owner: null, text: '', state: 'pending'});
});
it('reports empty, oversized, excessive and unavailable-storage shares without registering them', async () => {
  const {share, stored} = worker();
  expect((await share(new FormData())).headers.get('location')).toContain('error=empty');
  expect((await share(new FormData(), {headers: {'content-length': String(34 * 1024 * 1024)}})).headers.get('location')).toContain('error=large');
  const files = new FormData(); for (let i = 0; i < 101; i++) files.append('files', new Blob(['x']), i + '.txt');
  expect((await share(files)).headers.get('location')).toContain('error=large'); expect(stored.size).toBe(0);
  const form = new FormData(); form.set('text', 'preserve me');
  expect((await worker({storageFails: true}).share(form)).headers.get('location')).toContain('error=storage');
});
it('leaves all normal browsing, API calls and other origins to the network', async () => {
  const {share} = worker();
  expect(await share(new FormData(), {method: 'GET'})).toBeNull();
  expect(await share(new FormData(), {url: 'https://ignis.example/api/fs/writeFile'})).toBeNull();
  expect(await share(new FormData(), {url: 'https://external.example/share-target'})).toBeNull();
});
it('declares a multipart share target accepting text, links and arbitrary files', () => {
  expect(JSON.parse(source('manifest.webmanifest')).share_target).toEqual({action: '/share-target', method: 'POST', enctype: 'multipart/form-data', params: {title: 'title', text: 'text', url: 'url', files: [{name: 'files', accept: ['*/*']}]}});
});

it('ignores an empty file input while preserving actual zero-byte files', async () => {
  const {share, stored} = worker(); const form = new FormData(); form.set('text', 'Just text');
  form.append('files', new Blob([]), ''); form.append('files', new Blob([]), 'empty.txt');
  await share(form); expect([...stored.values()][0].names).toEqual(['empty.txt']);
});

it('enforces configured counts and records disabled or finite expiry at receipt', async () => {
  const form = new FormData(); form.append('files', new Blob(['a']), 'a'); form.append('files', new Blob(['b']), 'b');
  const restricted = worker({config:{maxMiB:1,maxFiles:1,ttlMinutes:0}});
  expect((await restricted.share(form)).headers.get('location')).toContain('error=large');
  form.delete('files'); form.set('text', 'capture');
  await restricted.share(form); expect([...restricted.stored.values()][0].expiresAt).toBeNull();
  const finite = worker({config:{maxMiB:1,maxFiles:3,ttlMinutes:5}});
  await finite.share(form); const item = [...finite.stored.values()][0];
  expect(item.expiresAt-item.createdAt).toBeGreaterThanOrEqual(300000);
  const large = new FormData(); large.append('files', new Blob([new Uint8Array(1024*1024+1)]), 'large.bin');
  expect((await finite.share(large)).headers.get('location')).toContain('error=large');
});
