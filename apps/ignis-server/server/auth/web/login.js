(() => {
  const form = document.getElementById("login-form");
  const status = document.getElementById("status");
  const logout = document.getElementById("sign-out");
  const button = form.querySelector("button");
  const oidcButton = document.getElementById("oidc-sign-in");
  const linkButton = document.getElementById("link-oidc");
  const accountPage = location.pathname === "/account";
  let oidcAvailable = false;
  const requested = new URL(location.href).searchParams.get("reauth");
  const intent = ["users", "link"].includes(requested) ? requested : null;
  const destination = (value) => value === "users" ? "/admin/users" : "/account";
  const reauthDialog = document.getElementById("reauth-dialog");
  document.getElementById("cancel-reauth").addEventListener("click", () => reauthDialog.close());
  if (accountPage) {
    document.body.classList.add("account-page");
    document.title = "Account – Ignis";
    document.querySelector("h1").textContent = "Account";
  }
  async function beginOidc(link) {
    oidcButton.disabled = linkButton.disabled = true;
    try {
      channel?.postMessage("lock");
      await clearBrowserData();
      const response = await request(
        link ? "/api/auth/oidc/link" : "/api/auth/oidc/start",
        {},
      );
      if (response.status === 403 &&
          (await response.clone().json()).code === "REAUTH_REQUIRED") {
        oidcButton.disabled = linkButton.disabled = false;
        reauthDialog.showModal();
        return;
      }
      if (!response.ok) throw new Error();
      if (!link && intent) sessionStorage.setItem("ignis-reauth-return", intent);
      const url = new URL((await response.json()).authorizationUrl);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error();
      location.assign(url.href);
    } catch {
      status.textContent = link
        ? "Unable to link. Sign in again and retry."
        : "Unable to start OpenID Connect sign-in. Please try again later.";
      oidcButton.disabled = linkButton.disabled = false;
    }
  }
  oidcButton.addEventListener("click", () => beginOidc(false));
  linkButton.addEventListener("click", () => beginOidc(true));
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
      if (intent) location.replace(destination(intent));
      else if (accountPage) location.replace("/account");
      else if (session.user.role === "admin") location.replace("/");
      else {
        form.hidden = true;
        logout.hidden = false;
        document.getElementById("manage-account").hidden = false;
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
      const installation = await response.json();
      if (!installation.initialized) {
        location.replace("/setup");
        return;
      }
      oidcAvailable = installation.oidcAvailable === true;
      oidcButton.hidden = !oidcAvailable;
      oidcButton.textContent = installation.oidcButtonText || "Sign in with OpenID Connect";
      const outcome = new URL(location.href).searchParams.get("oidc");
      const returnIntent = outcome === "success" ? sessionStorage.getItem("ignis-reauth-return") : null;
      sessionStorage.removeItem("ignis-reauth-return");
      if (outcome) history.replaceState(null, "", location.pathname);
      if (["success", "linked"].includes(outcome)) {
        channel?.postMessage("lock");
        await clearBrowserData();
      }
      const current = await fetch("/api/auth/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (current.ok) {
        const session = await current.json();
        if (intent) form.elements.login.value = session.user.login;
        if (outcome === "success" && ["users", "link"].includes(returnIntent)) {
          location.replace(destination(returnIntent));
          return;
        }
        if (outcome === "success" && session.user.role === "admin") {
          location.replace("/");
          return;
        }
        logout.hidden = false;
        document.getElementById("manage-account").hidden = accountPage;
        document.getElementById("account").hidden = !accountPage;
        document.getElementById("account-status").textContent =
          `Signed in as ${session.user.login}.`;
        document.getElementById("open-ignis").hidden =
          session.user.role !== "admin";
        document.getElementById("manage-users").hidden = session.user.role !== "admin";
        linkButton.hidden =
          !accountPage || !oidcAvailable || session.oidcLinked;
        linkButton.disabled = false;
        if (accountPage) {
          form.elements.login.value = session.user.login;
          button.textContent = "Sign in again";
        }
        document.getElementById("link-help").textContent = session.canLinkOidc
          ? "You will authenticate with your identity provider to link this account."
          : "Sign in again before linking. You will also authenticate with your identity provider.";
        document.getElementById("link-help").hidden = linkButton.hidden;
        status.textContent =
          session.user.role === "admin"
            ? accountPage ? "" : "You are signed in."
            : "Signed in. Vault access for non-administrator accounts is not available yet.";
      } else if (current.status === 401) {
        if (accountPage) {
          location.replace("/login");
          return;
        }
        status.textContent = "Enter your Ignis account credentials.";
      }
      else throw new Error();
      if (outcome === "failed")
        status.textContent =
          "OpenID Connect sign-in failed. Please start again or contact your administrator.";
      if (intent && outcome !== "failed") {
        status.textContent = intent === "users"
          ? "Sign in again to create users. You will return to user management afterwards."
          : "Sign in again before linking your OpenID Connect account.";
        document.querySelector("h1").textContent = "Sign in again";
      }
      form.hidden = accountPage;
      if (accountPage) oidcButton.hidden = true;
    } catch {
      status.textContent = "Unable to check installation. Reload to try again.";
    }
  }
  window.addEventListener("pagehide", () => {
    form.elements.password.value = "";
  });
  start();
})();
