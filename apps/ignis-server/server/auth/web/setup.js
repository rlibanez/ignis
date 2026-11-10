(() => {
var translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  const form = document.getElementById("setup-form");
  const status = document.getElementById("status");
  const button = form.querySelector('button[type="submit"]');
  const field = (name) => form.elements.namedItem(name);
  for (const toggle of document.querySelectorAll(".setup-help-toggle")) {
    const tip = document.getElementById(toggle.getAttribute("aria-controls"));
    const region = toggle.parentElement;
    const show = (open) => {
      tip.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) toggle.setAttribute("aria-describedby", tip.id);
      else toggle.removeAttribute("aria-describedby");
    };
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
  const clearSecrets = () => {
    for (const name of ["initialAdminKey", "password", "passwordConfirmation"])
      field(name).value = "";
  };
  async function refresh() {
    form.hidden = true;
    try {
      const response = await fetch("/api/auth/status", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const state = await response.json();
      if (state.initialized) {
        location.replace("/login");
        return;
      } else if (!state.setupAvailable) {
        status.textContent =
          translateIgnis("Web setup is disabled. Ask the server operator to configure an installation key or create the first administrator using the local CLI.");
      } else {
        status.textContent =
          translateIgnis("Your vaults remain locked until setup and authentication are complete.");
        const policy = state.passwordPolicy;
        field("password").minLength = policy.minLength;
        field("passwordConfirmation").minLength = policy.minLength;
        document.getElementById("password-help").textContent =
          translateIgnis("Use at least {p0} characters.", {p0: (policy.minLength)}) +
          (policy.minSpecialChars
            ? translateIgnis(" Include at least {p0} punctuation or symbol characters (for example ! or *). Spaces do not count as symbols.", {p0: (policy.minSpecialChars)})
            : translateIgnis(" No special characters are required."));
        form.hidden = false;
        if (globalThis.IgnisUiEnvironment?.mobile(window) && document.activeElement === document.body) {
          field("initialAdminKey").focus();
        }
      }
    } catch {
      status.textContent =
        translateIgnis("Unable to check installation status. Reload this page to try again.");
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    if (field("password").value !== field("passwordConfirmation").value) {
      status.textContent = translateIgnis("The passwords do not match.");
      field("passwordConfirmation").focus();
      return;
    }
    button.disabled = true;
    status.textContent = translateIgnis("Creating administrator…");
    try {
      const challenge = await fetch("/api/auth/csrf", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!challenge.ok) throw new Error();
      const { csrfToken } = await challenge.json();
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Ignis-Csrf": csrfToken,
        },
        body: JSON.stringify({
          initialAdminKey: field("initialAdminKey").value,
          login: field("login").value,
          password: field("password").value,
          passwordConfirmation: field("passwordConfirmation").value,
        }),
      });
      if (response.status === 201 || response.status === 409) {
        clearSecrets();
        if (response.status === 201) location.replace("/login");
        else await refresh();
      } else {
        status.textContent =
          response.status === 429
            ? translateIgnis("Too many attempts or server busy. Wait before trying again.")
            : response.status === 400
              ? translateIgnis("Check the username and password requirements and try again.")
              : translateIgnis("Setup was rejected. Check the installation key and reload the page before trying again.");
      }
    } catch {
      status.textContent =
        translateIgnis("Setup could not be confirmed. Reload to check whether it completed before trying again.");
    } finally {
      clearSecrets();
      button.disabled = false;
    }
  });
  window.addEventListener("pagehide", clearSecrets);
  refresh();
})();
