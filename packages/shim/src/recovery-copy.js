import { openCopyDialog } from './copy-dialog.js';

const t = key => globalThis.IgnisI18n?.t(key) ?? key;

export function recoveryClient(scope, context, request = fetch) {
  const check = () => {
    const now = context();
    if (!scope.sessionId || now?.sessionId !== scope.sessionId || now?.vault !== scope.vault) {
      throw new Error(t('Session or vault changed'));
    }
  };
  async function call(url, body) {
    check();
    const response = await request(url, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: {
        'X-Ignis-Context': scope.sessionId,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    check();
    if (!response.ok) {
      throw new Error(response.status === 409
        ? t('An item with that name already exists. Choose another name or folder.')
        : t('Unable to save the copy. Check your connection and write permission.'));
    }
    return response.json();
  }
  return {
    check,
    list: () => call('/api/vault/list'),
    tree: vault => call('/api/fs/tree?vault=' + encodeURIComponent(vault)),
    // A null version means create-only; the server rejects a concurrent collision.
    save: (vault, path, content) => call('/api/fs/writeFile?vault=' + encodeURIComponent(vault), {
      path, content, encoding: 'utf8', expectedHash: null,
    }),
  };
}

// Synthetic root paths keep identical folder names in different vaults independent.
export function recoveryFolders(vaults, trees) {
  return vaults.flatMap(vault => [
    { path: vault.uuid, name: vault.name },
    ...Object.entries(trees[vault.uuid] || {})
      .filter(([path, meta]) => meta.type === 'directory' && path &&
        !path.split('/').some(part => !part || part.startsWith('.')))
      .map(([path]) => ({ path: vault.uuid + '/' + path, name: path.split('/').pop() })),
  ]);
}

export function openRecoveryCopy(obsidian, app, event, context, onSaved) {
  const client = recoveryClient(event, context);
  openCopyDialog(obsidian, app, { path: '', name: event.path.split('/').pop() }, () => null, async (_from, to) => {
    const [vault, ...parts] = to.split('/');
    await client.save(vault, parts.join('/'), event.content);
    onSaved();
  }, {
    title: t('Save a copy'),
    submit: t('Save a copy'),
    multipleVaults: true,
    hint: t('Choose a destination and a name for your copy. Existing files will not be overwritten.'),
    load: async () => {
      const vaults = (await client.list()).filter(vault => ['owner', 'editor'].includes(vault.membership));
      if (!vaults.length) throw new Error(t('No writable vaults available. Download the note instead.'));
      const trees = {};
      await Promise.all(vaults.map(async vault => { trees[vault.uuid] = await client.tree(vault.uuid); }));
      const folders = recoveryFolders(vaults, trees).map(folder => ({ ...folder, children: [] }));
      return {
        getAllLoadedFiles: () => folders,
        getAbstractFileByPath: path => {
          const [vault, ...parts] = path.split('/');
          return Object.hasOwn(trees[vault] || {}, parts.join('/'));
        },
        displayPath: path => {
          const [vault, ...parts] = path.split('/');
          return [vaults.find(item => item.uuid === vault)?.name, ...parts].filter(Boolean).join(' / ');
        },
      };
    },
  });
}
