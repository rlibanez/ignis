import {it, expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto, createHash} from 'node:crypto';
const source = fs.readFileSync(new URL('./web/share-target.js', import.meta.url), 'utf8');
async function fixture({conflict = false, text = 'received\ncontent', title = 'Title', files = []} = {}) {
  class Element {
    constructor(tag = '') { this.tag = tag; this.children = []; this.value = ''; this.dataset = {}; this.textContent = ''; this.style={setProperty(){}}; this.classList={add(){},contains(){return false;}}; }
    get ownerDocument(){return document;} getRootNode(){return document;} contains(){return false;}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; if (this.id === 'vault') this.value = children[0]?.value || ''; }
    get options() { return this.children; }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll(selector) { return this.children.flatMap(c => [...((selector === '[data-path]' && c.dataset.path !== undefined && c.className === 'resource-tree-select') || (selector === 'input' && c.tag === 'input') ? [c] : []), ...c.querySelectorAll(selector)]); }
    addEventListener() {} focus() {} select() {} showModal() {} close() {}
  }
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) { const e = new Element(); e.id = id; elements.set(id, e); } return elements.get(id); };
  let stored = {text, title, files, names: files.map(file => file.name), completed: [], state: 'pending'};
  const calls = [], redirects = [], closed = [];
  const fetch = async (url, init = {}) => {
    calls.push({url, init});
    if (url === '/api/auth/session') return Response.json({sessionId: 's1', user: {id: 'alice'}});
    if (url === '/api/auth/csrf') return Response.json({csrfToken: 'csrf'});
    if (url === '/api/vault/list') return Response.json([{uuid: 'v1', name: 'Vault', membership: 'owner'}]);
    if (url.startsWith('/api/fs/tree')) return Response.json({'existing.md': {type: 'file'}});
    if (url.startsWith('/api/fs/readFile')) return new Response('original\n');
    if (url.startsWith('/api/fs/writeFile') && conflict) return Response.json({error: 'Content changed'}, {status: 409});
    return Response.json({ok: true});
  };
  const document={getElementById:$,createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>new Element(tag)};
  vm.runInNewContext(fs.readFileSync(new URL('./web/resource-tree.js',import.meta.url),'utf8')+'\n'+source, {document,
    window: {addEventListener() {}, close() { closed.push(true); }}, history: {length: 1}, setTimeout() {},
    location: {href: 'https://ignis.test/share-target?id=one', replace: url => redirects.push(url)},
    URL, URLSearchParams, Blob, TextDecoder, crypto: webcrypto, fetch,
    IgnisIncoming: {config: {}, safeName: name => !!name && !name.includes('/') && !name.startsWith('.'), purge: async () => {},
      change: async (id, fn) => { stored = fn(stored); return stored; }},
  });
  const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  await settle();
  return {$, calls, redirects, closed, settle, stored: () => stored};
}
it('appends to an existing note with concurrency protection and opens that note directly', async () => {
  const f = await fixture();
  f.$('destination-tree').querySelectorAll('[data-path]').find(e => e.dataset.path === 'existing.md').onclick();
  f.$('capture').onsubmit({preventDefault() {}}); await f.settle();
  const write = f.calls.find(c => c.url.startsWith('/api/fs/writeFile'));
  expect(await write.init.body.text()).toBe('original\n\nTitle\n\nreceived\ncontent\n');
  expect(write.init.headers['X-Ignis-Content-Version']).toBe(createHash('sha256').update('original\n').digest('hex'));
  expect(f.redirects).toEqual(['/?vault=v1&file=existing.md']);
  expect(f.stored()).toBeNull();
});
it('creates a new note without replacing an existing file and opens it', async () => {
  const f = await fixture();
  f.$('capture').onsubmit({preventDefault() {}}); await f.settle();
  const write = f.calls.find(c => c.url.startsWith('/api/fs/writeFile'));
  expect(write.init.headers['X-Ignis-Content-Version']).toBe('new');
  expect(await write.init.body.text()).toBe('received\ncontent\n');
  expect(f.redirects).toEqual(['/?vault=v1&file=Title.md']);
});
it('keeps incoming content and does not navigate when the write is rejected', async () => {
  const f = await fixture({conflict: true});
  f.$('capture').onsubmit({preventDefault() {}}); await f.settle();
  expect(f.redirects).toEqual([]); expect(f.stored().state).toBe('pending');
  expect(f.$('status').textContent).toBe('Content changed');
});
it('cancels without writing content or displaying a confirmation and requests window closure', async () => {
  const f = await fixture();
  await f.$('cancel').onclick();
  expect(f.calls.filter(c => c.init.method === 'POST')).toHaveLength(0);
  expect(f.closed).toEqual([true]); expect(f.stored()).toBeNull();
  expect(f.$('status').textContent).toBe(''); expect(f.redirects).toEqual([]);
});
it('saves and returns only after the write succeeds', async () => {
  const f = await fixture();
  f.$('capture').onsubmit({preventDefault() {}, submitter: {value: 'return'}}); await f.settle();
  expect(f.calls.filter(c => c.url.startsWith('/api/fs/writeFile'))).toHaveLength(1);
  expect(f.closed).toEqual([true]); expect(f.redirects).toEqual([]); expect(f.stored()).toBeNull();
});
it('does not close on a failed save-and-return', async () => {
  const f = await fixture({conflict: true});
  f.$('capture').onsubmit({preventDefault() {}, submitter: {value: 'return'}}); await f.settle();
  expect(f.closed).toEqual([]); expect(f.redirects).toEqual([]); expect(f.stored().state).toBe('pending');
});

