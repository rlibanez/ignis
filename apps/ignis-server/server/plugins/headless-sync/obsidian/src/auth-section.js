
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
const { Notice } = require("obsidian");
const api = require("./api");
const auth = require("./auth");

function accountSettingDefinition(tab, serverStatus) {
  const { plugin } = tab;

  if (serverStatus.authenticated) {
    return {
      name: translateIgnis("Obsidian Sync account"),
      desc: translateIgnis("Signed in as {p0} ({p1})", {p0: (serverStatus.name || "unknown"), p1: (serverStatus.email || "unknown")}),
      render: (setting) => {
        setting.addButton((btn) => {
          btn.setButtonText(translateIgnis("Disconnect"));
          btn.buttonEl.addClass("mod-destructive");
          btn.onClick(async () => {
            try {
              await api.logout();
              new Notice(translateIgnis("Disconnected from Headless Sync"));
              await plugin.loadServerStatus();
            } catch (e) {
              new Notice(translateIgnis("Failed to disconnect: {p0}", {p0: (e.message)}));
            }
          });
        });
      },
    };
  }

  return {
    name: translateIgnis("Obsidian Sync account"),
    desc: translateIgnis("Sign in to your Obsidian account to enable sync."),
    render: (setting) => {
      const localToken = auth.getObsidianSyncToken();

      if (localToken) {
        setting
          .setName(translateIgnis("Obsidian Sync account detected"))
          .setDesc(`${localToken.name} (${localToken.email})`);

        setting.addButton((btn) => {
          btn
            .setButtonText(translateIgnis("Use this account for Headless Sync"))
            .setCta()
            .onClick(async () => {
              try {
                await auth.sendTokenToServer(localToken);
                new Notice(translateIgnis("Connected to Headless Sync"));
                await plugin.loadServerStatus();
              } catch (e) {
                new Notice(translateIgnis("Failed to connect: {p0}", {p0: (e.message)}));
              }
            });
        });

        return;
      }

      setting.addButton((btn) => {
        btn.setButtonText(translateIgnis("Log in to Obsidian Sync")).onClick(() => {
          const triggered = auth.triggerLogin(tab.app);

          if (!triggered) {
            new Notice(
              translateIgnis("Could not open login dialog. Try logging in from Settings > General."),
            );
            return;
          }

          tab._cancelWait = auth.waitForLogin(async (token) => {
            tab._cancelWait = null;

            if (token) {
              new Notice(translateIgnis("Detected login: {p0}", {p0: (token.name)}));
              await plugin.loadServerStatus();
              tab.update();
            }
          });
        });
      });
    },
  };
}

module.exports = { accountSettingDefinition };
