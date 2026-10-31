// Extend only the desktop vault switcher's menu, using Obsidian's own items.
export function installVaultAccountMenu(obsidian) {
  const prototype = obsidian?.Menu?.prototype;
  if (!prototype?.setParentElement || prototype.__ignisAccountMenu) return;
  const original = prototype.setParentElement;
  const decorated = new WeakSet();
  prototype.setParentElement = function (element, ...args) {
    if (element?.classList?.contains("workspace-drawer-vault-switcher") &&
        window.__ignisAuth && !decorated.has(this)) {
      decorated.add(this);
      const spanish = (obsidian.getLanguage?.() || document.documentElement.lang || "en").toLowerCase().startsWith("es");
      this.addSeparator();
      this.addItem(item => item
        .setTitle(spanish ? "Cuenta" : "Account")
        .setIcon("user-round")
        .onClick(() => window.location.assign("/account")));
      this.addItem(item => item
        .setTitle(spanish ? "Cerrar sesión" : "Sign out")
        .setIcon("log-out")
        .onClick(() => window.__ignisAuth?.logout()));
    }
    return original.call(this, element, ...args);
  };
  prototype.__ignisAccountMenu = true;
  window.__ignisAccountMenuAvailable = true;
}
