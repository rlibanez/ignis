import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

describe("resolveVaultId", () => {
  const storage = new Map();
  const requests = [];
  let infoStatus = 200;

  class FakeXHR {
    open(method, url) {
      this.url = url;
    }

    send() {
      requests.push(this.url);
      this.status = infoStatus;
      this.responseText = JSON.stringify({ id: "Abra", trustPlugins: true });
    }
  }

  const stubs = {
    window: globalThis,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: { body: { classList: { contains: () => false } } },
    location: {
      origin: "http://localhost",
      href: "http://localhost/",
      search: "",
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    XMLHttpRequest: FakeXHR,
  };

  let resolveVaultId, applyVaultInfo;

  beforeAll(async () => {
    Object.assign(globalThis, stubs);
    ({ resolveVaultId, applyVaultInfo } = await import("./init.js"));
  });

  afterAll(() => {
    delete globalThis.__ignisAuth;
    for (const key of Object.keys(stubs)) {
      delete globalThis[key];
    }
  });

  beforeEach(() => {
    storage.clear();
    requests.length = 0;
    infoStatus = 200;
    globalThis.location.search = "";
    delete globalThis.__currentVaultId;
    globalThis.__ignisAuth = { userId: "test-user", blocked: false };
  });

  it("keeps the display name separate from the pinned UUID and persists the UUID", () => {
    applyVaultInfo({ id: "Notes", uuid: "stable-uuid" });
    expect(globalThis.__currentVaultId).toBe("Notes");
    expect(globalThis.__currentVaultUuid).toBe("stable-uuid");
    expect(storage.get("ignis:last-vault:test-user")).toBe("stable-uuid");
    applyVaultInfo({ id: "Legacy" });
    expect(globalThis.__currentVaultUuid).toBeNull();
    expect(storage.get("ignis:last-vault:test-user")).toBe("Legacy");
  });

  it("takes the vault from the URL without asking the server", () => {
    globalThis.location.search = "?vault=Work";
    resolveVaultId();

    expect(globalThis.__currentVaultId).toBe("Work");
    expect(requests).toEqual([]);
  });

  it("falls back to the last opened vault without asking the server", () => {
    storage.set("ignis:last-vault:test-user", "Saved");
    resolveVaultId();

    expect(globalThis.__currentVaultId).toBe("Saved");
    expect(requests).toEqual([]);
  });

  it("asks the server for its default vault when neither is known", () => {
    resolveVaultId();

    expect(requests).toEqual(["/api/vault/info"]);
    expect(globalThis.__currentVaultId).toBe("Abra");
  });

  it("leaves the id empty when the server has no vault", () => {
    infoStatus = 404;
    resolveVaultId();

    expect(globalThis.__currentVaultId).toBe("");
  });
});
