function mountLogin() {
  const document = globalThis.document;
  const window = globalThis.window;
  const location = globalThis.location;
  const fetch = globalThis.fetch;
  const BroadcastChannel = globalThis.BroadcastChannel;
var translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  let providerName = "OpenID Connect";
  function setProviderName(name) {
    providerName = name || "OpenID Connect";
    for (const element of document.querySelectorAll("[data-provider-template]"))
      element.textContent = translateIgnis(element.dataset.providerTemplate).replaceAll("OpenID Connect", () => providerName);
  }

  const form = document.getElementById("login-form");
  const status = document.getElementById("status");
  const button = form.querySelector('button[type="submit"]');
  const oidcButton = document.getElementById("oidc-sign-in");
  let activeSessionId = null;
  const requested = new URL(location.href).searchParams.get("reauth");
  const intent = ["users", "link"].includes(requested) ? requested : null;
  const destination = value => value === "users" ? "/?manage=users" : "/?manage=account";
  const rateLimitMessage = "Too many requests or sign-in attempts. Access is temporarily limited. Wait before trying again and avoid repeatedly reloading the page.";
  async function beginOidc() {
    if (oidcButton.disabled) return;
    oidcButton.disabled = true;
    status.classList.remove("auth-error");
    status.textContent = translateIgnis("Preparing secure sign-in…");
    try {
      channel?.postMessage("lock");
      const response = await window.ignisOidcStart({
        clear: signal=>clearBrowserData(signal,true),
        request: signal => {
          status.textContent = translateIgnis("Connecting to {p0}…", {p0: (providerName)});
          return request("/api/auth/oidc/start", {rememberMe: document.getElementById("remember-me").checked}, signal);
        },
      });
      if (response.status === 429) {
        status.classList.add("auth-error");
        status.textContent = translateIgnis(rateLimitMessage);
        oidcButton.disabled = false;
        return;
      }
      if (!response.ok) throw new Error();
      if (intent) sessionStorage.setItem("ignis-reauth-return", intent);
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
      oidcButton.disabled = false;
    }
  }
  oidcButton.addEventListener("click", () => beginOidc());
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
  async function clearBrowserData(signal, forSignIn=false) {
    signal?.throwIfAborted();
    localStorage.clear();
    sessionStorage.clear();
    window.IgnisI18n?.rememberLanguage({forSignIn});
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
      await clearBrowserData(undefined,true);
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
      else location.replace("/");
    } catch {
      showLoginError(translateIgnis("Unable to sign in. Close other Ignis tabs and try again."));
    } finally {
      form.elements.password.value = "";
      button.disabled = false;
    }
  });
  async function start() {
    try {
      const response=await fetch("/api/auth/status",{cache:"no-store"});
      if(response.status===429){status.textContent=translateIgnis(rateLimitMessage);return;}
      if(!response.ok)throw new Error();
      const installation=await response.json();
      if(!installation.initialized){location.replace("/setup");return;}
      oidcButton.hidden=installation.oidcAvailable!==true;
      setProviderName(installation.oidcButtonText);
      const outcome=new URL(location.href).searchParams.get("oidc");
      const returnIntent=outcome==="success" ? sessionStorage.getItem("ignis-reauth-return") : null;
      sessionStorage.removeItem("ignis-reauth-return");
      if(outcome)history.replaceState(null,"",location.pathname);
      if(["success","linked"].includes(outcome)){channel?.postMessage("lock");await clearBrowserData(undefined,true);}
      const current=await fetch("/api/auth/session",{cache:"no-store",credentials:"same-origin"});
      if(current.ok){
        const session=await current.json();
        window.IgnisI18n?.useAccount(session.user.id);activeSessionId=session.sessionId;
        if(outcome==="success" && ["users","link"].includes(returnIntent)){location.replace(destination(returnIntent));return;}
        if(!intent || outcome==="success"){location.replace("/");return;}
        form.elements.login.value=session.user.login;
      }else if(current.status!==401){status.textContent=translateIgnis("Unable to check your session. Reload or sign in again.");return;}
      form.hidden=false;
      status.textContent=new URL(location.href).searchParams.get("password")==="changed"
        ? translateIgnis("Password changed. All Ignis sessions have been closed. Sign in with your new password.") : "";
      if(outcome==="failed")status.textContent=translateIgnis("{p0} sign-in failed. Please start again or contact your administrator.",{p0:providerName});
      if(intent && outcome!=="failed"){
        status.textContent=translateIgnis(intent==="users" ? "Confirm your identity to manage users. You will return to Users after signing in." : "Sign in again before linking your {p0} account.",{p0:providerName});
        document.querySelector("h1").textContent=translateIgnis("Sign in again");button.textContent=translateIgnis("Sign in again");
      }
    }catch{status.textContent=translateIgnis("Unable to check installation. Reload to try again.");}
  }
  window.addEventListener("pagehide",()=>{form.elements.password.value="";channel?.close();});
  start();
}
if (globalThis.document) mountLogin();
