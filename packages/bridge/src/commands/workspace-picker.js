
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { FuzzySuggestModal } from "obsidian";

class WorkspacePickerModal extends FuzzySuggestModal {
  constructor(app) {
    super(app);
    this.setPlaceholder(translateIgnis("Open workspace in new tab"));
  }

  getItems() {
    const plugin = this.app.internalPlugins.plugins.workspaces;

    if (!plugin || !plugin.enabled || !plugin.instance) {
      return [];
    }

    return Object.keys(plugin.instance.workspaces);
  }

  getItemText(item) {
    return item;
  }

  onChooseItem(item) {
    const url = new URL(window.location.href);

    url.searchParams.set("workspace", item);
    url.searchParams.set("load", "preset");
    window.open(url.toString(), "_blank");
  }
}

export { WorkspacePickerModal };
