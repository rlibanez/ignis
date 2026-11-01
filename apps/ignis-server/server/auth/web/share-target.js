/* global IgnisIncoming */
(() => {
  const $ = id => document.getElementById(id);
  const t = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
  const id = new URL(location.href).searchParams.get('id');
  let item, context, userId, tree = {}, busy = false, locked = false;
  const join = (folder, name) => folder ? folder + '/' + name : name;
  const parent = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const contentPath = path => path.split('/').every(part => IgnisIncoming.safeName(part));
  const option = (value, label) => { const el = document.createElement('option'); el.value = value; el.textContent = label; return el; };
  function status(message) { $('status').textContent = t(message); }
  function lock() {
    locked = true; $('resource-dialog').close(); $('resource-name').value = ''; $('capture').hidden = true; $('signin').hidden = false; $('preview').textContent = ''; $('files').replaceChildren();
    status('Your session has ended or changed. Return to this page after signing in with the same account.');
  }
  async function session() {
    const response = await fetch('/api/auth/session', {cache: 'no-store', credentials: 'same-origin'});
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(t('Unable to check your session.'));
    return response.json();
  }
  async function api(path, body, extraHeaders = {}) {
    if (locked) throw new Error(t('Session locked'));
    const headers = {'X-Ignis-Context': context, ...extraHeaders};
    const binary = body instanceof Blob;
    if (body) {
      const current = await session();
      if (current?.sessionId !== context) { lock(); throw new Error(t('Session locked')); }
      const response = await fetch('/api/auth/csrf', {cache: 'no-store', credentials: 'same-origin', headers});
      if (!response.ok) throw new Error(t('Unable to check your session.'));
      headers['X-Ignis-Csrf'] = (await response.json()).csrfToken;
      headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
    }
    let response;
    try {
      response = await fetch(path, {method: body ? 'POST' : 'GET', headers, credentials: 'same-origin', cache: 'no-store', ...(body ? {body: binary ? body : JSON.stringify(body)} : {})});
    } catch { throw Object.assign(new Error(t('The save could not be confirmed. Check the destination in Ignis before sharing again.')), {uncertain: !!body}); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || data.code === 'AUTH_CONTEXT_CHANGED') lock();
      throw Object.assign(new Error(t(data.error || 'Request failed')), {uncertain: !!body && response.status >= 500});
    }
    return response;
  }
  const vault = () => $('vault').value;
  async function run(action) {
    if (busy || locked) return;
    busy = true; $('fields').disabled = true;
    try { await action(); } catch (error) { status(error.message); }
    finally { busy = false; $('fields').disabled = locked; }
  }
  function selectDestination(path, isNote = false) {
    $('folder').value = isNote ? parent(path) : path;
    $('note').value = isNote ? path : '';
    $('destination').textContent = (isNote ? t('Note') : t('Folder')) + ': ' + (path || t('Vault root'));
    for (const button of $('destination-tree').querySelectorAll('[data-path]'))
      button.setAttribute('aria-pressed', String(button.dataset.path === path));
  }
  function renderTree() {
    const query = $('destination-search').value.trim().toLocaleLowerCase();
    const entries = Object.entries(tree).filter(([path, entry]) => contentPath(path) &&
      (entry.type === 'directory' || (entry.type === 'file' && /\.(md|markdown|txt)$/i.test(path))));
    const visible = entries.filter(([path]) => !query || path.toLocaleLowerCase().includes(query));
    const included = new Set();
    for (const [path] of visible) { let p = path; while (p) { included.add(p); p = parent(p); } }
    function button(path, note) {
      const el = document.createElement('button'); el.type = 'button'; el.className = 'destination-choice';
      el.textContent = (note ? '📄 ' : '📁 ') + (path ? path.split('/').pop() : t('Vault root'));
      el.dataset.path = path; el.setAttribute('aria-pressed', String(path === ($('note').value || $('folder').value)));
      el.onclick = () => selectDestination(path, note); return el;
    }
    function children(container, folder) {
      for (const [path, entry] of entries.filter(([p]) => parent(p) === folder && included.has(p))
        .sort(([a, x], [b, y]) => Number(y.type === 'directory') - Number(x.type === 'directory') || a.localeCompare(b))) {
        if (entry.type === 'directory') {
          const branch = document.createElement('details'), row = document.createElement('summary');
          branch.open = !!query || ($('folder').value + '/').startsWith(path + '/');
          row.append(button(path, false)); branch.append(row);
          const nested = document.createElement('div'); nested.className = 'destination-children'; children(nested, path);
          branch.append(nested); container.append(branch);
        } else { const row = document.createElement('div'); row.className = 'destination-file'; row.append(button(path, true)); container.append(row); }
      }
    }
    const root = document.createElement('div'); root.append(button('', false)); children(root, '');
    $('destination-tree').replaceChildren(root);
  }
  async function folders(selected = '') {
    tree = await (await api('/api/fs/tree?vault=' + encodeURIComponent(vault()))).json();
    selectDestination(selected); renderTree();
  }
  function renderFiles() {
    $('files').replaceChildren(...item.files.map((file, index) => {
      const label = document.createElement('label');
      label.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KiB)` + (item.completed.includes(index) ? ' — ' + t('Saved') : '');
      const input = document.createElement('input'); input.value = item.names[index]; input.maxLength = 240;
      input.dataset.index = String(index); input.autocomplete = 'off';
      input.setAttribute('aria-label', t('Destination filename') + ': ' + file.name);
      input.disabled = item.completed.includes(index); label.append(input); return label;
    }));
  }
  async function start() {
    const {maxMiB, maxFiles} = IgnisIncoming.config;
    const error = new URL(location.href).searchParams.get('error');
    if (error || !id) {
      status(error === 'large' ? t('The shared content exceeds {p0} MiB or {p1} files. Share fewer or smaller files.', {p0: maxMiB, p1: maxFiles}) : error === 'empty' ? 'No shared content was received.' : error === 'storage' ? 'Temporary storage unavailable. Share the content again.' : 'Share content to Ignis from another application.');
      return;
    }
    await IgnisIncoming.purge();
    const current = await session();
    if (!current) { $('signin').hidden = false; return; }
    if (context && context !== current.sessionId) { lock(); return; }
    context = current.sessionId; userId = current.user.id;
    globalThis.IgnisI18n?.useAccount(userId);
    item = await IgnisIncoming.change(id, existing => {
      if (!existing) throw new Error(t('This share has expired or was already saved or cancelled.'));
      if (existing.owner && existing.owner !== userId) throw new Error(t('Sign in with the account that started saving this content.'));
      return {...existing, owner: userId};
    });
    $('signin').hidden = true;
    if (item.state !== 'pending') { status('The save could not be confirmed. Check the destination in Ignis before sharing again.'); return; }
    $('preview').textContent = item.text; $('preview').hidden = !item.text;
    // eslint-disable-next-line no-control-regex
    const title = (item.title || '').replace(/[\\/\u0000-\u001f\u007f]/g, ' ').replace(/^\.+|[. ]+$/g, '').slice(0, 220).trim();
    $('note-name').value = (title || t('Shared note')) + '.md';
    renderFiles();
    const vaults = await (await api('/api/vault/list')).json();
    $('vault').replaceChildren(...vaults.filter(v => v.uuid && ['owner', 'editor'].includes(v.membership)).map(v => option(v.uuid, v.name)));
    if (!$('vault').options.length) { status('No writable vaults are available.'); return; }
    await folders(); $('capture').hidden = false;
    status('');
  }
  $('vault').onchange = () => { $('note').value = ''; void run(() => folders()); };
  $('destination-search').oninput = renderTree;
  let creating = null, creatingBusy = false;
  function openCreate(kind) {
    if (busy || locked) return;
    creating = {kind, vault: vault(), folder: $('folder').value};
    $('resource-title').textContent = t(kind === 'folder' ? 'New folder' : 'New note');
    $('resource-name').value = kind === 'note' ? $('note-name').value : '';
    $('resource-error').textContent = '';
    $('resource-dialog').showModal(); $('resource-name').focus(); $('resource-name').select();
  }
  $('mkdir').onclick = () => openCreate('folder');
  $('choose-new-note').onclick = () => openCreate('note');
  $('retry').onclick = () => { if (locked) location.reload(); else void run(start); };
  $('resource-cancel').onclick = () => { if (!creatingBusy) $('resource-dialog').close(); };
  $('resource-dialog').addEventListener('cancel', event => { if (creatingBusy) event.preventDefault(); });
  $('resource-form').onsubmit = event => {
    event.preventDefault();
    if (busy || locked || creatingBusy || !creating) return;
    const target = creating;
    void run(async () => {
      creatingBusy = true;
      $('resource-create').disabled = $('resource-cancel').disabled = true;
      try {
        if (target.vault !== vault()) throw new Error(t('Request failed'));
        let name = $('resource-name').value.trim();
        if (!IgnisIncoming.safeName(name)) throw new Error(t('Enter a valid name without slashes or hidden path segments.'));
        if (target.kind === 'note' && !/\.(md|markdown|txt)$/i.test(name)) name += '.md';
        if (!IgnisIncoming.safeName(name)) throw new Error(t('Enter a valid name without slashes or hidden path segments.'));
        const path = join(target.folder, name);
        if (target.kind === 'folder') await api('/api/fs/mkdir', {vault: target.vault, path, recursive: false});
        else await write(path, '', null);
        await folders(target.kind === 'folder' ? path : target.folder);
        if (target.kind === 'note') { selectDestination(path, true); renderTree(); }
        $('resource-dialog').close(); status('');
      } catch (error) { $('resource-error').textContent = error.message; }
      finally { creatingBusy = false; $('resource-create').disabled = $('resource-cancel').disabled = false; }
    });
  };
  async function update(change) {
    item = await IgnisIncoming.change(id, existing => {
      if (!existing || existing.owner !== userId) throw new Error(t('This share has expired or was already saved or cancelled.'));
      return change(existing);
    });
  }
  async function write(path, content, expectedHash) {
    const query = new URLSearchParams({vault: vault(), path});
    await api('/api/fs/writeFile?' + query, content instanceof Blob ? content : new Blob([content]),
      {'X-Ignis-Content-Version': expectedHash === null ? 'new' : expectedHash});
  }
  $('capture').onsubmit = event => {
    event.preventDefault();
    const returnAfterSaving = event.submitter?.value === 'return';
    run(async () => {
    const names = [...$('files').querySelectorAll('input')].map(el => el.value);
    if (names.some(name => !IgnisIncoming.safeName(name)) || new Set(names).size !== names.length)
      throw new Error(t('Use a different valid name for each file.'));
    let notePath = $('note').value;
    if (item.text && !notePath) {
      let name = $('note-name').value.trim();
      if (!/\.(md|markdown|txt)$/i.test(name)) name += '.md';
      if (!IgnisIncoming.safeName(name)) throw new Error(t('Enter a valid name without slashes or hidden path segments.'));
      notePath = join($('folder').value, name);
    }
    if (item.text && names.some(name => join($('folder').value, name) === notePath))
      throw new Error(t('Use a different valid name for each file.'));
    await update(existing => {
      if (existing.state !== 'pending') throw new Error(t('This content is already being saved.'));
      if (existing.completed.length && (existing.destination?.vault !== vault() ||
          existing.destination?.folder !== $('folder').value || existing.destination?.note !== notePath ||
          existing.completed.some(index => typeof index === 'number' && existing.names[index] !== names[index])))
        throw new Error(t('Some files are already saved. Keep the original destination to finish this share.'));
      return {...existing, names, state: 'saving', destination: {vault: vault(), folder: $('folder').value, note: notePath}};
    });
    let unrecordedWrite = false;
    try {
      for (let index = 0; index < item.files.length; index++) {
        if (item.completed.includes(index)) continue;
        const file = item.files[index];
        await write(join($('folder').value, names[index]), file, null);
        unrecordedWrite = true;
        await update(existing => ({...existing, completed: [...existing.completed, index]}));
        unrecordedWrite = false;
      }
      if (item.text && !item.completed.includes('text')) {
        let content = item.text + '\n', expected = null;
        if ($('note').value) {
          // A selected note keeps its own filename, so preserve the incoming title
          // in the appended text instead. Avoid repeating titles already supplied.
          const title = (item.title || '').trim();
          if (title && !item.text.split(/\r?\n/).some(line => line.trim() === title))
            content = title + '\n\n' + content;
          const bytes = await (await api('/api/fs/readFile?vault=' + encodeURIComponent(vault()) + '&path=' + encodeURIComponent(notePath))).arrayBuffer();
          expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
          const original = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
          content = original + (original ? (original.endsWith('\n') ? '\n' : '\n\n') : '') + content;
        }
        await write(notePath, content, expected);
        unrecordedWrite = true;
        await update(existing => ({...existing, completed: [...existing.completed, 'text']}));
        unrecordedWrite = false;
      }
      const destination = new URLSearchParams({vault: vault()});
      const savedPath = item.text ? notePath : item.files.length ? join($('folder').value, names[0]) : '';
      if (savedPath) destination.set('file', savedPath);
      await IgnisIncoming.change(id, () => null);
      const savedUrl = '/?' + destination;
      $('capture').hidden = true; $('preview').textContent = ''; $('files').replaceChildren();
      if (returnAfterSaving) closeShare();
      else location.replace(savedUrl);
    } catch (error) {
      // A lost response can follow a successful write. Never automatically append twice.
      error.uncertain ||= unrecordedWrite;
      if (error.uncertain) $('save-open').disabled = $('save-return').disabled = true;
      await update(existing => ({...existing, state: error.uncertain ? 'uncertain' : 'pending'}));
      if (!locked) renderFiles();
      if (error.uncertain) { $('save-open').disabled = $('save-return').disabled = true; status('The save could not be confirmed. Check the destination in Ignis before sharing again.'); }
      else throw error;
    }
  }); };
  function closeShare() {
    window.close();
    // Android normally closes a share-target window. A browser tab may refuse;
    // in that case return through its history without another confirmation page.
    setTimeout(() => { if (!window.closed && history.length > 1) history.back(); }, 150);
  }
  $('cancel').onclick = () => run(async () => {
    await IgnisIncoming.change(id, existing => {
      if (existing?.state === 'saving') throw new Error(t('This content is already being saved.'));
      if (existing?.owner && existing.owner !== userId) throw new Error(t('Session locked'));
      return null;
    });
    $('capture').hidden = true; $('preview').textContent = ''; $('files').replaceChildren(); status('');
    closeShare();
  });
  window.addEventListener('focus', () => { if (context) session().then(current => { if (current?.sessionId !== context) lock(); }).catch(() => {}); });
  if (typeof BroadcastChannel === 'function') { const channel = new BroadcastChannel('ignis-auth'); channel.onmessage = () => { if (context) lock(); }; }
  window.addEventListener('pagehide', () => { document.body.style.visibility = 'hidden'; });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  void run(start);
})();
