import { Modal, Notice, setIcon } from "obsidian";
import { ManagementModal } from "./management-modal.js";
import { messageDefinition } from "./settings-ui.js";
import { nativeTooltip } from "../../../shim/src/native-tooltip.js";
const t = (text, values = {}) => globalThis.IgnisI18n?.t(text, values) ?? text.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

class PasswordModal extends Modal {
  constructor(app, session) { super(app); this.session = session; }
  onOpen() {
    this.setTitle(t("Change password"));
    this.modalEl.addClass("ignis-password-modal");
    this.modalEl.addClass("mod-lg", "mod-form");
    const form = this.contentEl.createEl("form");
    const fields = {};
    for (const [key, label, placeholder] of [
      ["currentPassword", "Current password", "Your current password..."],
      ["newPassword", "New password", "Your new password..."],
      ["confirmation", "Confirm new password", "Confirm your new password..."],
    ]) {
      const field = form.createEl("label", {cls: "ignis-password-field"});
      const heading = field.createSpan({cls: "ignis-password-heading"});
      heading.createSpan({text: t(label)});
      if (key !== "currentPassword") {
        const help = heading.createEl("button", {type: "button", text: "?", cls: "ignis-password-help"});
        nativeTooltip(window, help, t("Password: at least {p0} characters and {p1} punctuation/symbol characters.", {
          p0: this.session.passwordPolicy.minLength,
          p1: this.session.passwordPolicy.minSpecialChars,
        }), {help: true});
      }
      const control = field.createSpan({cls: "ignis-password-control"});
      const input = control.createEl("input", {type: "password"});
      input.placeholder = t(placeholder);
      input.autocomplete = key === "currentPassword" ? "current-password" : "new-password";
      input.required = true;
      input.maxLength = 1024;
      const toggle = control.createEl("button", {type: "button", cls: "ignis-password-toggle"});
      const updateToggle = () => {
        const visible = input.type === "text";
        toggle.setAttribute("aria-label", `${t(visible ? "Hide" : "Show")} ${t(label)}`);
        toggle.setAttribute("aria-pressed", String(visible));
        setIcon(toggle, visible ? "eye-off" : "eye");
      };
      toggle.addEventListener("click", event => {
        event.preventDefault();
        input.type = input.type === "password" ? "text" : "password";
        updateToggle();
      });
      updateToggle();
      fields[key] = input;
    }
    const error = form.createEl("p", {attr: {role: "alert"}});
    const actions = form.createDiv({cls: "modal-button-container"});
    actions.createEl("button", {text: t("Cancel"), type: "button"})
      .addEventListener("click", () => this.close());
    const submit = actions.createEl("button", {text: t("Change password"), type: "submit", cls: "mod-cta"});
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      error.textContent = "";
      if (window.__ignis?.writes?.snapshotPending?.().length) {
        error.textContent = t("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before signing out."); return;
      }
      if (fields.newPassword.value !== fields.confirmation.value) {
        error.textContent = t("New passwords do not match."); return;
      }
      submit.disabled = true;
      try {
        const csrf = await fetch("/api/auth/csrf", {credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000)});
        if (!csrf.ok) throw new Error();
        const {csrfToken} = await csrf.json();
        const response = await fetch("/api/auth/password", {
          method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(15000),
          headers: {"Content-Type": "application/json", "X-Ignis-Csrf": csrfToken, "X-Ignis-Context": this.session.sessionId},
          body: JSON.stringify({currentPassword: fields.currentPassword.value, newPassword: fields.newPassword.value}),
        });
        if (!response.ok) {
          const body = await response.json();
          error.textContent = body.code === "INVALID_PASSWORD" ? t("The current password is incorrect.") : t("Unable to change your password. Sign in again before retrying.");
          return;
        }
        this.close();
        if (typeof BroadcastChannel === "function") {
          const channel = new BroadcastChannel("ignis-auth"); channel.postMessage("lock"); channel.close();
        }
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* Sessions are already revoked. */ }
        window.location.assign("/login?password=changed");
      } catch { error.textContent = t("The change could not be confirmed. Sign in again before retrying."); }
      finally { submit.disabled = false; fields.currentPassword.value = ""; }
    });
  }
  onClose() { this.contentEl.querySelectorAll("input").forEach(input => { input.value = ""; }); this.contentEl.empty(); }
}

