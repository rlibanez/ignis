(() => {
  const form = document.getElementById("login-form");
  const status = document.getElementById("status");
  const logout = document.getElementById("sign-out");
  const button = form.querySelector("button");
  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel("ignis-auth")
      : null;
  async function request(path, body) {
    const csrf = await fetch("/api/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!csrf.ok) throw new Error();
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Ignis-Csrf": (await csrf.json()).csrfToken,
      },
      body: JSON.stringify(body),
    });
  }
  async function clearBrowserData() {
    localStorage.clear();
    sessionStorage.clear();
    if (window.caches)
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
    if (window.indexedDB?.databases)
      for (const { name } of await indexedDB.databases()) {
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = resolve;
          request.onerror = reject;
          request.onblocked = reject;
        });
      }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      channel?.postMessage("lock");
      await clearBrowserData();
      const response = await request("/api/auth/login", {
        login: form.elements.login.value,
        password: form.elements.password.value,
      });
      if (!response.ok) {
        status.textContent =
          response.status === 429
            ? "Too many attempts. Wait before trying again."
            : "Sign-in failed. Check your credentials and try again.";
        return;
      }
      const session = await response.json();
      if (session.user.role === "admin") location.replace("/");
      else {
        form.hidden = true;
        logout.hidden = false;
        status.textContent =
          "Signed in. Vault access for non-administrator accounts is not available yet.";
      }
    } catch {
      status.textContent =
        "Unable to sign in. Close other Ignis tabs and try again.";
    } finally {
      form.elements.password.value = "";
      button.disabled = false;
    }
  });
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      const response = await request("/api/auth/logout", {});
      if (!response.ok) throw new Error();
      channel?.postMessage("lock");
      await clearBrowserData();
      location.replace("/login");
    } catch {
      status.textContent = "Unable to sign out. Please try again.";
      logout.disabled = false;
    }
  });
  async function start() {
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      if (!response.ok) throw new Error();
      if (!(await response.json()).initialized) {
        location.replace("/setup");
        return;
      }
      status.textContent = "Enter your Ignis account credentials.";
      form.hidden = false;
    } catch {
      status.textContent = "Unable to check installation. Reload to try again.";
    }
  }
  window.addEventListener("pagehide", () => {
    form.elements.password.value = "";
  });
  start();
})();
