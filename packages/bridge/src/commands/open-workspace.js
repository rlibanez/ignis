
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { WorkspacePickerModal } from "./workspace-picker.js";

function registerOpenWorkspace(plugin) {
  plugin.addCommand({
    id: "open-workspace-in-new-tab",
    name: translateIgnis("Open workspace in new tab"),
    callback: () => {
      new WorkspacePickerModal(plugin.app).open();
    },
  });
}

export { registerOpenWorkspace };
