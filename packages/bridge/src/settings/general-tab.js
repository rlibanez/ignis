
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { setIcon } from "obsidian";
import { checkForUpdate } from "../update-check.js";
import * as serverSettings from "./server-settings.js";
import { numberField, listField } from "./server-setting-fields.js";
import { messageDefinition, blockDefinition } from "./settings-ui.js";

const UPSTREAM_RELEASES_URL = "https://github.com/Nystik-gh/ignis/releases";
const GITHUB_URL = "https://github.com/rlibanez/ignis";

const TEXT_LINKS = [
  { text: translateIgnis("Docs"), href: "https://ignis.thiefling.com/docs/" },
];

const ICON_LINKS = [
  {
    label: "Discord",
    href: "https://discord.gg/rgyXBAeNMM",
    icon: "/assets/discord.svg",
  },
  {
    label: "Ko-fi",
    href: "https://ko-fi.com/nystik",
    icon: "/assets/kofi.svg",
  },
  {
    label: "GitHub Sponsors",
    href: "https://github.com/sponsors/Nystik-gh",
    icon: "/assets/githubsponsors.svg",
  },
];

function getVersion() {
  return window.__ignis?.version || "unknown";
}

function settingDefinitions(tab) {
  return [
    { type: "group", cls: "ignis-plain", items: [blockDefinition(addHeader)] },
    {
      type: "group",
      cls: "ignis-plain",
      visible: () => !window.isSecureContext,
      items: [blockDefinition(addInsecureContextCallout)],
    },
    { type: "group", items: [serverStatusDefinition()] },
    ...serverSettingsGroups(tab),
  ];
}

function addHeaderLinks(containerEl) {
  const row = containerEl.createDiv("ignis-header-links");
  const linkAttrs = { target: "_blank", rel: "noopener noreferrer" };

  for (const link of TEXT_LINKS) {
    row.createEl("a", {
      cls: "ignis-header-text-link",
      text: link.text,
      href: link.href,
      attr: linkAttrs,
    });
  }

  row.createSpan("ignis-header-links-separator");

  for (const link of ICON_LINKS) {
    const anchor = row.createEl("a", {
      cls: "ignis-header-link",
      href: link.href,
      attr: { ...linkAttrs, "aria-label": link.label },
    });

    anchor.createEl("img", {
      cls: "ignis-header-link-icon",
      attr: { src: link.icon, alt: link.label },
    });
  }
}

function addHeader(containerEl) {
  const version = getVersion();

  containerEl.addClass("ignis-header-block");
  addHeaderLinks(containerEl);

  const header = containerEl.createDiv("ignis-header");

  header.createDiv("ignis-header-logo").createEl("img", {
    attr: { src: "/assets/ignis.webp", alt: "Ignis" },
  });

  const info = header.createDiv("ignis-header-info");
  info.createEl("div", { text: translateIgnis("Ignis"), cls: "ignis-header-title" });
  info.createEl("div", {
    text: translateIgnis("Obsidian server bridge"),
    cls: "ignis-header-subtitle",
  });

  const right = header.createDiv("ignis-header-right");

  const versionCol = right.createDiv("ignis-header-version-col");
  versionCol.createEl("a", {
    href: GITHUB_URL + "/releases/tag/v" + encodeURIComponent(version),
    attr: { target: "_blank", rel: "noopener noreferrer" },
    text: translateIgnis("Version {p0}", {p0: (version)}),
    cls: "ignis-header-version",
  });

  const upstreamVersion = window.__ignis?.upstream?.version;
  const upstreamLabel = upstreamVersion ? "Upstream " + upstreamVersion : "Upstream";
  const updateIndicator = versionCol.createEl("a", {
    text: upstreamLabel,
    href: UPSTREAM_RELEASES_URL,
    cls: "ignis-header-version ignis-update-indicator",
    attr: { target: "_blank", rel: "noopener noreferrer" },
  });

  const githubLink = right.createEl("a", {
    cls: "ignis-github-link",
    href: GITHUB_URL,
    attr: { target: "_blank", "aria-label": "GitHub" },
  });

  githubLink.createEl("img", {
    cls: "ignis-github-icon",
    attr: { src: "/assets/github.svg", alt: "GitHub" },
  });

  checkForUpdate(version).then((latest) => {
    if (latest) {
      updateIndicator.textContent = upstreamLabel + " · " + translateIgnis("v{p0} available", {p0: latest.version});
      updateIndicator.addClass("ignis-update-available");
      updateIndicator.href = latest.url;

    }
  });
}