it.each(['Title', 'Title\n\nhttps://example.com'])('does not duplicate a title already in incoming text: %s', async text => {
  const f = await fixture({text});
  f.$('destination-tree').querySelectorAll('[data-path]').find(e => e.dataset.path === 'existing.md').onclick();
  f.$('capture').onsubmit({preventDefault() {}}); await f.settle();
  const write = f.calls.find(c => c.url.startsWith('/api/fs/writeFile'));
  expect(await write.init.body.text()).toBe('original\n\n' + text + '\n');
});

it('does not move the destination of a partially completed share or silently skip its saved files', async () => {
  const f = await fixture();
  f.stored().completed = [0];
  f.stored().destination = {vault: 'different-vault', folder: '', note: 'Title.md'};
  f.$('capture').onsubmit({preventDefault() {}}); await f.settle();
  expect(f.calls.filter(c => c.init.method === 'POST')).toHaveLength(0);
  expect(f.redirects).toEqual([]);
  expect(f.$('status').textContent).toContain('Keep the original destination');
});

it('embeds a renamed image in a selected note after uploading it beside the note', async () => {
  const file = Object.assign(new Blob(['image bytes'], {type: 'image/jpeg'}), {name: '3937.jpg'});
  const f = await fixture({text: '', title: '3937.jpg', files: [file]});
  f.$('files').querySelectorAll('input')[0].value = 'my image (1)#.jpg';
  f.$('destination-tree').querySelectorAll('[data-path]').find(e => e.dataset.path === 'existing.md').onclick();
  f.$('capture').onsubmit({preventDefault() {}}); await f.settle();
  const writes = f.calls.filter(c => c.url.startsWith('/api/fs/writeFile'));
  expect(writes).toHaveLength(2);
  expect(new URL(writes[0].url, 'https://ignis.test').searchParams.get('path')).toBe('my image (1)#.jpg');
  expect(writes[0].init.headers['X-Ignis-Content-Version']).toBe('new');
  expect(await writes[1].init.body.text()).toBe('original\n\n![](./my%20image%20%281%29%23.jpg)\n');
  expect(writes[1].init.headers['X-Ignis-Content-Version']).toBe(createHash('sha256').update('original\n').digest('hex'));
  expect(f.redirects).toEqual(['/?vault=v1&file=existing.md']);
});
it('keeps folder-only image saves as files without creating a note', async () => {
  const file = Object.assign(new Blob(['image']), {name: 'photo.png'});
  const f = await fixture({text: '', files: [file]});
  f.$('capture').onsubmit({preventDefault() {}}); await f.settle();
  const writes = f.calls.filter(c => c.url.startsWith('/api/fs/writeFile'));
  expect(writes).toHaveLength(1);
  expect(await writes[0].init.body.text()).toBe('image');
  expect(f.redirects).toEqual(['/?vault=v1&file=photo.png']);
});
it.each([
  ['https://example.com/page?q=1', 'Shared link'],
  ['Read https://example.com', 'Shared text'],
  ['A regular note', 'Shared text'],
])('labels incoming text appropriately: %s', async (text, heading) => {
  const f = await fixture({text});
  expect(f.$('preview-heading').textContent).toBe(heading);
});
it.each([
  [['photo.jpg'], 'Shared image'],
  [['a.png', 'b.webp'], 'Shared images'],
  [['report.pdf'], 'Shared file'],
  [['photo.jpg', 'report.pdf'], 'Shared files'],
])('labels received files and explains the editable filename: %j', async (names, heading) => {
  const files = names.map(name => Object.assign(new Blob(['bytes']), {name}));
  const f = await fixture({text: '', files});
  expect(f.$('preview-heading').textContent).toBe(heading);
  expect(f.$('files').children[0].children[1].textContent).toBe('Filename when saving');
});
