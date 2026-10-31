// Installation only: no service worker, offline cache or credential persistence.
(() => {
  let pending = null, busy = false;
  const standalone = window.matchMedia('(display-mode: standalone)');
  const installed = () => standalone.matches || window.navigator.standalone === true;
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
  document.addEventListener('click', async event => {
    if (!event.target.closest('[data-install-ignis]') || !pending || busy) return;
    const prompt = pending; pending = null; busy = true; update();
    try { await prompt.prompt(); await prompt.userChoice; }
    catch { /* Browser installation remains available through its own menu. */ }
    finally { busy = false; update(); }
  });
  update();
})();
