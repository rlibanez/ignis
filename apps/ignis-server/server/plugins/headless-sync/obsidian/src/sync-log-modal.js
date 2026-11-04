
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
const { Modal, Setting, Notice } = require("obsidian");
const api = require("./api");
const { KIND_OPTIONS, kindOf } = require("./sync-log-kinds");

const CHANNEL = "plugin:headless-sync";
const LOG_LIMIT = 2000;
const NEAR_BOTTOM_PX = 50;

function formatEntry(entry) {
  const at = new Date(entry.timestamp);
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

  return `[${time}] ${entry.line}`;
}

class SyncLogModal extends Modal {
  constructor(app, vaultId) {
    super(app);
    this.vaultId = vaultId;
    this.entries = [];
    this.kind = "all";
    this.filter = "";
    this._unsubLog = null;
  }

  onOpen() {
    this.modalEl.addClass("ignis-sync-log-modal");
    this.titleEl.setText(translateIgnis("Sync log"));

    const toolbar = new Setting(this.contentEl);

    toolbar.addDropdown((dropdown) => {
      for (const option of KIND_OPTIONS) {
        dropdown.addOption(option.kind, option.name);
      }

      dropdown.setValue(this.kind).onChange((kind) => {
        this.kind = kind;
        this.renderLines();
      });
    });

    toolbar.addText((text) => {
      text.setPlaceholder(translateIgnis("Filter...")).onChange((value) => {
        this.filter = value;
        this.renderLines();
      });
    });

    toolbar.addButton((btn) => {
      btn.setButtonText(translateIgnis("Copy sync log")).onClick(async () => {
        try {
          await navigator.clipboard.writeText(this.visibleLines().join("\n"));
          new Notice(translateIgnis("Sync log copied"));
        } catch (e) {
          new Notice(translateIgnis("Failed to copy sync log: {p0}", {p0: (e.message)}));
        }
      });
    });

    this.logBox = this.contentEl.createEl("pre", { cls: "ignis-log-terminal" });
    this.codeEl = this.logBox.createEl("code", { text: translateIgnis("Loading logs...") });

    this.loadLogs();
  }

  async loadLogs() {
    try {
      const logsData = await api.getLogs(this.vaultId, LOG_LIMIT);
      this.entries = logsData.logs;
    } catch (e) {
      this.codeEl.textContent = translateIgnis("Failed to load logs: {p0}", {p0: (e.message)});
      return;
    }

    this.renderLines();
    this.logBox.scrollTop = this.logBox.scrollHeight;
    this.subscribeToLog();
  }

  subscribeToLog() {
    const channel = window.__ignis.ws.channel(CHANNEL);

    this._unsubLog = channel.subscribe("sync-log", (msg) => {
      const payload = msg.payload || {};

      if (payload.vaultId !== this.vaultId) {
        return;
      }

      const isNearBottom =
        this.logBox.scrollHeight -
          this.logBox.scrollTop -
          this.logBox.clientHeight <
        NEAR_BOTTOM_PX;

      this.entries.push({
        timestamp: new Date().toISOString(),
        line: payload.line,
      });

      this.renderLines();

      if (isNearBottom) {
        this.logBox.scrollTop = this.logBox.scrollHeight;
      }
    });
  }

  visibleLines() {
    const filter = this.filter.trim().toLowerCase();

    return this.entries
      .filter(
        (entry) => this.kind === "all" || kindOf(entry.line) === this.kind,
      )
      .filter((entry) => !filter || entry.line.toLowerCase().includes(filter))
      .map(formatEntry);
  }

  renderLines() {
    if (this.entries.length === 0) {
      this.codeEl.textContent = translateIgnis("No log entries yet.");
      return;
    }

    const lines = this.visibleLines();

    this.codeEl.textContent =
      lines.length > 0 ? lines.join("\n") : translateIgnis("No matching log entries.");
  }

  onClose() {
    if (this._unsubLog) {
      this._unsubLog();
      this._unsubLog = null;
    }

    this.contentEl.empty();
  }
}

module.exports = { SyncLogModal };
