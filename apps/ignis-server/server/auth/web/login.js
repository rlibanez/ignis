(() => {
  let providerName = "OpenID Connect";
  function setProviderName(name) {
    providerName = name || "OpenID Connect";
    for (const element of document.querySelectorAll("[data-provider-template]"))
      element.textContent = element.dataset.providerTemplate.replaceAll("OpenID Connect", () => providerName);
  }

  const form = document.getElementById("login-form");
  const status = document.getElementById("status");
  const logout = document.getElementById("sign-out");
  const button = form.querySelector('button[type="submit"]');
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
  const rateLimitMessage = "Too many requests or sign-in attempts. Access is temporarily limited. Wait before trying again and avoid repeatedly reloading the page.";
  async function beginOidc(link) {
    oidcButton.disabled = linkButton.disabled = true;
    try {
      channel?.postMessage("lock");
      await clearBrowserData();
      const response = await request(
        link ? "/api/auth/oidc/link" : "/api/auth/oidc/start",
        {},
      );
      if (response.status === 429) {
        status.textContent = rateLimitMessage;
        oidcButton.disabled = linkButton.disabled = false;
        return;
      }
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
        : `Unable to start ${providerName} sign-in. Please try again later.`;
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
    if (csrf.status === 429) return csrf;
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
  const loginError = document.getElementById("login-error");
  function clearLoginError() {
    loginError.hidden = true;
    loginError.textContent = "";
    form.elements.password.removeAttribute("aria-invalid");
    form.elements.password.removeAttribute("aria-describedby");
  }
  function showLoginError(message, credentials = false) {
    clearLoginError();
    const field = form.elements.password;
    const anchor = credentials ? field.parentElement : form.querySelector(".login-submit");
    anchor.append(loginError);
    loginError.textContent = message;
    loginError.hidden = false;
    if (credentials) {
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", "login-error");
      field.focus();
    }
  }
  form.addEventListener("input", clearLoginError);
  form.addEventListener("reset", clearLoginError);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearLoginError();
    button.disabled = true;
    try {
      channel?.postMessage("lock");
      await clearBrowserData();
      const response = await request("/api/auth/login", {
        login: form.elements.login.value,
        password: form.elements.password.value,
      });
      if (!response.ok) {
        showLoginError(response.status === 429 ? rateLimitMessage
          : response.status === 401 ? "Incorrect username or password."
            : "Unable to sign in. Please try again later.", response.status === 401);
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
      showLoginError("Unable to sign in. Close other Ignis tabs and try again.");
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
    let installationChecked = false;
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      if (response.status === 429) {
        status.textContent = "Too many requests. Wait one minute before reloading this page. Your account has not been disabled.";
        return;
      }
      if (!response.ok) throw new Error();
      const installation = await response.json();
      if (!installation.initialized) {
        location.replace("/setup");
        return;
      }
      installationChecked = true;
      form.hidden = accountPage;
      oidcAvailable = installation.oidcAvailable === true;
      oidcButton.hidden = !oidcAvailable;
      setProviderName(installation.oidcButtonText);
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
        document.getElementById("change-password").hidden = !accountPage || !session.hasLocalPassword;
        document.getElementById("password-policy").textContent =
          `At least ${session.passwordPolicy.minLength} characters, including ${session.passwordPolicy.minSpecialChars} punctuation or symbol characters.`;
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
          session.user.login;
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
        status.textContent =
          session.user.role === "admin"
            ? accountPage ? "" : "You are signed in."
            : "Signed in. Vault access for non-administrator accounts is not available yet.";
      } else if (current.status === 401) {
        if (accountPage) {
          location.replace("/login");
          return;
        }
        status.textContent = new URL(location.href).searchParams.get("password") === "changed"
          ? "Password changed. All Ignis sessions have been closed. Sign in with your new password."
          : "Enter your Ignis account credentials.";
      }
      else {
        status.textContent = current.status === 429
          ? "Too many requests. Wait one minute before trying again. Avoid repeatedly reloading the page."
          : "Unable to check your session. Reload or sign in again.";
        return;
      }
      if (outcome === "failed")
        status.textContent =
          `${providerName} sign-in failed. Please start again or contact your administrator.`;
      if (intent && outcome !== "failed") {
        status.textContent = intent === "users"
          ? "Sign in again to manage users. You will return to user management afterwards."
          : `Sign in again before linking your ${providerName} account.`;
        document.querySelector("h1").textContent = "Sign in again";
      }
      form.hidden = accountPage;
      if (accountPage) oidcButton.hidden = true;
    } catch {
      status.textContent = installationChecked
        ? "Unable to check your session. Reload or sign in again."
        : "Unable to check installation. Reload to try again.";
    }
  }
  const passwordForm = document.getElementById("password-form");
  const passwordStatus = document.getElementById("password-status");
  function clearPasswordErrors() {
    for (const field of passwordForm.querySelectorAll("input")) {
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-describedby");
    }
    passwordStatus.hidden = true;
    passwordStatus.textContent = "";
  }
  function showPasswordError(message, fieldName) {
    clearPasswordErrors();
    const field = fieldName ? passwordForm.elements[fieldName] : null;
    const anchor = field ? field.parentElement : passwordForm.querySelector(".password-actions");
    anchor.append(passwordStatus);
    passwordStatus.textContent = message;
    passwordStatus.hidden = false;
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", "password-status");
      field.focus();
    }
  }
  function clearPasswordFields() { passwordForm.reset(); }
  passwordForm.addEventListener("input", clearPasswordErrors);
  const passwordDialog = document.getElementById("password-dialog");
  const passwordCancel = document.getElementById("cancel-password");
  document.getElementById("change-password").addEventListener("click", () => {
    clearPasswordFields();
    clearPasswordErrors();
    passwordDialog.showModal();
    passwordForm.elements.currentPassword.focus();
  });
  passwordCancel.addEventListener("click", () => passwordDialog.close());
  passwordDialog.addEventListener("close", clearPasswordFields);
  passwordDialog.addEventListener("cancel", (event) => {
    if (passwordCancel.disabled) event.preventDefault();
  });
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = passwordForm.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    clearPasswordErrors();
    if (passwordForm.elements.newPassword.value !== passwordForm.elements.confirmation.value) {
      showPasswordError("New passwords do not match.", "confirmation");
      return;
    }
    submit.disabled = passwordCancel.disabled = true;
    let preserveNewPassword = false;
    try {
      const response = await request("/api/auth/password", {
        currentPassword: passwordForm.elements.currentPassword.value,
        newPassword: passwordForm.elements.newPassword.value,
      });
      if (!response.ok) {
        const failure = await response.json();
        if (response.status === 400 && failure.code === "INVALID_PASSWORD") {
          preserveNewPassword = true;
          passwordForm.elements.currentPassword.value = "";
          showPasswordError("The current password is incorrect.", "currentPassword");
        } else {
          showPasswordError(response.status === 429 ? rateLimitMessage
            : response.status === 400 ? failure.error
              : "Unable to change your password. Sign in again before retrying.",
            ["PASSWORD_POLICY", "PASSWORD_UNCHANGED"].includes(failure.code) ? "newPassword" : null);
        }
        return;
      }
      channel?.postMessage("lock");
      try { await clearBrowserData(); } catch { /* Server sessions are already revoked. */ }
      location.replace("/login?password=changed");
    } catch {
      showPasswordError("The change could not be confirmed. Sign in again before retrying.");
    } finally {
      if (!preserveNewPassword) clearPasswordFields();
      submit.disabled = passwordCancel.disabled = false;
    }
  });
  window.addEventListener("pagehide", clearPasswordFields);
  window.addEventListener("pagehide", () => {
    form.elements.password.value = "";
  });
  start();
})();
