// Use one Obsidian menu instead of the mobile adapter's native select.
import { vaultService } from "@ignis/services";
import { showVaultManager } from "./ui-registry.js";

export function installMobileVaultSwitcher(app, obsidian) {
  app.workspace.onLayoutReady(() => {
    const select = document.querySelector(".workspace-drawer-header-switcher select");
    if (!select || !obsidian?.Menu) return;
    const label = select.closest("label");
    if (!label) return;
    const manageTitle = select.querySelector('option[value="manage-vaults"]')?.textContent || "Manage vaults…";
    // Replacing the label and select removes their native activation and change
    // handlers: touch and keyboard now activate just this button's click handler.
    const button = document.createElement("button");
    button.type = "button";
    button.className = label.className;
    button.dataset.ignisAccountSwitcher = "true";
    button.setAttribute("aria-haspopup", "menu");
    button.style.cssText = "background:transparent;border:0;box-shadow:none;padding:0;height:auto;color:inherit;font:inherit;text-align:inherit";
    for (const child of label.children) {
      if (child !== select) button.append(child.cloneNode(true));
    }
    label.replaceWith(button);
    let opening = false;
    let activeMenu = null;
    button.addEventListener("click", async () => {
      if (opening || activeMenu || window.__ignisAuth?.blocked) return;
      opening = true;
      button.setAttribute("aria-busy", "true");
      let vaults;
      try {
        vaults = await vaultService.listVaults();
      } catch {
        // Keep management/account access available without showing a stale list.
        vaults = [];
      } finally {
        opening = false;
        button.removeAttribute("aria-busy");
      }
      if (!button.isConnected || window.__ignisAuth?.blocked) return;
      const menu = new obsidian.Menu();
      activeMenu = menu;
      menu.onHide(() => { activeMenu = null; button.setAttribute("aria-expanded", "false"); });
      const current = vaultService.getCurrentVaultId();
      for (const vault of vaults) {
        menu.addItem(item => item.setTitle(vault.name || vault.id)
          .setChecked(vault.id === current)
          .onClick(() => { if (vault.id !== current) vaultService.openVault(vault.id); }));
      }
      menu.addSeparator();
      menu.addItem(item => item.setTitle(manageTitle).setIcon("open-vault").onClick(showVaultManager));
      if (window.__ignisAuth) {
        const spanish = (obsidian.getLanguage?.() || document.documentElement.lang || "en").toLowerCase().startsWith("es");
        menu.addSeparator();
        menu.addItem(item => item.setTitle(spanish ? "Cuenta" : "Account").setIcon("user-round")
          .onClick(() => window.location.assign("/account")));
        menu.addItem(item => item.setTitle(spanish ? "Cerrar sesión" : "Sign out").setIcon("log-out")
          .onClick(() => window.__ignisAuth?.logout()));
      }
      const rect = button.getBoundingClientRect();
      button.setAttribute("aria-expanded", "true");
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    });
  });
}
