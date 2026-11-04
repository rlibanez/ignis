import { describe, it, expect, afterEach, afterAll } from "vitest";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vault-lifecycle-"));
process.env.VAULT_ROOT = VAULT_ROOT;
process.env.DATA_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "vault-lifecycle-data-"),
);

const VAULT_ID = "lifecycle";
const vaultPath = path.join(VAULT_ROOT, VAULT_ID);
fs.mkdirSync(vaultPath, { recursive: true });

const { setWss, withWatcherStopped, quiesceRegisteredVault, trackRouterWork } = require("./lifecycle");
const { watcher, writeCoalescer } = require("@ignis/server-core");

function recordingWss() {
  const bounced = [];

  setWss({ closeVaultSockets: (vaultId) => bounced.push(vaultId) });

  return bounced;
}

afterEach(async () => {
  setWss(null);
  await watcher._reset();
  writeCoalescer._reset();
  writeCoalescer.configure({ writeCoalesceMs: 0 });
});

afterAll(() => {
  fs.rmSync(VAULT_ROOT, { recursive: true, force: true });
});

describe("withWatcherStopped", () => {
  it("restores the watcher and bounces the sockets when the mutation fails", async () => {
    const bounced = recordingWss();
    const failure = new Error("rename failed");

    watcher.startWatching(VAULT_ID, vaultPath);

    await expect(
      withWatcherStopped(VAULT_ID, vaultPath, () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    const stopping = watcher.stopWatching(VAULT_ID);

    expect(stopping).toBeInstanceOf(Promise);
    await stopping;

    expect(bounced).toEqual([VAULT_ID]);
  });

  it("doesn't start a watcher when the mutation fails for an unwatched vault", async () => {
    const bounced = recordingWss();

    await expect(
      withWatcherStopped(VAULT_ID, vaultPath, () =>
        Promise.reject(new Error("rm failed")),
      ),
    ).rejects.toThrow("rm failed");

    expect(watcher.stopWatching(VAULT_ID)).toBeUndefined();
    expect(bounced).toEqual([]);
  });

  it("leaves the watcher stopped when the mutation succeeds", async () => {
    const bounced = recordingWss();

    watcher.startWatching(VAULT_ID, vaultPath);

    await expect(
      withWatcherStopped(VAULT_ID, vaultPath, async () => "renamed"),
    ).resolves.toBe("renamed");

    expect(watcher.stopWatching(VAULT_ID)).toBeUndefined();
    expect(bounced).toEqual([]);
  });

  it("rethrows the mutation error", async () => {
    await expect(
      withWatcherStopped(VAULT_ID, vaultPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

it("waits for handler completion then flushes buffered writes before moving a vault", async () => {
  const bounced = recordingWss();
  writeCoalescer.configure({ writeCoalesceMs: 60000 });
  const file = path.join(vaultPath, "buffer.md");
  await writeCoalescer.writeCoalesced(file, "first", "utf-8");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const entry = { handle: async () => {
    await gate;
    await writeCoalescer.writeCoalesced(file, "latest", "utf-8");
  } };
  trackRouterWork({ stack: [{ route: { stack: [entry] } }] });
  const work = entry.handle({}, {}, error => { throw error; });
  let finished = false;
  const stop = quiesceRegisteredVault(VAULT_ID, vaultPath).then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(bounced).toEqual([VAULT_ID]);
  release();
  await work; await stop;
  expect(fs.readFileSync(file, "utf8")).toBe("latest");
  expect(writeCoalescer.getPending(file)).toBeNull();
  expect(watcher.stopWatching(VAULT_ID)).toBeUndefined();
});