class EmailModal extends Modal {
  constructor(app, session, updated) { super(app); this.session=session; this.updated=updated; }
  open() {
    super.open();
    // The help button precedes the input in DOM order. Native modal autofocus
    // otherwise selects it and opens its focus-triggered tooltip immediately.
    this.emailInput?.focus();
  }
  onOpen() {
    this.setTitle(t("Change email"));
    this.modalEl.addClass("mod-lg","mod-form","ignis-password-modal");
    const form=this.contentEl.createEl("form");
    const label=form.createEl("label",{cls:"ignis-password-field"});
    const heading=label.createSpan({cls:"ignis-password-heading"});
    heading.createSpan({text:t("Email (optional)")});
    const help=heading.createEl("button",{type:"button",text:"?",cls:"ignis-password-help"});
    nativeTooltip(window,help,t("Changing your email requires an administrator to verify it again. All your Ignis sessions will be closed."),{help:true});
    const email=label.createEl("input",{type:"email"});this.emailInput=email;email.autofocus=true;email.value=this.session.email ?? "";email.maxLength=254;email.autocomplete="email";
    const passwordLabel=form.createEl("label",{cls:"ignis-password-field",text:t("Current password")});
    const control=passwordLabel.createSpan({cls:"ignis-password-control"});
    const password=control.createEl("input",{type:"password"});password.autocomplete="current-password";password.maxLength=1024;
    password.placeholder=t("Your current password...");
    password.addEventListener("input",()=>password.setCustomValidity(""));
    const toggle=control.createEl("button",{type:"button",cls:"ignis-password-toggle"});
    const updateToggle=()=>{
      const visible=password.type==="text";
      toggle.setAttribute("aria-label",`${t(visible ? "Hide" : "Show")} ${t("Current password")}`);
      toggle.setAttribute("aria-pressed",String(visible));
      setIcon(toggle,visible ? "eye-off" : "eye");
    };
    toggle.addEventListener("click",event=>{event.preventDefault();password.type=password.type==="password" ? "text" : "password";updateToggle();});
    updateToggle();
    passwordLabel.hidden=this.session.recentAuthentication || !this.session.hasLocalPassword;
    const error=form.createEl("p",{attr:{role:"alert"}});
    const actions=form.createDiv({cls:"modal-button-container"});
    actions.createEl("button",{text:t("Cancel"),type:"button"}).addEventListener("click",()=>this.close());
    const submit=actions.createEl("button",{text:t("Save"),type:"submit",cls:"mod-cta"});
    const post=async(path,body)=>{
      const csrf=await fetch("/api/auth/csrf",{credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(15000)});
      if(!csrf.ok)throw new Error();
      const {csrfToken}=await csrf.json();
      return fetch(path,{method:"POST",credentials:"same-origin",signal:AbortSignal.timeout(15000),
        headers:{"Content-Type":"application/json","X-Ignis-Csrf":csrfToken,"X-Ignis-Context":this.session.sessionId},body:JSON.stringify(body)});
    };
    form.addEventListener("submit",async event=>{
      event.preventDefault();if(submit.disabled)return;
      if(window.__ignis?.writes?.snapshotPending?.().length){error.textContent=t("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before signing out.");return;}
      submit.disabled=true;error.textContent="";
      try{
        if(!passwordLabel.hidden){
          const response=await post("/api/auth/reauth",{password:password.value});
          if(!response.ok){
            if(response.status===400){
              password.value="";
              password.setCustomValidity(t("Incorrect password"));
              password.reportValidity();
            }else error.textContent=t("Request failed");
            return;
          }
          password.setCustomValidity("");
          passwordLabel.hidden=true;
        }
        const response=await post("/api/auth/email",{email:email.value,expectedEmail:this.session.email ?? null,expectedEmailTrust:this.session.emailTrust ?? "unverified"});
        const body=await response.json();
        if(response.status===403 && body.code==="REAUTH_REQUIRED"){
          if(this.session.hasLocalPassword){passwordLabel.hidden=false;password.focus();error.textContent=t("Confirm your identity");return;}
          if(window.__ignis?.writes?.snapshotPending?.().length){error.textContent=t("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before signing out.");return;}
          const start=await post("/api/auth/oidc/reauth",{purpose:"email"});
          if(!start.ok)throw new Error();
          const {authorizationUrl}=await start.json(),url=new URL(authorizationUrl);
          if(url.protocol!=="https:" || url.username || url.password)throw new Error();
          window.location.assign(url.href);return;
        }
        if(!response.ok){error.textContent=t(body.code==="INVALID_EMAIL" ? "Invalid or unavailable email." : body.code==="EMAIL_CHANGED" ? "Account changed. Reopen your account settings." : "Request failed");return;}
        if(body.signedOut){
          if(typeof BroadcastChannel==="function"){const channel=new BroadcastChannel("ignis-auth");channel.postMessage("lock");channel.close();}
          window.location.assign("/login");return;
        }
        Object.assign(this.session,body);this.updated();this.close();
      }catch{error.textContent=t("The change could not be confirmed. Reopen your account settings before retrying.");}
      finally{submit.disabled=false;password.value="";}
    });
  }
  onClose(){this.contentEl.querySelectorAll("input").forEach(input=>{input.value="";});this.contentEl.empty();}
}

