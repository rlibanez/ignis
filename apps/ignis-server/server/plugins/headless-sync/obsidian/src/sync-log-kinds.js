
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
const KIND_OPTIONS = [
  { kind: "all", name: "All" },
  { kind: "upload", name: translateIgnis("Uploads") },
  { kind: "download", name: translateIgnis("Downloads") },
  { kind: "deletion", name: translateIgnis("Deletions") },
  { kind: "conflict", name: translateIgnis("Conflicts") },
  { kind: "error", name: translateIgnis("Errors") },
  { kind: "status", name: translateIgnis("Status") },
];

const KIND_PREFIXES = [
  {
    kind: "error",
    prefixes: ["[stderr]", "Sync error", "Sync failed", "Error"],
  },
  { kind: "upload", prefixes: ["Uploading", "Upload complete"] },
  { kind: "download", prefixes: ["Downloading", "Downloaded", "New file"] },
  { kind: "deletion", prefixes: ["Deleting", "Removing local-only"] },
  {
    kind: "conflict",
    prefixes: [
      "Merging conflicted",
      "Merge successful",
      "Merge failed",
      "Conflicted copy stored",
      "Renaming conflicted",
      "Restoring",
      "Reverting",
      "Rejected server change",
    ],
  },
];

function kindOf(line) {
  const text = String(line).trim();

  for (const rule of KIND_PREFIXES) {
    if (rule.prefixes.some((prefix) => text.startsWith(prefix))) {
      return rule.kind;
    }
  }

  return "status";
}

module.exports = { KIND_OPTIONS, kindOf };
