(() => {
  const form = document.getElementById("setup-form");
  const status = document.getElementById("status");
  const button = form.querySelector("button");
  const field = (name) => form.elements.namedItem(name);
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
        document.getElementById("sign-in").hidden = false;
        status.textContent = "Initial setup is complete. Sign in to continue.";
      } else if (!state.setupAvailable) {
        status.textContent =
          "Web setup is disabled. Ask the server operator to configure an installation key or create the first administrator using the local CLI.";
      } else {
        status.textContent =
          "Your vaults remain locked until setup and authentication are complete.";
        const policy = state.passwordPolicy;
        field("password").minLength = policy.minLength;
        field("passwordConfirmation").minLength = policy.minLength;
        document.getElementById("password-help").textContent =
          `Use at least ${policy.minLength} characters, up to ${policy.maxBytes} UTF-8 bytes.` +
          (policy.minSpecialChars
            ? ` Include at least ${policy.minSpecialChars} punctuation or symbol characters (for example ! or *). Spaces do not count as symbols.`
            : " No special characters are required.");
        form.hidden = false;
      }
    } catch {
      status.textContent =
        "Unable to check installation status. Reload this page to try again.";
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    if (field("password").value !== field("passwordConfirmation").value) {
      status.textContent = "The passwords do not match.";
      field("passwordConfirmation").focus();
      return;
    }
    button.disabled = true;
    status.textContent = "Creating administrator…";
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
        await refresh();
      } else {
        status.textContent =
          response.status === 429
            ? "Too many attempts or server busy. Wait before trying again."
            : response.status === 400
              ? "Check the username and password requirements and try again."
              : "Setup was rejected. Check the installation key and reload the page before trying again.";
      }
    } catch {
      status.textContent =
        "Setup could not be confirmed. Reload to check whether it completed before trying again.";
    } finally {
      clearSecrets();
      button.disabled = false;
    }
  });
  window.addEventListener("pagehide", clearSecrets);
  refresh();
})();
