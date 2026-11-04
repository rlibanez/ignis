
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { addFullscreenMenuItem } from "./fullscreen-menu.js";
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
      addFullscreenMenuItem(this, obsidian, spanish);
      this.addItem(item => item
        .setTitle(spanish ? "Cuenta" : translateIgnis("Account"))
        .setIcon("user-round")
        .onClick(() => window.__ignisOpenAccount ? window.__ignisOpenAccount() : window.location.assign("/?manage=account")));
    }
    return original.call(this, element, ...args);
  };
  prototype.__ignisAccountMenu = true;
  window.__ignisAccountMenuAvailable = true;
}
