
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
const OPEN_FILE_COMMAND = "app:open-file";

const NOTICE_TEXT = "Ignis doesn't support opening files outside the vault.";

const TAB_BAR = ".workspace-tab-header-container";

const DRAG_EVENTS = ["dragenter", "dragover", "drop"];

function refuseOutsideDragOnTabBar(app, e, showNotice) {
  // Tab reordering can use HTML drag events without setting dragManager.draggable.
  // The browser exposes the Files type even before the file list is readable.
  const fromOutside = !app.dragManager.draggable &&
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onTabBar = !!e.target?.closest?.(TAB_BAR);

  if (!fromOutside || !onTabBar) {
    return;
  }

  e.preventDefault();
  // stop drag event so Obsidian doesn't throw.
  e.stopPropagation();

  if (e.type === "drop") {
    showNotice();
  }
}

export function installExternalFilesOverrides(obsidian, app) {
  const { Platform, Notice } = obsidian;
  const showNotice = () => new Notice(translateIgnis(NOTICE_TEXT));

  Object.defineProperty(Platform, "canOpenExternalFiles", {
    get: () => false,
    configurable: true,
  });

  const command = app.commands.findCommand(OPEN_FILE_COMMAND);

  if (command) {
    command.callback = showNotice;
  }

  for (const type of DRAG_EVENTS) {
    window.addEventListener(
      type,
      (e) => refuseOutsideDragOnTabBar(app, e, showNotice),
      true,
    );
  }
}