class UnlinkProviderModal extends Modal {
  constructor(app, session, provider) { super(app); this.session = session; this.provider = provider || "OpenID Connect"; }
  onOpen() {
    this.setTitle(t("Unlink OpenID Connect account").replaceAll("OpenID Connect", () => this.provider));
    this.modalEl.addClass("mod-lg", "mod-form", "ignis-password-modal");
    this.contentEl.createEl("p", {text:t("Confirm your local password to unlink your identity provider. All your Ignis sessions will be closed.")});
    const form = this.contentEl.createEl("form");
    const label = form.createEl("label", {cls:"ignis-password-field", text:t("Current password")});
    const control = label.createSpan({cls:"ignis-password-control"});
    const input = control.createEl("input", {type:"password"});
    input.placeholder = t("Your current password...");
    const toggle = control.createEl("button", {type:"button", cls:"ignis-password-toggle"});
    const updateToggle = () => {
      const visible = input.type === "text";
      toggle.setAttribute("aria-label", `${t(visible ? "Hide" : "Show")} ${t("Current password")}`);
      toggle.setAttribute("aria-pressed", String(visible));
      setIcon(toggle, visible ? "eye-off" : "eye");
    };
    toggle.addEventListener("click", () => { input.type = input.type === "password" ? "text" : "password"; updateToggle(); });
    updateToggle();
    input.required = true; input.autocomplete = "current-password"; input.maxLength = 1024;
    const error = form.createEl("p", {attr:{role:"alert"}});
    const actions = form.createDiv({cls:"modal-button-container"});
    actions.createEl("button", {type:"button", text:t("Cancel")}).addEventListener("click", () => this.close());
    const submit = actions.createEl("button", {type:"submit", text:t("Unlink"), cls:"mod-warning"});
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      if (window.__ignis?.writes?.snapshotPending?.().length) {
        error.textContent=t("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before signing out."); return;
      }
      submit.disabled=true;
      try {
        const csrf = await fetch("/api/auth/csrf", {credentials:"same-origin", cache:"no-store", signal:AbortSignal.timeout(15000)});
        if (!csrf.ok) throw new Error();
        const {csrfToken} = await csrf.json();
        const response = await fetch("/api/auth/oidc/unlink", {
          method:"POST", credentials:"same-origin", signal:AbortSignal.timeout(15000),
          headers:{"Content-Type":"application/json", "X-Ignis-Csrf":csrfToken, "X-Ignis-Context":this.session.sessionId},
          body:JSON.stringify({password:input.value}),
        });
        if (!response.ok) { error.textContent=t(response.status === 400 ? "The current password is incorrect." : "Request failed"); return; }
        if (typeof BroadcastChannel === "function") {
          const channel=new BroadcastChannel("ignis-auth"); channel.postMessage("lock"); channel.close();
        }
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* Sessions are already revoked. */ }
        window.location.assign("/login");
      } catch { error.textContent=t("Request failed"); }
      finally { submit.disabled=false; input.value=""; }
    });
  }
  onClose() { this.contentEl.querySelectorAll("input").forEach(input => { input.value=""; }); this.contentEl.empty(); }
}

