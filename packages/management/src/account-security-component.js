import {clearSessionStorage} from "./session-transition.js";
import {refreshHelp} from "./help.js";
import oidc from "./oidc-start.cjs";
const t = (text,values={}) => globalThis.IgnisI18n?.t(text,values) ?? text;

// Local-password enrolment is an internal account component, not a login page.
export function mountAccountSecurity(scope) {
  const {root, fetch, window, location, onDispose} = scope;
  const byId = id => root.querySelector(`#${id}`);
  const form=byId("password-form"), dialog=byId("password-dialog"), status=byId("status");
  const cancel=byId("cancel-password"), submit=form.querySelector('[type="submit"]');
  let session, busy=false;
  const clear=()=>form.reset();
  onDispose(clear);
  cancel.onclick=()=>{if(!busy)dialog.close();};
  dialog.addEventListener("close",clear);
  dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
  const fail=(message,field=form.elements.newPassword)=>{field.setCustomValidity(t(message));field.reportValidity();};
  form.addEventListener("input",()=>{for(const input of form.querySelectorAll("input"))input.setCustomValidity("");});
  async function post(path,body,signal) {
    const headers={"X-Ignis-Context":session.sessionId};
    const csrf=await fetch("/api/auth/csrf",{headers,signal});
    if(!csrf.ok)throw new Error(t("Session unavailable"));
    headers["X-Ignis-Csrf"]=(await csrf.json()).csrfToken;
    headers["Content-Type"]="application/json";
    return fetch(path,{method:"POST",headers,body:JSON.stringify(body),signal});
  }
  byId("set-own-password").onclick=async event=>{
    if(busy)return;
    if(window.__ignis?.writes?.snapshotPending?.().length){status.textContent=t("Some writes are not confirmed. Wait for saving to finish or resolve failed writes before signing out.");return;}
    busy=true;event.currentTarget.disabled=true;
    try {
      scope.channel("ignis-auth")?.postMessage("lock");
      const response=await oidc.start({clear:signal=>clearSessionStorage(window,signal,{forSignIn:true}),request:signal=>post("/api/auth/oidc/reauth",{purpose:"password"},signal)});
      if(!response.ok)throw new Error();
      const url=new URL(response.body.authorizationUrl);
      if(url.protocol!=="https:" || url.username || url.password)throw new Error();
      location.assign(url.href);
    }catch{status.textContent=t("Request failed");}
    finally{busy=false;byId("set-own-password").disabled=false;}
  };
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!session)return;
    if(form.elements.newPassword.value!==form.elements.confirmation.value){fail("New passwords do not match.",form.elements.confirmation);return;}
    busy=true;submit.disabled=cancel.disabled=true;
    try {
      const response=await post("/api/auth/password",{newPassword:form.elements.newPassword.value});
      if(!response.ok){const body=await response.json();fail(body.error || "Request failed");return;}
      const channel=scope.channel("ignis-auth");channel?.postMessage("lock");
      try{await clearSessionStorage(window);}catch{/* Server sessions are already revoked. */}
      scope.assertActive();
      location.replace("/login?password=changed");
    }catch{fail("The change could not be confirmed. Sign in again before retrying.");}
    finally{clear();busy=false;submit.disabled=cancel.disabled=false;}
  };
  void (async()=>{
    try {
      const response=await fetch("/api/auth/session");
      if(!response.ok)throw new Error();
      session=await response.json();
      if(session.hasLocalPassword || !session.oidcLinked)throw new Error();
      status.textContent="";
      byId("account-security").hidden=false;
      byId("set-own-password").hidden=false;
      const policy=t("At least {p0} characters, including {p1} punctuation or symbol characters.",{p0:session.passwordPolicy.minLength,p1:session.passwordPolicy.minSpecialChars});
      byId("password-policy").textContent=policy;
      refreshHelp(root);
      for(const input of form.querySelectorAll('[type="password"]'))input.setAttribute("autocomplete","new-password");
      if(scope.passwordSetup){dialog.showModal();form.elements.newPassword.focus();}
    }catch{status.textContent=t("Request failed");}
  })();
}
