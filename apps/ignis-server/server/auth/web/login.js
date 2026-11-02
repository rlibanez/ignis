function mountLogin(scope = {}) {
  const document = scope.document ?? globalThis.document;
  const window = scope.window ?? globalThis.window;
  const location = scope.location ?? globalThis.location;
  const fetch = scope.fetch ?? globalThis.fetch;
  const BroadcastChannel = scope.BroadcastChannel ?? globalThis.BroadcastChannel;
var translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  let providerName = "OpenID Connect";
  function setProviderName(name) {
    providerName = name || "OpenID Connect";
    for (const element of document.querySelectorAll("[data-provider-template]"))
      element.textContent = translateIgnis(element.dataset.providerTemplate).replaceAll("OpenID Connect", () => providerName);
  }

  const form = document.getElementById("login-form");
  const status = document.getElementById("status");
  const logout = document.getElementById("sign-out");
  const button = form.querySelector('button[type="submit"]');
  const oidcButton = document.getElementById("oidc-sign-in");
  const linkButton = document.getElementById("link-oidc");
  const accountPage = location.pathname === "/account";
  let oidcAvailable = false, activeSessionId = null, settingLocalPassword = false;
  const requested = new URL(location.href).searchParams.get("reauth");
  const intent = ["users", "link"].includes(requested) ? requested : null;
  const destination = (value) => value === "users" ? "/admin/users" : "/account";
  const reauthDialog = document.getElementById("reauth-dialog");
  document.getElementById("cancel-reauth").addEventListener("click", () => reauthDialog.close());
  if (accountPage) {
    document.body.classList.add("account-page");
    for (const category of document.querySelectorAll("[data-account-section]")) {
      category.addEventListener("click", () => {
        for (const item of document.querySelectorAll("[data-account-section]")) {
          const selected = item === category;
          item.setAttribute("aria-pressed", String(selected));
          document.getElementById("account-" + item.dataset.accountSection).hidden = !selected;
        }
      });
    }
    if (location.hash === "#account-security") document.querySelector('[data-account-section="security"]')?.click();
    document.title = translateIgnis("Account – Ignis");
    document.querySelector("title").setAttribute("data-i18n", translateIgnis("Account – Ignis"));
    document.querySelector("h1").textContent = translateIgnis("Account");
    document.querySelector("h1").setAttribute("data-i18n", translateIgnis("Account"));
  }
  const rateLimitMessage = "Too many requests or sign-in attempts. Access is temporarily limited. Wait before trying again and avoid repeatedly reloading the page.";
  async function beginOidc(link) {
    if (oidcButton.disabled || linkButton.disabled) return;
    oidcButton.disabled = linkButton.disabled = true;
    status.classList.remove("auth-error");
    status.textContent = translateIgnis("Preparing secure sign-in…");
    try {
      channel?.postMessage("lock");
      const response = await window.ignisOidcStart({
        clear: clearBrowserData,
        request: signal => {
          status.textContent = translateIgnis("Connecting to {p0}…", {p0: (providerName)});
          return request(link ? "/api/auth/oidc/link" : "/api/auth/oidc/start", link ? {} : {rememberMe: document.getElementById("remember-me").checked}, signal);
        },
      });
      if (response.status === 429) {
        status.classList.add("auth-error");
        status.textContent = translateIgnis(rateLimitMessage);
        oidcButton.disabled = linkButton.disabled = false;
        return;
      }
      if (response.status === 403 &&
          response.body.code === "REAUTH_REQUIRED") {
        oidcButton.disabled = linkButton.disabled = false;
        status.textContent = translateIgnis("Confirm your identity before linking your account.");
        reauthDialog.showModal();
        return;
      }
      if (!response.ok) throw new Error();
      if (!link && intent) sessionStorage.setItem("ignis-reauth-return", intent);
      const url = new URL(response.body.authorizationUrl);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error();
      location.assign(url.href);
    } catch (error) {
      status.classList.add("auth-error");
      status.textContent = error.stage === "storage"
        ? translateIgnis("Browser data cleanup did not complete. Close other Ignis tabs, reload this page and try again. No sign-in request was sent.")
        : error.code === "OIDC_START_TIMEOUT"
          ? translateIgnis("The sign-in request timed out. Ignis or {p0} did not respond in time. Please try again later.", {p0: (providerName)})
          : translateIgnis("Unable to start {p0} sign-in. Please try again later.", {p0: (providerName)});
    } finally {
      oidcButton.disabled = linkButton.disabled = false;
    }
  }
  oidcButton.addEventListener("click", () => beginOidc(false));
  linkButton.addEventListener("click", () => beginOidc(true));
  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel("ignis-auth")
      : null;
  async function request(path, body, signal) {
    const csrf = await fetch("/api/auth/csrf", {
      signal,
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrf.status === 429) return csrf;
    if (!csrf.ok) throw new Error();
    const csrfToken = (await csrf.json()).csrfToken;
    signal?.throwIfAborted();
    return fetch(path, {
      signal,
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Ignis-Csrf": csrfToken,
        ...(activeSessionId ? {"X-Ignis-Context": activeSessionId} : {}),
      },
      body: JSON.stringify(body),
    });
  }
  async function clearBrowserData(signal) {
    signal?.throwIfAborted();
    localStorage.clear();
    sessionStorage.clear();
    if (window.caches)
      await Promise.all((await caches.keys()).map((key) => { signal?.throwIfAborted(); return caches.delete(key); }));
    signal?.throwIfAborted();
    if (window.indexedDB?.databases)
      for (const { name } of await indexedDB.databases()) {
        signal?.throwIfAborted();
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
        rememberMe: document.getElementById("remember-me").checked,
      });
      if (!response.ok) {
        showLoginError(response.status === 429 ? rateLimitMessage
          : response.status === 401 ? translateIgnis("Incorrect username or password.")
            : translateIgnis("Unable to sign in. Please try again later."), response.status === 401);
        return;
      }
      const session = await response.json();
      if (session.passwordResetRequired) { location.replace("/reset-password"); return; }
      if (intent) location.replace(destination(intent));
      else if (accountPage) location.replace("/account");
      else location.replace("/");
    } catch {
      showLoginError(translateIgnis("Unable to sign in. Close other Ignis tabs and try again."));
    } finally {
      form.elements.password.value = "";
      button.disabled = false;
    }
  });
  let logoutConfirmed = false;
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      if (!logoutConfirmed) {
        const response = await request("/api/auth/logout", {});
        if (!response.ok) throw new Error();
        logoutConfirmed = true;
        channel?.postMessage("lock");
        document.getElementById("account").hidden = true;
        document.getElementById("manage-account").hidden = true;
        form.hidden = oidcButton.hidden = linkButton.hidden = true;
      }
      await clearBrowserData();
      location.replace("/login");
    } catch {
      status.classList.add("auth-error");
      status.textContent = logoutConfirmed
        ? translateIgnis("You are signed out. Close other Ignis tabs, then retry cleanup to remove this account's local browser data.")
        : translateIgnis("Unable to confirm sign-out. Please try again.");
      logout.textContent = logoutConfirmed ? translateIgnis("Retry cleanup") : translateIgnis("Sign out");
      logout.disabled = false;
    }
  });
  async function start() {
    let installationChecked = false;
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      if (response.status === 429) {
        status.textContent = translateIgnis("Too many requests. Wait one minute before reloading this page. Your account has not been disabled.");
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
        window.IgnisI18n?.useAccount(session.user.id);
        setProviderName(installation.oidcButtonText);
        activeSessionId = session.sessionId;
        settingLocalPassword = !session.hasLocalPassword;
        document.getElementById("change-password").hidden = !accountPage || !session.hasLocalPassword;
        document.getElementById("set-own-password").hidden = !accountPage || session.hasLocalPassword || !session.oidcLinked || !oidcAvailable;
        if(accountPage && settingLocalPassword && session.oidcLinked && new URL(location.href).searchParams.get("password") === "setup") {
          history.replaceState(null, "", "/account");
          openPasswordDialog();
        }
        document.getElementById("password-policy").textContent =
          translateIgnis("At least {p0} characters, including {p1} punctuation or symbol characters.", {p0: (session.passwordPolicy.minLength), p1: (session.passwordPolicy.minSpecialChars)});
        if (intent) form.elements.login.value = session.user.login;
        if (outcome === "success" && ["users", "link"].includes(returnIntent)) {
          location.replace(destination(returnIntent));
          return;
        }
        if (outcome === "success") {
          location.replace("/");
          return;
        }
        logout.hidden = false;
        document.getElementById("manage-account").hidden = accountPage;
        document.getElementById("account").hidden = !accountPage;
        document.getElementById("account-status").textContent =
          session.user.login;
        document.getElementById("open-ignis").hidden = false;
        document.getElementById("manage-users").hidden = session.user.role !== "admin";
        linkButton.hidden =
          !accountPage || !oidcAvailable || session.oidcLinked;
        linkButton.disabled = false;
        if (accountPage) {
          form.elements.login.value = session.user.login;
          button.textContent = translateIgnis("Sign in again");
        }
        status.textContent =
          accountPage ? "" : translateIgnis("You are signed in.");
      } else if (current.status === 401) {
        if (accountPage) {
          location.replace("/login");
          return;
        }
        status.textContent = new URL(location.href).searchParams.get("password") === "changed"
          ? translateIgnis("Password changed. All Ignis sessions have been closed. Sign in with your new password.")
          : "";
      }
      else {
        status.textContent = current.status === 429
          ? translateIgnis("Too many requests. Wait one minute before trying again. Avoid repeatedly reloading the page.")
          : translateIgnis("Unable to check your session. Reload or sign in again.");
        return;
      }
      if (outcome === "failed")
        status.textContent =
          translateIgnis("{p0} sign-in failed. Please start again or contact your administrator.", {p0: (providerName)});
      if (intent && outcome !== "failed") {
        status.textContent = intent === "users"
          ? translateIgnis("Confirm your identity to manage users. You will return to Users after signing in.")
          : translateIgnis("Sign in again before linking your {p0} account.", {p0: (providerName)});
        document.querySelector("h1").textContent = translateIgnis("Sign in again");
        button.textContent = translateIgnis("Sign in again");
      }
      form.hidden = accountPage;
      if (accountPage) oidcButton.hidden = true;
    } catch {
      status.textContent = installationChecked
        ? translateIgnis("Unable to check your session. Reload or sign in again.")
        : translateIgnis("Unable to check installation. Reload to try again.");
    }
  }
  for (const toggle of document.querySelectorAll(".setup-help-toggle")) {
    const tip = document.getElementById(toggle.getAttribute("aria-controls"));
    const region = toggle.parentElement;
    const show = (open) => {
      tip.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) toggle.setAttribute("aria-describedby", tip.id);
      else toggle.removeAttribute("aria-describedby");
    };
    toggle.closest("dialog")?.addEventListener("close", () => show(false));
    toggle.addEventListener("click", () => show(true));
    region.addEventListener("mouseenter", () => show(true));
    region.addEventListener("mouseleave", () => show(false));
    region.addEventListener("focusout", (event) => {
      if (!region.contains(event.relatedTarget)) show(false);
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); show(false); }
    });
    document.addEventListener("click", (event) => {
      if (!region.contains(event.target)) show(false);
    });
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
  document.getElementById("set-own-password").addEventListener("click", async event => {
    const control = event.currentTarget;
    control.disabled = true;
    status.textContent = translateIgnis("Confirm your identity with your linked provider before setting a local password.");
    try {
      channel?.postMessage("lock");
      const response = await window.ignisOidcStart({clear: clearBrowserData,
        request: signal => request("/api/auth/oidc/reauth", {purpose:"password"}, signal)});
      if(!response.ok) throw new Error();
      const url = new URL(response.body.authorizationUrl);
      if(url.protocol !== "https:" || url.username || url.password) throw new Error();
      location.assign(url.href);
    } catch {
      status.classList.add("auth-error");
      status.textContent = translateIgnis("Unable to start {p0} sign-in. Please try again later.", {p0:providerName});
    } finally { control.disabled = false; }
  });
  function openPasswordDialog() {
    clearPasswordFields();
    clearPasswordErrors();
    const caption = settingLocalPassword ? "Set local password" : "Change password";
    for(const element of [document.getElementById("password-heading"), passwordForm.querySelector('button[type="submit"]')]) {
      element.setAttribute("data-i18n", caption);element.textContent = translateIgnis(caption);
    }
    document.getElementById("change-password-help").hidden = settingLocalPassword;
    document.getElementById("set-password-help").hidden = !settingLocalPassword;
    passwordForm.elements.currentPassword.required = !settingLocalPassword;
    passwordForm.elements.currentPassword.disabled = settingLocalPassword;
    passwordForm.elements.currentPassword.parentElement.hidden = settingLocalPassword;
    passwordForm.querySelector('label[for="current-password"]').hidden = settingLocalPassword;
    passwordDialog.showModal();
    passwordForm.elements[settingLocalPassword ? "newPassword" : "currentPassword"].focus();
  }
  document.getElementById("change-password").addEventListener("click", openPasswordDialog);
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
      showPasswordError(translateIgnis("New passwords do not match."), "confirmation");
      return;
    }
    submit.disabled = passwordCancel.disabled = true;
    let preserveNewPassword = false;
    try {
      const response = await request("/api/auth/password", {
        ...(settingLocalPassword ? {} : {currentPassword: passwordForm.elements.currentPassword.value}),
        newPassword: passwordForm.elements.newPassword.value,
      });
      if (!response.ok) {
        const failure = await response.json();
        if (response.status === 400 && failure.code === "INVALID_PASSWORD") {
          preserveNewPassword = true;
          passwordForm.elements.currentPassword.value = "";
          showPasswordError(translateIgnis("The current password is incorrect."), "currentPassword");
        } else {
          showPasswordError(response.status === 429 ? rateLimitMessage
            : response.status === 400 ? failure.error
              : translateIgnis("Unable to change your password. Sign in again before retrying."),
            ["PASSWORD_POLICY", "PASSWORD_UNCHANGED"].includes(failure.code) ? "newPassword" : null);
        }
        return;
      }
      channel?.postMessage("lock");
      try { await clearBrowserData(); } catch { /* Server sessions are already revoked. */ }
      location.replace("/login?password=changed");
    } catch {
      showPasswordError(translateIgnis("The change could not be confirmed. Sign in again before retrying."));
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
}
globalThis.IgnisManagementControllers ??= {};
globalThis.IgnisManagementControllers["login"] = mountLogin;
if (globalThis.document && !globalThis.window?.__ignisAuth) mountLogin();