const REMOTE_ACCESS_DOCS_URL =
  "https://ignis.thiefling.com/docs/security/remote-access/#running-without-tls";

function addInsecureContextCallout(containerEl) {
  const callout = containerEl.createDiv("ignis-insecure-callout");

  const icon = callout.createDiv("ignis-insecure-callout-icon");
  setIcon(icon, "alert-triangle");

  const text = callout.createDiv("ignis-insecure-callout-text");
  text.createEl("div", {
    text: translateIgnis("Insecure connection"),
    cls: "ignis-insecure-callout-title",
  });

  const body = text.createEl("div", { cls: "ignis-insecure-callout-body" });
  body.appendText(
    translateIgnis("The browser disables some APIs on insecure pages, so parts of Obsidian do not work here. "),
  );
  body.createEl("a", {
    text: translateIgnis("Serving Ignis over HTTPS"),
    href: REMOTE_ACCESS_DOCS_URL,
    attr: { target: "_blank", rel: "noopener noreferrer" },
  });
  body.appendText(translateIgnis(" restores them."));
}

const STATUS_LABELS = {
  open: translateIgnis("Connected"),
  connecting: translateIgnis("Connecting..."),
  closed: translateIgnis("Disconnected"),
};

const STATUS_DOT_CLASSES = {
  open: "ignis-status-connected",
  connecting: "ignis-status-connecting",
  closed: "ignis-status-disconnected",
};

function serverStatusDefinition() {
  return {
    name: translateIgnis("Server status"),
    render: (setting) => {
      const ws = window.__ignis.ws;

      setting.settingEl.addClass("ignis-status-setting");

      const dotEl = setting.controlEl.createEl("span", {
        cls: "ignis-status-dot",
      });

      const labelEl = setting.controlEl.createEl("span", {
        cls: "ignis-status-label",
      });

      function renderState(state) {
        dotEl.className = `ignis-status-dot ${STATUS_DOT_CLASSES[state] || STATUS_DOT_CLASSES.closed}`;
        labelEl.textContent = STATUS_LABELS[state] || STATUS_LABELS.closed;
      }

      renderState(ws.isOpen() ? "open" : "closed");

      return ws.onStateChange(renderState);
    },
  };
}

const MB = 1024 * 1024;
const MINUTE = 60 * 1000;

function serverSettingsGroups(tab) {
  if (!serverSettings.get()) {
    return [
      {
        type: "group",
        items: [
          messageDefinition(
            serverSettings.loadFailed()
              ? translateIgnis("Failed to load server settings.")
              : translateIgnis("Loading server settings..."),
          ),
        ],
      },
    ];
  }

  return [
    {
      type: "group",
      heading: translateIgnis("Caching"),
      items: [
        numberField({
          name: translateIgnis("Content cache (MB)"),
          desc: translateIgnis("Browser cache of file content. Applies after reload."),
          key: "contentCacheBytes",
          fromStored: (bytes) => Math.round(bytes / MB),
          toStored: (n) => n * MB,
        }),
        numberField({
          name: translateIgnis("Input cache (MB)"),
          desc: translateIgnis("Cache for files picked for import. Applies after reload."),
          key: "inputCacheBytes",
          fromStored: (bytes) => Math.round(bytes / MB),
          toStored: (n) => n * MB,
        }),
        numberField({
          name: translateIgnis("Input cache TTL (minutes)"),
          desc: translateIgnis("How long picked files stay cached. Applies after reload."),
          key: "inputCacheTtlMs",
          fromStored: (ms) => Math.round(ms / MINUTE),
          toStored: (n) => n * MINUTE,
        }),
      ],
    },
    {
      type: "group",
      heading: translateIgnis("Security"),
      items: [
        numberField({
          name: translateIgnis("Max request body (MB)"),
          desc: translateIgnis("Largest request the server accepts."),
          key: "maxBodyBytes",
          fromStored: (bytes) => Math.round(bytes / MB),
          toStored: (n) => n * MB,
        }),
        ...proxyAccessFields(tab),
        listField(tab, {
          name: translateIgnis("Direct-fetch hosts"),
          desc: translateIgnis("Hosts the browser fetches directly, bypassing the proxy. Only for hosts that allow cross-origin browser requests (CORS); everything else goes through the proxy. Applies after reload."),
          key: "directFetchHosts",
          modal: {
            placeholder: "api.example.com",
            emptyNote: translateIgnis("No hosts yet."),
          },
        }),
      ],
    },
    {
      type: "group",
      heading: translateIgnis("Advanced"),
      items: [
        numberField({
          name: translateIgnis("Write coalesce window (ms)"),
          desc: translateIgnis("Debounce window for rapid writes on slow filesystems. 0 disables. Maximum 60000."),
          key: "writeCoalesceMs",
          fromStored: (n) => n,
          toStored: (n) => n,
        }),
        ignoreRulesField(),
      ],
    },
  ];
}

