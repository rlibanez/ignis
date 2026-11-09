import { stripBuildMetadata, isNewer } from "./util/version.js";

const GITHUB_API_LATEST =
  "https://api.github.com/repos/Nystik-gh/ignis/releases/latest";

let newerRelease = null;

async function fetchNewerRelease(currentVersion) {
  try {
    const res = await fetch(GITHUB_API_LATEST);

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const latest = stripBuildMetadata(data.tag_name?.replace(/^v/, ""));
    const current = stripBuildMetadata(currentVersion);

    if (isNewer(latest, current)) {
      return { version: latest, url: data.html_url };
    }

    return null;
  } catch {
    return null;
  }
}

// once per page session.
function checkForUpdate(currentVersion) {
  const upstreamVersion = globalThis.window?.__ignis?.upstream?.version || currentVersion;
  if (!newerRelease) {
    newerRelease = fetchNewerRelease(upstreamVersion);
  }

  return newerRelease;
}

export { checkForUpdate };
