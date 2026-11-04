// Browser appearance, installation and incoming shares; no offline asset cache.
(() => {
  if (window.isSecureContext && 'serviceWorker' in window.navigator) {
    window.navigator.serviceWorker.register('/share-worker.js', {scope: '/', updateViaCache: 'none'})
      .catch(() => { /* Installation UI remains available; receiving shares requires this worker. */ });
  }
  // Keep browser/system chrome in step with the current page or vault theme.
  // Android may still apply its own contrast scrim to system navigation bars.
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const syncTheme = () => {
    const body = document.body;
    if (!body || !themeMeta) return;
    const style = window.getComputedStyle(body);
    const color = style.backgroundColor;
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') {
      if (themeMeta.content !== color) themeMeta.content = color;
      themeMeta.removeAttribute('media');
      // Edge-to-edge browsers may paint the root canvas behind system bars.
      const rootStyle = document.documentElement.style;
      if (rootStyle.backgroundColor !== color) rootStyle.backgroundColor = color;
    }
    // Obsidian selects its theme independently of the OS preference.
    const scheme = body.classList.contains('theme-dark') ? 'dark'
      : body.classList.contains('theme-light') ? 'light' : '';
    if (document.documentElement.style.colorScheme !== scheme)
      document.documentElement.style.colorScheme = scheme;
  };
  let themeFrame = null;
  const scheduleTheme = () => {
    if (themeFrame !== null) return;
    themeFrame = window.requestAnimationFrame(() => { themeFrame = null; syncTheme(); });
  };
  const themeObserver = new MutationObserver(scheduleTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  // Theme stylesheets can load or be replaced without changing the body class.
  themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  document.addEventListener('load', scheduleTheme, true);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleTheme);
  window.addEventListener('pageshow', scheduleTheme);
  syncTheme();

  let pending = null, busy = false;
  const standalone = window.matchMedia('(display-mode: standalone)');
  const fullscreen = window.matchMedia('(display-mode: fullscreen)');
  const installed = () => standalone.matches || fullscreen.matches || window.navigator.standalone === true;
  const update = () => {
    for (const button of document.querySelectorAll('[data-install-ignis]')) {
      button.hidden = !pending || installed(); button.disabled = busy;
    }
  };
  window.addEventListener('beforeinstallprompt', event => {
    if (!window.isSecureContext || installed()) return;
    event.preventDefault(); pending = event; update();
  });
  window.addEventListener('appinstalled', () => { pending = null; update(); });
  standalone.addEventListener('change', update);
  fullscreen.addEventListener('change', update);
  document.addEventListener('click', async event => {
    if (!event.target.closest('[data-install-ignis]') || !pending || busy) return;
    const prompt = pending; pending = null; busy = true; update();
    try { await prompt.prompt(); await prompt.userChoice; }
    catch { /* Browser installation remains available through its own menu. */ }
    finally { busy = false; update(); }
  });
  update();
})();
