
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
const { PluginSettingTab, Notice } = require("obsidian");
const api = require("./api");
const { isCoreSyncEnabled } = require("./core-sync-guard");
const { SyncLogModal } = require("./sync-log-modal");
const { accountSettingDefinition } = require("./auth-section");
const {
  SYNC_MODES,
  FILE_TYPES,
  CONFIG_CATEGORIES,
  keysOf,
} = require("../../sync-options");

function toggleKey(options, selected, key, enabled) {
  const keys = new Set(selected);

  if (enabled) {
    keys.add(key);
  } else {
    keys.delete(key);
  }

  return options
    .filter((option) => keys.has(option.key))
    .map((option) => option.key);
}

function isCoreSyncDisabled() {
  return !isCoreSyncEnabled();
}

function syncGroup(heading, items) {
  return { type: "group", heading, visible: isCoreSyncDisabled, items };
}

function warningDefinition(text) {
  return {
    searchable: false,
    render: (setting) => {
      setting.descEl.createEl("span", { text, cls: "mod-warning" });
    },
  };
}

function readSyncConfig(vaultState) {
  return {
    mode: vaultState.config?.mode || "bidirectional",
    fileTypes: vaultState.config?.fileTypes || keysOf(FILE_TYPES),
    configs: vaultState.config?.configs || keysOf(CONFIG_CATEGORIES),
    excludedFolders: vaultState.config?.excludedFolders || [],
  };
}

function describeExcludedFolders(count) {
  if (count === 0) {
    return translateIgnis("No folders excluded");
  }

  return count === 1 ? translateIgnis("1 folder excluded") : translateIgnis("{p0} folders excluded", {p0: (count)});
}

function describeSyncStatus(vaultState) {
  if (vaultState.status === "running") {
    return translateIgnis("Sync is running");
  }

  if (vaultState.status === "error") {
    return translateIgnis("Error: {p0}", {p0: (vaultState.error)});
  }

  return translateIgnis("Sync is stopped");
}

class HeadlessSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this._cancelWait = null;
    this._shownState = null;
    this._refreshedThisOpen = false;
  }

  getSettingDefinitions() {
    return [
      {
        type: "group",
        visible: isCoreSyncEnabled,
        items: [this.coreSyncWarningDefinition()],
      },
      this.accountGroup(),
      ...this.syncGroups(),
    ];
  }

  updateIfChanged() {
    const { serverStatus, serverStatusFailed, vaults, vaultsError } =
      this.plugin;
    const shownState = JSON.stringify([
      serverStatus,
      serverStatusFailed,
      vaults,
      vaultsError,
    ]);

    if (shownState === this._shownState) {
      return;
    }

    this._shownState = shownState;
    this.update();
  }

  refreshOnOpen() {
    if (this._refreshedThisOpen) {
      return;
    }

    this._refreshedThisOpen = true;
    this.plugin.loadServerStatus();
    this.plugin.loadVaults();
  }

  coreSyncWarningDefinition() {
    return {
      name: translateIgnis("Obsidian Sync is active"),
      render: (setting) => {
        setting.descEl.createEl("span", {
          text: translateIgnis("Headless Sync cannot run alongside Obsidian's built-in sync to avoid conflicts. Disable Obsidian Sync in Core Plugins to use Headless Sync instead."),
          cls: "mod-warning",
        });

        setting.addButton((btn) => {
          btn.setButtonText(translateIgnis("Open Core Plugins")).onClick(() => {
            this.app.setting.openTabById("plugins");
          });
        });
      },
    };
  }

  accountGroup() {
    const definition = this.serverStatusDefinition();
    const { render } = definition;

    definition.render = (setting) => {
      this.refreshOnOpen();
      render(setting);
    };

    return syncGroup(undefined, [definition]);
  }

  serverStatusDefinition() {
    const { serverStatus, serverStatusFailed } = this.plugin;

    if (serverStatusFailed) {
      return warningDefinition(
        translateIgnis("Failed to connect to Headless Sync server plugin."),
      );
    }

    if (!serverStatus) {
      return { name: translateIgnis("Obsidian Sync account"), render: () => {} };
    }

    if (!serverStatus.installed) {
      return warningDefinition(
        translateIgnis("obsidian-headless (ob CLI) is not installed on the server. Install it to enable sync."),
      );
    }

    return accountSettingDefinition(this, serverStatus);
  }

  syncGroups() {
    const { serverStatus, serverStatusFailed, vaults, vaultsError } =
      this.plugin;

    if (!serverStatus) {
      return serverStatusFailed ? [] : [syncGroup(translateIgnis("Vault sync"), [])];
    }

    if (!serverStatus.installed) {
      return [];
    }

    if (!serverStatus.authenticated) {
      return [
        syncGroup(translateIgnis("Vault sync"), [
          {
            name: translateIgnis("Sync not configured"),
            desc: translateIgnis("Sign in to your Obsidian Sync account to set up sync."),
            render: (setting) => {
              setting.addButton((btn) => {
                btn.setButtonText(translateIgnis("Set up sync"));
                btn.buttonEl.disabled = true;
              });
            },
          },
        ]),
      ];
    }

    if (vaultsError) {
      return [
        syncGroup(undefined, [
          warningDefinition(translateIgnis("Failed to load sync state: {p0}", {p0: (vaultsError)})),
        ]),
      ];
    }

    if (!vaults) {
      return [syncGroup(translateIgnis("Vault sync"), [])];
    }

    const vaultId = this.app.vault.getName();
    const vaultState = vaults.find((v) => v.vaultId === vaultId);

    if (!vaultState) {
      return [syncGroup(translateIgnis("Vault sync"), [this.syncSetupDefinition(vaultId)])];
    }

    const syncConfig = readSyncConfig(vaultState);

    return [
      syncGroup(
        translateIgnis("Vault sync"),
        this.vaultSyncDefinitions(vaultId, vaultState, syncConfig),
      ),
      syncGroup(translateIgnis("Selective sync"), [
        this.excludedFoldersDefinition(vaultId, syncConfig),
        ...this.optionToggleDefinitions(
          vaultId,
          syncConfig,
          "fileTypes",
          FILE_TYPES,
        ),
      ]),
      syncGroup(
        translateIgnis("Vault configuration sync"),
        this.optionToggleDefinitions(
          vaultId,
          syncConfig,
          "configs",
          CONFIG_CATEGORIES,
        ),
      ),
    ];
  }

  async saveSyncConfig(vaultId, syncConfig) {
    try {
      const { state, restarted } = await api.setConfig(vaultId, syncConfig);

      new Notice(
        restarted
          ? translateIgnis("Sync settings saved, sync restarted")
          : translateIgnis("Sync settings saved"),
      );
      this.plugin.setVaultState(state);
    } catch (e) {
      new Notice(translateIgnis("Failed to save sync settings: {p0}", {p0: (e.message)}));
      this.update();
    }
  }

  syncSetupDefinition(vaultId) {
    return {
      name: translateIgnis("Sync not configured"),
      desc: translateIgnis("This vault has not been linked to a remote vault yet."),
      render: (setting) => {
        setting.addButton((btn) => {
          btn
            .setButtonText(translateIgnis("Set up sync"))
            .setCta()
            .onClick(() => {
              const scope = this.app.setting.scope;
              const prevFocusContainer = scope.tabFocusContainerEl;
              scope.tabFocusContainerEl = null;

              const cleanup = () => {
                scope.tabFocusContainerEl = prevFocusContainer;
              };

              const modal = new window.IgnisUI.SyncSetupModal({
                target: document.body,
                props: {
                  vaultId,
                  onSuccess: async () => {
                    cleanup();
                    modal.$destroy();
                    await this.plugin.loadVaults();
                  },
                },
              });

              modal.$on("close", () => {
                cleanup();
                modal.$destroy();
              });
            });
        });
      },
    };
  }

  vaultSyncDefinitions(vaultId, vaultState, syncConfig) {
    return [
      {
        name: translateIgnis("Remote vault"),
        desc: vaultState.remoteVaultName || vaultState.remoteVault || "unknown",
        render: (setting) => {
          setting.addButton((btn) => {
            btn.setButtonText(translateIgnis("Unlink"));
            btn.buttonEl.addClass("mod-destructive");
            btn.onClick(async () => {
              try {
                await api.unlinkVault(vaultId);
                new Notice(translateIgnis("Vault unlinked"));
                await this.plugin.loadVaults();
              } catch (e) {
                new Notice(translateIgnis("Failed to unlink: {p0}", {p0: (e.message)}));
              }
            });
          });
        },
      },
      {
        name: translateIgnis("Sync status"),
        desc: describeSyncStatus(vaultState),
        render: (setting) => {
          setting.addButton((btn) => {
            if (vaultState.status === "running") {
              btn.setButtonText(translateIgnis("Stop sync"));
              btn.buttonEl.addClass("mod-destructive");
              btn.onClick(async () => {
                try {
                  const { state } = await api.stopSync(vaultId);
                  new Notice(translateIgnis("Sync stopped"));
                  this.plugin.setVaultState(state);
                } catch (e) {
                  new Notice(translateIgnis("Failed to stop: {p0}", {p0: (e.message)}));
                }
              });
            } else {
              btn
                .setButtonText(translateIgnis("Start sync"))
                .setCta()
                .onClick(async () => {
                  try {
                    const { state } = await api.startSync(vaultId);
                    new Notice(translateIgnis("Sync started"));
                    this.plugin.setVaultState(state);
                  } catch (e) {
                    new Notice(translateIgnis("Failed to start: {p0}", {p0: (e.message)}));
                  }
                });
            }
          });
        },
      },
      {
        name: translateIgnis("Sync mode"),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            for (const syncMode of SYNC_MODES) {
              dropdown.addOption(syncMode.key, syncMode.name);
            }

            dropdown.setValue(syncConfig.mode).onChange(async (mode) => {
              syncConfig.mode = mode;
              await this.saveSyncConfig(vaultId, syncConfig);
            });
          });
        },
      },
      {
        name: translateIgnis("Sync log"),
        desc: translateIgnis("View recent sync activity."),
        render: (setting) => {
          setting.addButton((btn) => {
            btn.setButtonText(translateIgnis("View")).onClick(() => {
              new SyncLogModal(this.app, vaultId).open();
            });
          });
        },
      },
    ];
  }

  excludedFoldersDefinition(vaultId, syncConfig) {
    return {
      name: translateIgnis("Excluded folders"),
      desc: describeExcludedFolders(syncConfig.excludedFolders.length),
      render: (setting) => {
        setting.addButton((btn) => {
          btn.setButtonText(translateIgnis("Manage")).onClick(() => {
            this.openExcludedFoldersEditor(vaultId, syncConfig);
          });
        });
      },
    };
  }

  optionToggleDefinitions(vaultId, syncConfig, field, options) {
    return options.map((option) => ({
      name: option.name,
      desc: option.desc,
      render: (setting) => {
        setting.addToggle((toggle) => {
          toggle
            .setValue(syncConfig[field].includes(option.key))
            .onChange(async (enabled) => {
              syncConfig[field] = toggleKey(
                options,
                syncConfig[field],
                option.key,
                enabled,
              );
              await this.saveSyncConfig(vaultId, syncConfig);
            });
        });
      },
    }));
  }

  openExcludedFoldersEditor(vaultId, syncConfig) {
    const folders = this.app.vault
      .getAllFolders()
      .map((folder) => folder.path)
      .filter((path) => path && path !== "/");

    const component = new window.IgnisUI.ExcludedFoldersEditor({
      target: document.querySelector(".modal-container") || document.body,
      props: {
        folders,
        excluded: syncConfig.excludedFolders,
      },
    });

    let latest = syncConfig.excludedFolders;
    let dirty = false;

    component.$on("change", (event) => {
      latest = event.detail;
      dirty = true;
    });

    component.$on("close", async () => {
      component.$destroy();

      if (!dirty) {
        return;
      }

      syncConfig.excludedFolders = latest;
      await this.saveSyncConfig(vaultId, syncConfig);
    });
  }

  hide() {
    this._refreshedThisOpen = false;

    if (this._cancelWait) {
      this._cancelWait();
      this._cancelWait = null;
    }

    super.hide();
  }
}

module.exports = { HeadlessSyncSettingTab };
