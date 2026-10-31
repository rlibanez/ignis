
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { Notice } from "obsidian";
import * as pluginList from "./plugin-list.js";
import { reconcilePluginTabs } from "./plugin-tabs.js";
import { messageDefinition } from "./settings-ui.js";

function getVaultId() {
  return window.__currentVaultId || "";
}

async function togglePlugin(pluginId, enable) {
  const action = enable ? "enable" : "disable";
  const vaultId = getVaultId();

  const res = await fetch(`/api/plugins/${pluginId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vault: window.__ignis?.vault?.uuid || vaultId }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || translateIgnis("Failed to {p0} plugin", {p0: (action)}));
  }

  return res.json();
}

function settingDefinitions(tab) {
  return [
    {
      type: "group",
      items: [
        messageDefinition(
          translateIgnis("Ignis plugins extend server functionality and run alongside your vaults. ") +
            translateIgnis("They are separate from Obsidian's built-in plugins."),
        ),
      ],
    },
    { type: "group", items: pluginDefinitions(tab) },
  ];
}

function pluginDefinitions(tab) {
  const plugins = pluginList.get();

  if (!plugins) {
    return [
      messageDefinition(
        pluginList.loadFailed()
          ? translateIgnis("Failed to load plugins.")
          : translateIgnis("Loading plugins..."),
      ),
    ];
  }

  if (plugins.length === 0) {
    return [messageDefinition(translateIgnis("No server plugins available."))];
  }

  return plugins.map((plugin) => pluginDefinition(tab, plugin));
}

function isEnabled(plugin) {
  return plugin.enabledVaults.includes(getVaultId());
}

function pluginDefinition(tab, plugin) {
  return {
    name: plugin.name,
    desc: plugin.description || "",
    render: (setting) => {
      setting.addToggle((toggle) => {
        toggle.setValue(isEnabled(plugin));
        toggle.onChange(async (value) => {
          if (value === isEnabled(plugin)) {
            return;
          }

          try {
            await togglePlugin(plugin.id, value);
            pluginList.setEnabled(plugin.id, getVaultId(), value);

            new Notice(
              translateIgnis("{p0} {p1} for this vault.", {p0: (plugin.name), p1: (value ? "enabled" : "disabled")}),
            );

            // The server's WS broadcast drives the actual load/unload via virtual-plugin-loader.
            // Reconcile the settings sidebar so the new plugin's settings tab gets grouped correctly.
            setTimeout(() => {
              reconcilePluginTabs(tab.app.setting);
            }, 100);
          } catch (e) {
            new Notice(translateIgnis("Failed: {p0}", {p0: (e.message)}));
            toggle.setValue(!value);
          }
        });
      });
    },
  };
}

export { settingDefinitions };