async function linkProvider(session, button) {
  button.setDisabled(true);
  try {
    if (window.__ignis?.writes?.snapshotPending?.().length) {
      new Notice(t("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before signing out."));
      return;
    }
    const signal = AbortSignal.timeout(15000);
    const csrf = await fetch("/api/auth/csrf", {credentials:"same-origin", cache:"no-store", signal});
    if (!csrf.ok) throw new Error();
    const {csrfToken} = await csrf.json();
    const response = await fetch("/api/auth/oidc/link", {
      method:"POST", credentials:"same-origin", signal,
      headers:{"Content-Type":"application/json", "X-Ignis-Csrf":csrfToken, "X-Ignis-Context":session.sessionId},
      body:JSON.stringify({}),
    });
    const body = await response.json();
    if (response.status === 403 && body.code === "REAUTH_REQUIRED") {
      window.location.assign("/login?reauth=link");
      return;
    }
    if (!response.ok) throw new Error();
    const url = new URL(body.authorizationUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    window.location.assign(url.href);
  } catch {
    new Notice(t("Request failed"));
  } finally { button.setDisabled(false); }
}

const sessions = new WeakMap();

export function settingDefinitions(tab) {
  let state = sessions.get(tab);
  if (!state) {
    state = {session: null, failed: false};
    sessions.set(tab, state);
    void (async () => {
      try {
        const response = await fetch("/api/auth/session", {credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000)});
        if (!response.ok) throw new Error();
        state.session = await response.json();
        const config = await fetch("/api/auth/status", {credentials:"same-origin", cache:"no-store", signal:AbortSignal.timeout(15000)});
        if (config.ok) state.oidc = await config.json();
      } catch { state.failed = true; }
      tab.update();
    })();
  }
  if (!state.session) return [{type: "group", items: [messageDefinition(t(state.failed ? "Request failed" : "Loading…"))]}];
  const session = state.session;
  const descriptions = {
    "Shared resources": "Manage the files and folders you share and those shared with you.",
    "Manage users": "Create accounts and manage their roles, status and access.",
    "Change password": "Change your local password. All your current sessions will be closed.",
    "Set local password": "Confirm your identity with your provider before creating a local password.",
    "OpenID Connect": "Manage your identity provider link and sign-in options.",
  };
  const open = kind => new ManagementModal(tab.app, kind).open();
  const action = (name, callback, warning = false) => ({
    name: t(name),
    render: setting => setting.setDesc(t(descriptions[name] || "")).addButton(button => {
      button.setButtonText(t(warning ? name : name === "Change password" ? "Change" : "Open")).onClick(callback);
      if (warning) button.setWarning();
    }),
  });
  // Each definition creates one native sibling row. Never nest Settings inside
  // a settingEl: that element is itself a horizontal flex row on desktop.
  return [
    {type: "group", items: [
      {name: t("Username"), render: setting => setting.setDesc(session.user.login).addButton(button => button.setButtonText(t("Sign out")).setWarning().onClick(() => window.__ignisAuth?.logout()))},
      {name:t("Email"),render:setting=>setting.setDesc(session.email || t("Not set")).addButton(button=>button.setButtonText(t("Change")).onClick(()=>new EmailModal(tab.app,session,()=>tab.update()).open()))},
      ...(session.hasLocalPassword ? [action("Change password", () => new PasswordModal(tab.app, session).open())] : []),
      ...(!session.hasLocalPassword && session.oidcLinked ? [action("Set local password", () => open("login"))] : []),
      ...(state.oidc?.oidcAvailable && session.oidcLinked ? [{
        name:"OpenID Connect",
        render: setting => {
          setting.setDesc(t(session.hasLocalPassword ? descriptions["OpenID Connect"] : "Cannot unlink: this account needs a local password first."));
          setting.addButton(button => button.setButtonText(t("Unlink OpenID Connect account").replaceAll("OpenID Connect", () => state.oidc.oidcButtonText || "OpenID Connect")).setDisabled(!session.hasLocalPassword)
            .onClick(() => new UnlinkProviderModal(tab.app, session, state.oidc.oidcButtonText).open()));
        },
      }] : []),
      ...(state.oidc?.oidcAvailable && !session.oidcLinked ? [{
        name: "OpenID Connect",
        render: setting => setting.setDesc(t(descriptions["OpenID Connect"])).addButton(button => {
          button.setButtonText(t("Link OpenID Connect account").replaceAll("OpenID Connect", () => state.oidc.oidcButtonText || "OpenID Connect"))
            .onClick(() => linkProvider(session, button));
        }),
      }] : []),
      ...(session.user.role === "admin" ? [action("Manage users", () => open("users"))] : []),
      action("Shared resources", () => open("shares")),
    ]},
  ];
}
