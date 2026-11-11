import {appendUiControl, nativeComponent, setUiOptions} from "./ui-controls.js";
import {installUiLayout} from "./ui-layout.js";

const t = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace("{p0}", values.p0 ?? "");

export function hasMobileDeviceSettings() {
  return window.__ignisAndroidDeviceActions === true || !!globalThis.IgnisUiEnvironment?.hasWebDeviceSettings(window);
}

export function hasDeviceSettings() {
  return !!globalThis.IgnisUiEnvironment;
}

export function deviceSettings(Modal, app) {
  class PendingModal extends Modal {
    onOpen() {
      installUiLayout(document);
      this.modalEl.classList.add("mod-lg", "mod-form", "ignis-ui-form");
      this.setTitle(t("Pending shares"));
      const owner = window.__ignisAuth?.userId;
      const session = window.__ignisAuth?.sessionId;
      const active = () => this.modalEl.isConnected && owner && session &&
        window.__ignisAuth?.userId === owner && window.__ignisAuth?.sessionId === session;
      this.lost = () => this.close();
      window.addEventListener("ignis:auth-lost", this.lost);
      const list = this.contentEl.createDiv();
      const status = this.contentEl.createEl("p", {attr:{role:"status"}});
      const render = async () => {
        try {
          const entries = await globalThis.IgnisIncoming.pending(owner);
          if (!active()) return;
          list.replaceChildren();
          status.textContent = entries.length ? "" : t("No pending shares.");
          for (const entry of entries) {
            list.createEl("p", {text:entry.title || entry.names?.[0] ||
              new Date(entry.createdAt).toLocaleString()});
            const actions = list.createDiv({cls:"ignis-ui-actions"});
            appendUiControl(actions,"button",{text:t("Discard")}).onclick = async event => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                await globalThis.IgnisIncoming.change(entry.id, current =>
                  active() && current?.owner === owner && current.state === "pending" ? null : current);
                await render();
              } catch {
                if (active()) status.textContent = t("Request failed");
              } finally { button.disabled = false; }
            };
            appendUiControl(actions,"button",{text:t("Open"),cls:"mod-cta"}).onclick = () => {
              if (active()) location.assign("/share-target?id=" + encodeURIComponent(entry.id));
            };
          }
        } catch {
          if (active()) status.textContent = t("Request failed");
        }
      };
      void render();
      const footer = this.contentEl.createDiv({cls:"ignis-ui-actions"});
      appendUiControl(footer,"button",{text:t("Close")}).onclick = () => this.close();
    }
    onClose() { window.removeEventListener("ignis:auth-lost", this.lost); }
  }

  class ModeErrorModal extends Modal {
    onOpen() {
      this.modalEl.classList.add("mod-lg", "mod-form", "ignis-ui-form");
      this.setTitle(t("Interface mode"));
      this.contentEl.createEl("p", {text:t("Request failed")});
      const actions = this.contentEl.createDiv({cls:"ignis-ui-actions"});
      appendUiControl(actions, "button", {text:t("Close")}).onclick = () => this.close();
    }
  }

  installUiLayout(document);
  const android = window.__ignisAndroidDeviceActions === true;
  const action = (name, label, path) => ({name:t(name), searchable:false, render(row) {
    const link = document.createElement("a");
    link.className = "ignis-device-action";
    link.href = "/__ignis_android/action/" + path;
    link.textContent = t(label);
    row.controlEl.append(link);
  }});
  const items = android ? [
    action("Server configuration","Configure","settings"),
    action("Pending shares","Open","pending"),
    action("App lock","Configure","lock-settings"),
    action("Lock now","Lock","lock-now"),
  ] : hasMobileDeviceSettings() ? [{name:t("Pending shares"),searchable:false,render(row) {
    row.addButton(button => button.setButtonText(t("Open")).onClick(() => new PendingModal(app).open()));
  }}] : [];
  if (hasMobileDeviceSettings()) items.push({name:t("Interface mode"),searchable:false,render(row) {
    const environment = globalThis.IgnisUiEnvironment;
    const options = [
      {value:"auto",label:t("Automatic")}, {value:"phone",label:t("Phone")},
      {value:"tablet",label:t("Tablet")}, {value:"desktop",label:t("Desktop")},
    ];
    const current = () => {
      const value = android ? window.__ignisAndroidInterfaceMode : environment.webPreference(window);
      return options.some(option => option.value === value) ? value : "auto";
    };
    const select = appendUiControl(row.controlEl,"select",{cls:"dropdown",attr:{"aria-label":t("Interface mode")}});
    const dropdown = nativeComponent(select);
    setUiOptions(select, options);
    const showCurrent = () => {
      if (dropdown) dropdown.setValue(current());
      else select.value = current();
    };
    showCurrent();
    select.onchange = async () => {
      const mode = select.value;
      if (mode === current()) return;
      select.disabled = true;
      try {
        const dialogs = window.__ignisAndroidDialogs;
        const title = t("Apply interface mode?");
        const message = t("Save changes before reloading Ignis.");
        const accept = t("Apply and reload");
        const confirmed = android ? await dialogs.confirm({title,message,accept}) :
          await new Promise(resolve => {
            let accepted = false;
            class ReloadModal extends Modal {
              onOpen() {
                this.modalEl.classList.add("mod-lg","mod-form","ignis-ui-form");
                this.setTitle(title);
                this.contentEl.createEl("p",{text:message});
                const actions = this.contentEl.createDiv({cls:"ignis-ui-actions"});
                appendUiControl(actions,"button",{text:t("Cancel")}).onclick = () => this.close();
                appendUiControl(actions,"button",{text:accept,cls:"mod-cta"}).onclick = () => {
                  accepted = true;
                  this.close();
                };
                this.lost = () => this.close();
                window.addEventListener("ignis:auth-lost",this.lost);
              }
              onClose() {
                window.removeEventListener("ignis:auth-lost",this.lost);
                resolve(accepted);
              }
            }
            new ReloadModal(app).open();
          });
        if (!confirmed) return;
        if (!android) {
          if (!environment.setWebPreference(mode)) throw new Error("Could not store interface mode");
          location.reload();
          return;
        }
        const response = JSON.parse(window.prompt("IgnisAndroid:interface-apply",JSON.stringify({mode})) || "null");
        if (response?.ok) window.__ignisAndroidInterfaceMode = response.mode;
        else dialogs.message(t("Interface mode"),response?.error || t("Request failed"));
      } catch {
        if (android) window.__ignisAndroidDialogs?.message(t("Interface mode"),t("Request failed"));
        else new ModeErrorModal(app).open();
      } finally {
        select.disabled = false;
        showCurrent();
      }
    };
  }});
  items.push({name:t("Ignis screen theme"),searchable:false,render(row) {
    row.setDesc(t("Color mode for Ignis screens"));
    const environment = globalThis.IgnisUiEnvironment;
    const select = appendUiControl(row.controlEl,"select",{cls:"dropdown",attr:{"aria-label":t("Ignis screen theme")}});
    const dropdown = nativeComponent(select);
    setUiOptions(select,[
      {value:"dark",label:t("Dark")},
      {value:"light",label:t("Light")},
      {value:"system",label:t("Automatic")},
    ]);
    const refresh = () => {
      const value = environment.themePreference(window);
      if (dropdown) dropdown.setValue(value);
      else select.value = value;
    };
    refresh();
    select.onchange = () => {
      const saved = environment.setTheme(window,select.value);
      row.setDesc(t(saved ? "Color mode for Ignis screens" : "Request failed"));
      if (saved && !window.app?.workspace) environment.applyTheme(window);
      refresh();
    };
  }});
  if (android && typeof window.__ignisAndroidAppVersion === "string") {
    items.push({name:t("Ignis for Android"),searchable:false,render(row) {
      const installed = t("Installed version {p0}", {p0:window.__ignisAndroidAppVersion});
      const describe = message => row.setDesc(message ? installed + ". " + message : installed);
      const refresh = () => {
        try {
          const status = JSON.parse(window.prompt("IgnisAndroid:app-update", "{}") || "null");
          if (!status || status.failed) {
            describe(t("Could not check for updates."));
          } else if (status.checking) {
            describe(t("Checking for updates…"));
            window.addEventListener("ignis:android-update", () => {
              if (row.settingEl.isConnected) refresh();
            }, {once:true});
          } else if (status.available) {
            describe(t("Update {p0} available.", {p0:status.available}));
            if (status.release) {
              const link = document.createElement("a");
              link.className = "ignis-device-action";
              link.href = status.release;
              link.textContent = t("View");
              row.controlEl.append(link);
            }
          } else {
            describe(t("No updates available."));
          }
        } catch {
          describe(t("Could not check for updates."));
        }
      };
      describe();
      refresh();
    }});
  }
  return [{type:"group",items}];
}
