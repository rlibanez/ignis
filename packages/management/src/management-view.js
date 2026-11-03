import {resourceActionStyles} from "./resource-action-style.js";
import { installManagementDialogs } from "./management-dialogs.js";
import usersTemplate from "./users-template.js";
import sharesTemplate from "./shares-template.js";
import accountTemplate from "./account-security-template.js";
import resourceTreeStyle from "./resource-tree.css";
import { arrangeSharedManagement, sharedManagementStyles } from "./shared-management-view.js";
const t = text => globalThis.IgnisI18n?.t(text) ?? text;
export function createManagementView({frame,host,modal,setIcon,kind,resourceOnly,onDispose}) {
  const root=host;
  const template={users:usersTemplate,shares:sharesTemplate,password:accountTemplate}[kind];
      // Compile only bundled component markup; never fetch or adapt a page.
      const fragment = document.createElement("template");
      fragment.innerHTML = template;
      frame.replaceChildren(fragment.content.cloneNode(true));
      const style = document.createElement("style");
      style.textContent = `
        :scope{display:block;color:var(--text-normal);font:var(--font-ui-small) var(--font-interface)}
        *{box-sizing:border-box}[hidden]{display:none!important}main{padding:0;max-width:none;margin:0}
        .brand,main>h1,footer,.account-categories,.account-identity,.account-actions,#account-overview,.ignis-language{display:none!important}
        input:not([type=checkbox]),select,textarea{width:100%;min-width:0}
        label{display:block;margin:16px 0 8px}input[type=checkbox]{margin-right:8px}h2{font-size:var(--font-ui-large);margin:18px 0}
        .panel,.share-panel,.access-section{background:var(--background-secondary);border-radius:12px;padding:16px;margin-bottom:20px}
        .panel-heading,.toolbar,.dialog-actions,.password-actions,.reauth-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.panel-heading{justify-content:space-between}
        table{width:100%;border-collapse:collapse}td,th{text-align:start;padding:12px 8px;border-bottom:1px solid var(--background-modifier-border);overflow-wrap:anywhere}.table-scroll{overflow:auto}
        svg{width:18px;height:18px}.icon-button{min-width:36px}.resource-detail,.help{display:block;color:var(--text-muted);font-size:.9em}
        dialog{color:var(--text-normal);background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:var(--modal-radius,12px);padding:24px;width:min(620px,94vw);max-height:90dvh;overflow:auto}dialog::backdrop{background:#0008}
        .error:not(:empty),[role=alert]:not(:empty){color:var(--text-error);padding:8px 0}.dialog-actions,.password-actions{justify-content:flex-end;margin-top:20px}
        .password-control{display:flex;align-items:center;gap:6px}.password-control input{flex:1}.password-toggle{flex:none}.setup-field-heading,.field-heading{display:flex;align-items:center;gap:8px}.help-toggle,.setup-help-toggle{padding:0;min-height:24px;width:24px;border-radius:50%}
        .help-tooltip,.setup-help-tooltip{display:block;background:var(--background-secondary);padding:10px;max-width:300px}.tree-children{padding-left:18px}.tree-row{display:flex;gap:4px}.tree-toggle{width:36px}.tree-select{text-align:start}.tree-spacer{width:36px;flex:none}
        #account-security .account-button{display:block;margin:12px 0;width:100%}#account-security>h2,.login-actions{display:none}
        @media(max-width:600px){td,th{padding:8px 4px}.panel,.share-panel{padding:10px}dialog{padding:16px}.dialog-actions{display:grid;grid-template-columns:1fr}.dialog-actions button{width:100%}}
        :is(dialog.ignis-confirm,dialog#delete-dialog) .dialog-actions{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;justify-content:flex-end;gap:10px}
        :is(dialog.ignis-confirm,dialog#delete-dialog) .dialog-actions>button{display:inline-flex;align-items:center;justify-content:center;flex:0 1 auto;width:auto;min-width:0;min-height:var(--input-height,36px);margin:0;padding:var(--size-4-1,4px) var(--size-4-3,12px);border:0;border-radius:var(--button-radius,5px);box-shadow:var(--input-shadow);font-size:var(--font-ui-small);font-weight:var(--font-normal,400);line-height:normal;background:var(--interactive-normal);color:var(--text-normal)}
        :is(dialog.ignis-confirm,dialog#delete-dialog) .dialog-actions>button:hover{background:var(--interactive-hover)}
        :is(dialog.ignis-confirm,dialog#delete-dialog) .dialog-actions>button:is(.danger,.danger-button){background:var(--background-modifier-error);color:var(--text-on-accent)}
        :is(.native-users-mobile,.native-shares-mobile) :is(dialog.ignis-confirm,dialog#delete-dialog) .dialog-actions>button{min-height:40px}

      `;
      root.prepend(style);
      if (kind === "users" && document.body.classList.contains("is-mobile")) {
        frame.classList.add("native-users-mobile");
        const actions = document.createElement("div");
        actions.className = "users-mobile-actions";
        actions.append(frame.querySelector("#add-user"));
        frame.querySelector("#administration > .panel").before(actions);
        style.textContent += `
          .native-users-mobile #administration > .panel{padding:0;background:transparent}
          .native-users-mobile #accounts-heading{font-size:var(--font-ui-medium);margin:0 0 16px}
          .native-users-mobile .table-scroll{overflow:visible}
          .native-users-mobile .responsive-table,.native-users-mobile #users{display:block;width:100%}
          .native-users-mobile .responsive-table thead{display:none}
          .native-users-mobile #users tr{display:block;padding:0 var(--size-4-5,20px);margin-bottom:var(--size-4-6,24px);border:var(--setting-items-border-width,0px) solid var(--setting-items-border-color,transparent);border-radius:var(--setting-items-radius,16px);corner-shape:var(--corner-shape);background:var(--setting-items-background,var(--background-secondary));overflow:hidden}
          .native-users-mobile #users th,.native-users-mobile #users td{display:block;width:100%;padding:var(--size-4-4,16px) 0;border:0;border-bottom:1px solid var(--background-modifier-border);white-space:normal;overflow-wrap:anywhere;text-align:start;font-size:var(--font-ui-small);font-weight:var(--font-normal)}
          .native-users-mobile #users th::before,.native-users-mobile #users td:not(.actions)::before{content:attr(data-label);display:block;color:var(--text-normal);font-size:var(--font-ui-medium)}
          .native-users-mobile #users td span,.native-users-mobile #users th span{display:block;min-width:0;padding-top:var(--size-4-1,4px);text-align:start;color:var(--text-muted);font-size:var(--font-ui-smaller);line-height:var(--line-height-tight);font-weight:var(--font-normal)}
          .native-users-mobile #users .actions{display:flex;justify-content:flex-end;gap:12px;border-bottom:0}
          .native-users-mobile #users .icon-button{display:inline-flex;align-items:center;justify-content:center;width:var(--touch-size-m,44px);height:var(--touch-size-m,44px);padding:0;flex:none}
          .native-users-mobile .users-mobile-actions{display:flex;flex-direction:column;gap:var(--size-4-3,12px);margin-bottom:16px}
          .native-users-mobile .users-mobile-actions button{width:100%;min-height:var(--input-height,44px);margin:0;border-radius:var(--button-radius)}
          .native-users-mobile #add-user{background:var(--interactive-accent);color:var(--text-on-accent)}
        `;
      }
      if (kind === "users" && !document.body.classList.contains("is-mobile")) {
        frame.classList.add("native-users-desktop");
        const panel = frame.querySelector("#administration > .panel");
        const toolbar = document.createElement("div");
        toolbar.className = "users-toolbar";
        toolbar.append(frame.querySelector("#add-user"));
        panel.before(toolbar);
        style.textContent += `
          .native-users-desktop .users-toolbar{display:flex;justify-content:flex-end;margin-bottom:16px}
          .native-users-desktop #administration>.panel{background:var(--background-secondary);border-radius:var(--radius-l);padding:16px 24px}
          .native-users-desktop .panel-heading{display:none}
          .native-users-desktop #add-user{background:var(--interactive-accent);color:var(--text-on-accent)}
          .native-users-desktop :is(#add-user,#users .icon-button){min-height:var(--input-height,30px);padding:var(--size-4-1,4px) var(--size-4-3,12px);border:0;box-shadow:var(--input-shadow);font-size:var(--font-ui-small)}
          .native-users-desktop .responsive-table :is(td,th){overflow-wrap:normal;word-break:normal}
          .native-users-desktop .responsive-table thead th{color:var(--text-muted);font-weight:var(--font-medium);font-size:var(--font-ui-smaller)}
          .native-users-desktop #users th{font-weight:var(--font-medium)}
          .native-users-desktop #users td:nth-child(2){white-space:nowrap}
          .native-users-desktop .responsive-table :is(th,td):nth-child(n+4){white-space:nowrap}
          .native-users-desktop #users .actions{white-space:nowrap;width:1%}
          .native-users-desktop #users .icon-button{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;min-width:36px}
          .native-users-desktop #users .icon-button+ .icon-button{margin-inline-start:8px}
          .native-users-desktop #users tr:last-child :is(td,th){border-bottom:0}
        `;
      }
      if (kind === "shares") {
        style.textContent += sharedManagementStyles + resourceTreeStyle + resourceActionStyles;
        arrangeSharedManagement(frame);
        if (document.body.classList.contains("is-mobile")) {
          frame.classList.add("native-shares-mobile");
        }
      }
      if (kind === "password") {
        frame.classList.add("native-oidc");
        const section = frame.querySelector("#account-security");
        const description = document.createElement("p");
        description.textContent = t("Manage your identity provider link and sign-in options.");
        section.prepend(description);
        style.textContent += `
          .native-oidc #account-security{background:var(--background-secondary);border-radius:var(--radius-l,12px);padding:var(--size-4-6,24px)}
          .native-oidc #account-security>p{margin:0 0 20px;color:var(--text-muted);font-size:var(--font-ui-small)}
          .native-oidc #account-security .account-button{width:auto;margin:12px 0 12px auto;min-height:var(--input-height,30px);padding:var(--size-4-1,4px) var(--size-4-3,12px);border:0;box-shadow:var(--input-shadow);font-size:var(--font-ui-small)}
          .native-oidc #account-security #link-oidc{background:var(--interactive-accent);color:var(--text-on-accent)}
        `;
        if (document.body.classList.contains("is-mobile")) {
          style.textContent += `
            .native-oidc #account-security{border-radius:var(--mobile-setting-group-radius,var(--radius-l,12px))}
            .native-oidc #account-security .account-button{width:100%;min-height:var(--input-height,44px);margin:12px 0}
          `;
        }
      }
      // Scope layout rules, while allowing Obsidian and the active theme to style controls.
      style.textContent = `@scope (.ignis-management-root) { ${style.textContent} }`;
      const dialogs = installManagementDialogs(frame, host, modal, setIcon);
      onDispose(dialogs.dispose);
      if (resourceOnly && document.body.classList.contains("is-mobile")) {
        // Render the primary form inside the real Obsidian Modal, just like
        // Copy to. Nested confirmations still use their own modal dialogs.
        for (const id of ["create-dialog", "manage-dialog", "location-dialog"]) {
          const dialog=frame.querySelector(`#${id}`);
          dialog.classList.add("native-direct-resource");
          dialog.showModal=()=>dialog.show();
        }
      }
      if (resourceOnly) {
        // Keep the shared controller and its dialogs, but never display the catalog.
        const directStyle = document.createElement("style");
        directStyle.textContent = `@scope (.ignis-management-root) {
          #workspace, main>footer, main>.brand, main>h1 { display:none !important }
          dialog[open] { visibility:visible }
          .native-management-mobile dialog.native-direct-resource[open] { position:static;inset:auto;margin:0;width:100%;max-width:none;height:auto;max-height:none;padding:0;border:0;box-shadow:none;background:transparent;overflow:visible }
          /* The native Modal already supplies the content inset. Override the
             ID-specific form padding too, so it cannot add a second inset. */
          .native-management-mobile.native-shares dialog:is(#create-dialog,#manage-dialog,#location-dialog).native-direct-resource[open] { padding:0 }
          .native-management-mobile.native-shares #manage-dialog.native-direct-resource .access-section { padding:0;background:transparent }
          .native-management-mobile .native-direct-resource>h2,
          .native-management-mobile .native-direct-resource>.native-management-close { display:none }
        }`;
        frame.append(directStyle);
      }
      for (const el of frame.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
      for (const attr of ["title", "placeholder", "aria-label"]) for (const el of frame.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  return dialogs;
}