function getProxyMode() {
  return serverSettings.get().proxyMode || "any";
}

// Proxy access mode plus the allowlist row, which only shows in "allowlist" mode.
function proxyAccessFields(tab) {
  const accessField = {
    name: translateIgnis("Proxy access"),
    desc: translateIgnis("Which external hosts Obsidian may reach through the server's CORS proxy."),
    render: (setting) => {
      setting.addDropdown((dd) => {
        dd.addOption("any", translateIgnis("Any public host"));
        dd.addOption("allowlist", translateIgnis("Allowlist only"));
        dd.addOption("disabled", translateIgnis("Disabled"));
        dd.setValue(getProxyMode());

        dd.onChange(async (value) => {
          await serverSettings.save({ proxyMode: value });
          tab.refreshDomState();
        });
      });
    },
  };

  const allowlistField = listField(tab, {
    name: translateIgnis("Proxy host allowlist"),
    desc: translateIgnis("Hostnames the proxy may reach, matched exactly."),
    key: "proxyAllowlist",
    modal: {
      placeholder: "api.example.com",
      emptyNote: translateIgnis("No hosts yet."),
      recommended: {
        note: translateIgnis("Restricting the proxy stops Obsidian's plugin and theme browser and updates from working unless their hosts are allowed."),
        hosts: [
          "releases.obsidian.md",
          "github.com",
          "api.github.com",
          "raw.githubusercontent.com",
        ],
        buttonText: translateIgnis("Add recommended hosts"),
      },
    },
  });

  return [
    accessField,
    { ...allowlistField, visible: () => getProxyMode() === "allowlist" },
  ];
}

function ignoreRulesField() {
  return {
    name: translateIgnis("Ignored paths"),
    desc: createFragment((frag) => {
      frag.appendText(
        translateIgnis("Rules for paths to ignore when watching for file changes. Ignored paths still appear in the vault and can be manually refreshed. Uses gitignore patterns "),
      );
      frag.createEl("a", {
        text: translateIgnis("Learn more"),
        href: "https://ignis.thiefling.com/docs/performance/#ignored-paths",
        attr: { target: "_blank", rel: "noopener noreferrer" },
      });
    }),
    render: (setting) => {
      const current = serverSettings.get();
      let rules = current.ignoreRules;

      const setLabel = (btn) =>
        btn.setButtonText(rules.length ? translateIgnis("Edit ({p0})", {p0: (rules.length)}) : translateIgnis("Edit"));

      setting.addButton((btn) => {
        setLabel(btn);

        btn.onClick(() => {
          openIgnoreRulesEditor({
            rules,
            suggestions: current.ignoreSuggestions,
            onChange: async (edited) => {
              rules = edited;
              setLabel(btn);
              await serverSettings.save({ ignoreRules: edited });
            },
          });
        });
      });
    },
  };
}

function openIgnoreRulesEditor(opts) {
  const component = new window.IgnisUI.IgnoreRulesEditor({
    // mount to settings modal to avoid focus issues
    target: document.querySelector(".modal-container") || document.body,
    props: {
      rules: opts.rules,
      suggestions: opts.suggestions,
    },
  });

  component.$on("change", (event) => {
    opts.onChange(event.detail);
  });

  component.$on("close", () => {
    component.$destroy();
  });
}

export { settingDefinitions };
