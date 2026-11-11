
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { vaultService } from "@ignis/services";
import { Notice } from "obsidian";
import { messageDefinition } from "./settings-ui.js";

function settingDefinitions() {
  return [
    {
      type: "group",
      items: [
        messageDefinition(
          translateIgnis("Settings for the currently active vault. ") +
            translateIgnis("These settings are not stored in the vault itself, unlike Obsidian's native settings; they apply to all browsers and devices that open this vault."),
        ),
      ],
    },
    { type: "group", items: [vaultSettingDefinition()] },
  ];
}

function vaultSettingDefinition() {
  return {
    name: translateIgnis("Always trust plugins for this vault"),
    desc: translateIgnis("Skip the trust prompt on new devices for community plugins already enabled in this vault."),
    render: (setting) => {
      const vault = vaultService.getCurrentVaultReference();
      const endpoint = "/api/vault/plugin-trust";
      setting.addToggle(toggle => {
        let trusted = false;
        toggle.setDisabled(true);
        async function request(url, options) {
          const response = await fetch(url,{cache:"no-store",...options});
          if (!response.ok) throw new Error("Vault trust request failed");
          return (await response.json()).trusted;
        }
        toggle.onChange(async value => {
          if (value === trusted) return;
          toggle.setDisabled(true);
          try {
            trusted = await request(endpoint,{
              method:"POST",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({vault,trusted:value}),
            });
            if (trusted) vaultService.setVaultTrust(vault);
          } catch {
            new Notice(translateIgnis("Save failed"));
          } finally {
            toggle.setValue(trusted).setDisabled(false);
          }
        });
        void request(`${endpoint}?vault=${encodeURIComponent(vault)}`).then(value=>{
          trusted = value;
          toggle.setValue(trusted).setDisabled(false);
        }).catch(()=>new Notice(translateIgnis("Failed to load server settings.")));
      });
    },
  };
}

export { settingDefinitions };
