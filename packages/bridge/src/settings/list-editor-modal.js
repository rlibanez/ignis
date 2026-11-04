
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { Modal, Setting, Notice } from "obsidian";
import { appendMissing } from "./ignore-patterns.js";

// Modal editor for a list of string entries (the proxy host allowlist).
class ListEditorModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.values = [...(opts.values || [])];
  }

  onOpen() {
    this.titleEl.setText(this.opts.title);

    if (this.opts.recommended) {
      new Setting(this.contentEl)
        .setDesc(this.opts.recommended.note)
        .addButton((btn) =>
          btn
            .setButtonText(
              this.opts.recommended.buttonText || translateIgnis("Add recommended"),
            )
            .onClick(() => this.addRecommended()),
        );
    }

    this.listEl = this.contentEl.createDiv("ignis-list-editor");
    this.renderList();

    new Setting(this.contentEl)
      .setName(translateIgnis("Add entry"))
      .addText((text) => {
        this.input = text;
        text.setPlaceholder(this.opts.placeholder || "");

        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.addCurrent();
          }
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText(translateIgnis("Add"))
          .setCta()
          .onClick(() => this.addCurrent()),
      );
  }

  addValues(entries) {
    const union = appendMissing(this.values, entries);
    const newCount = union.length - this.values.length;

    if (newCount > 0) {
      this.values = union;
      this.commit();
      this.renderList();
    }

    return newCount;
  }

  addCurrent() {
    const entry = this.input.getValue().trim();

    if (!entry) {
      return;
    }

    if (!this.addValues([entry])) {
      new Notice(translateIgnis("That entry is already in the list."));
      return;
    }

    this.input.setValue("");
    this.input.inputEl.focus();
  }

  addRecommended() {
    const added = this.addValues(this.opts.recommended.hosts);

    new Notice(
      added > 0
        ? translateIgnis("Added {p0} host{p1}.", {p0: (added), p1: (added === 1 ? "" : "s")})
        : translateIgnis("All recommended hosts are already in the list."),
    );
  }

  remove(entry) {
    this.values = this.values.filter((v) => v !== entry);
    this.commit();
    this.renderList();
  }

  renderList() {
    this.listEl.empty();

    if (this.values.length === 0) {
      this.listEl.createDiv({
        text: this.opts.emptyNote,
        cls: "ignis-list-empty",
      });
      return;
    }

    for (const entry of this.values) {
      new Setting(this.listEl).setName(entry).addExtraButton((btn) =>
        btn
          .setIcon("trash-2")
          .setTooltip(translateIgnis("Remove"))
          .onClick(() => this.remove(entry)),
      );
    }
  }

  commit() {
    this.opts.onChange([...this.values]);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { ListEditorModal };
