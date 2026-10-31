(() => {
var translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  const form = document.getElementById("reset-form");
  const submit = form.querySelector('button[type="submit"]');
  const status = document.getElementById("reset-status");
  const error = (field, message) => { field.setCustomValidity(message); field.reportValidity(); };
  for (const input of form.querySelectorAll("input")) input.addEventListener("input", () => {
    for (const field of form.querySelectorAll("input")) field.setCustomValidity("");
  });
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
  const request = (url, options = {}) => fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
  let context;
  request("/api/auth/reset-password").then(async response => {
    if (!response.ok) { location.replace("/login"); return; }
    const data = await response.json();
    context = data.context;
    status.textContent = "";
    document.getElementById("policy").textContent = translateIgnis("Password: at least {p0} characters and {p1} punctuation/symbol characters.", {p0: (data.passwordPolicy.minLength), p1: (data.passwordPolicy.minSpecialChars)});
    form.hidden = false;
    form.elements.password.focus();
  }).catch(() => { status.textContent = translateIgnis("Unable to check authorization. Return to sign in and try again."); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submit.disabled || !context) return;
    if (form.elements.password.value !== form.elements.confirmation.value) {
      error(form.elements.confirmation, translateIgnis("Passwords do not match.")); return;
    }
    submit.disabled = true;
    try {
      const csrf = await request("/api/auth/csrf");
      if (!csrf.ok) throw new Error();
      const response = await request("/api/auth/reset-password", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Ignis-Csrf": (await csrf.json()).csrfToken, "X-Ignis-Reset-Context": context },
        body: JSON.stringify({ password: form.elements.password.value }),
      });
      const result = await response.json();
      if (!response.ok) {
        error(form.elements.password,
          response.status === 429 ? translateIgnis("Too many attempts. Wait before trying again.") : result.code === "PASSWORD_UNCHANGED" ? translateIgnis("Choose a password different from your current password.") : result.code === "PASSWORD_POLICY"
            ? translateIgnis("The new password does not meet the password policy.") : translateIgnis("Password reset authorization has expired or changed. Sign in again with your current password, or ask your administrator for a new temporary password."));
        return;
      }
      form.reset(); form.hidden = true;
      if (typeof BroadcastChannel === "function") { const channel = new BroadcastChannel("ignis-auth"); channel.postMessage("lock"); channel.close(); }
      location.replace("/login");
    } catch { error(form.elements.password, translateIgnis("The result could not be confirmed. Try signing in before requesting a new secret.")); }
    finally { form.elements.password.value = form.elements.confirmation.value = ""; submit.disabled = false; }
  });
  window.addEventListener("pagehide", () => form.reset());
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
