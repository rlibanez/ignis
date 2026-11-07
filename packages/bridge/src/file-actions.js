
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import { Notice } from "obsidian";

function getVaultId() {
  return window.__ignis?.vault?.uuid || window.__currentVaultId || "";
}

function triggerDownload(endpoint, filePath, downloadName) {
  const vaultId = getVaultId();
  const sharedUrl = window.__ignis?.sharedFiles?.downloadUrl(filePath, endpoint === "download-zip");
  const url = sharedUrl ||
    `/api/fs/${endpoint}` +
    `?vault=${encodeURIComponent(vaultId)}` +
    `&path=${encodeURIComponent(filePath)}`;

  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  a.click();
}

async function copyIgnisUrl(file) {
  const url =
    `${window.location.origin}/?vault=${encodeURIComponent(getVaultId())}` +
    `&file=${encodeURIComponent(file.path)}`;

  const copied = await writeToClipboard(url);

  new Notice(copied ? translateIgnis("Ignis URL copied") : translateIgnis("Ignis URL: {p0}", {p0: (url)}));
}

// navigator.clipboard needs a secure context; the execCommand path also copies on plain HTTP.
async function writeToClipboard(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A rejected write (no focus, denied permission) falls through to execCommand.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  let ok = false;

  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  textarea.remove();
  return ok;
}

function showFilePicker(app, targetFolder = null) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    if (files.length === 0) return;

    const folder = targetFolder || app.vault.getRoot();
    const folderPath = folder.path;

    new Notice(translateIgnis("Uploading {p0} file(s)...", {p0: (files.length)}));

    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const targetPath = folderPath
          ? `${folderPath}/${file.name}`
          : file.name;

        await app.vault.createBinary(targetPath, arrayBuffer);
        successCount++;
      } catch (e) {
        console.error("[ignis-bridge] Upload failed:", file.name, e);
        errorCount++;
      }
    }

    if (successCount > 0) {
      new Notice(translateIgnis("Uploaded {p0} file(s) successfully", {p0: (successCount)}));
    }

    if (errorCount > 0) {
      new Notice(translateIgnis("Failed to upload {p0} file(s)", {p0: (errorCount)}), 5000);
    }

    input.remove();
  });

  document.body.appendChild(input);
  input.click();
}

function addFileMenuItems(menu, file) {
  menu.addItem((item) => {
    item
      .setTitle(translateIgnis("Download"))
      .setIcon("download")
      .onClick(() => triggerDownload("download", file.path, file.name));
  });

  // add to "Copy path" submenu
  menu.addItem((item) => {
    item
      .setSection("info.copy")
      .setTitle(translateIgnis("as Ignis URL"))
      .setIcon("link")
      .onClick(() => copyIgnisUrl(file));
  });
}

function addFolderMenuItems(menu, folder, app) {
  menu.addItem((item) => {
    item
      .setTitle(translateIgnis("Download as ZIP"))
      .setIcon("download")
      .onClick(() =>
        triggerDownload("download-zip", folder.path, `${folder.name}.zip`),
      );
  });

  menu.addItem((item) => {
    item
      .setTitle(translateIgnis("Upload file"))
      .setIcon("upload")
      .onClick(() => showFilePicker(app, folder));
  });
}

export { showFilePicker, addFileMenuItems, addFolderMenuItems };
