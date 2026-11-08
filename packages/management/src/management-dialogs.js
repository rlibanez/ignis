import {installDialogHost,dialogHostStyles} from "./dialog-host.js";

// Shared construction of native forms and confirmations. Closing goes through cancellation
// handler so pending requests and confirmation state retain their original guards.
export function installManagementDialogs(frame, host, modal, setIcon, options) {
  const style=document.createElement("style");
  style.textContent=`@scope (.ignis-management-root) { ${managementDialogStyles} ${dialogHostStyles} }`;
  frame.append(style);
  if(document.body.classList.contains("is-mobile"))frame.classList.add("native-management-mobile");
  const dialogs=installDialogHost({frame,...options});
  const decorate=(fragment=frame)=>{
    for(const select of fragment.querySelectorAll("select"))select.classList.add("dropdown");
    for(const button of fragment.querySelectorAll('button[type=submit],button.account-button:not(.secondary):not(.danger)'))button.classList.add('mod-cta');
    for(const button of fragment.querySelectorAll('button.danger,button.danger-button'))button.classList.add('mod-warning');
    for(const section of fragment.querySelectorAll('[data-ui-dialog]')){
      section.classList.add(section.id==='delete-dialog'||section.classList.contains('ignis-confirm')?'native-management-confirmation':'native-management-form');
    }
    for(const actions of fragment.querySelectorAll(".password-actions")){
      const cancel=actions.querySelector("button.secondary");if(cancel)actions.prepend(cancel);
    }
    dialogs.decorate(fragment);
  };
  decorate();return {root:dialogs.root,decorate,dispose:dialogs.dispose};
}
export const managementDialogStyles = `
.native-management-confirmation{font-size:var(--font-ui-medium);line-height:var(--line-height-normal,1.5)}

.native-management-confirmation .help{font-size:var(--font-ui-small);color:var(--text-muted)}
.native-management-form .password-control{position:relative;display:block}
.native-management-form .password-control input{width:100%;padding-inline-end:48px}
.native-management-form .password-control .password-toggle{position:absolute;inset-inline-end:4px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;width:40px;min-height:0;padding:0;border:0;box-shadow:none;background:transparent;color:var(--text-muted)}
.native-management-form .password-toggle:hover{color:var(--text-normal)}
.native-management-form .field-heading{position:relative;align-items:center;margin:16px 0 8px}
.native-management-form .field-heading label{margin:0}
.native-management-form .field-help{flex:none;line-height:1}
.native-management-form .help-toggle{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;min-height:22px;font-size:14px;padding:0;box-shadow:none}
.native-management-form .help-tooltip{position:absolute;z-index:10;inset-inline-start:0;top:calc(100% + 6px);width:max-content;max-width:100%;padding:10px 12px;border-radius:var(--radius-m,8px);background:var(--background-secondary);color:var(--text-normal);box-shadow:var(--shadow-s);border:1px solid var(--background-modifier-border);font-size:var(--font-ui-small);line-height:1.5;overflow-wrap:anywhere}
.native-management-form #create-password-change-help{top:auto;bottom:calc(100% + 6px)}
.native-management-form label{font-size:var(--font-ui-medium)}
.native-management-form button[type=submit]{background:var(--interactive-accent);color:var(--text-on-accent)}
#edit-dialog .edit-account-actions{display:flex;flex-direction:column;gap:12px;margin-top:20px}
#edit-dialog .edit-account-actions>button,#edit-dialog .session-actions>button,#edit-dialog .unlink-control>button{width:100%;margin:0}
#edit-dialog .session-actions{margin:0;padding:0;border:0}
#edit-dialog .dialog-actions{margin-top:8px}
#edit-dialog #revoke-confirmation,#edit-dialog #unlink-confirmation{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
#edit-dialog #revoke-confirmation p,#edit-dialog #unlink-confirmation p{flex-basis:100%;margin:0}
.native-management-form .reauth-actions{display:flex;flex-direction:column;align-items:stretch;gap:12px}
.native-management-form #reauth-form>button[type=submit]{width:100%;margin-top:16px}
.native-management-form #reauth-status:empty{display:none}
#reauth-dialog .reauth-actions{display:flex;flex-flow:row wrap;align-items:center;gap:12px}
#reauth-dialog #reauth-form:not([hidden]){display:contents}
#reauth-dialog #reauth-form>label,#reauth-dialog #reauth-form>.password-control,#reauth-dialog #reauth-form>input{flex-basis:100%;width:100%}
#reauth-dialog #reauth-form>label{margin:8px 0 0}
#reauth-dialog #reauth-form>button[type=submit]{order:4;width:auto;margin:8px 0 0}
#reauth-dialog #cancel-reauth{order:3;width:auto;margin:8px 0 0 auto}
#reauth-dialog #reauth-oidc,#reauth-dialog #reauth-status{flex-basis:100%;width:100%;order:2}
#reauth-dialog #reauth-status{margin:0}
.native-management-mobile #reauth-dialog #reauth-form>button[type=submit]{order:3;width:100%;flex-basis:100%}
.native-management-mobile #reauth-dialog #cancel-reauth{order:4;width:100%;flex-basis:100%;margin:0}


.native-management-mobile .native-management-form .dialog-actions{display:flex;flex-direction:column-reverse;align-items:stretch;gap:12px}
.native-management-mobile .native-management-form .dialog-actions button,.native-management-mobile .native-management-form .reauth-actions>button{width:100%;margin:0;min-height:var(--input-height,44px)}
.native-management-mobile #edit-dialog .edit-account-actions button{min-height:var(--input-height,44px)}
.native-management-mobile #edit-dialog #revoke-confirmation,.native-management-mobile #edit-dialog #unlink-confirmation{flex-direction:column;align-items:stretch}
.native-management-mobile #reauth-form>button[type=submit],.native-management-mobile #reauth-dialog .reauth-actions>button{min-height:var(--input-height,44px);padding:8px 12px;box-sizing:border-box;font-size:var(--font-ui-small);line-height:normal}

.native-management-form .setup-field-heading{position:relative;align-items:center;margin:16px 0 8px}
.native-management-form .setup-field-heading label{margin:0}
.native-management-form .setup-help-tooltip{position:absolute;z-index:10;top:calc(100% + 6px);left:0;max-width:100%;border:1px solid var(--background-modifier-border);border-radius:8px;box-shadow:var(--shadow-s)}
.native-management-form .dialog-actions,.native-management-form .password-actions{display:flex;justify-content:flex-end;gap:12px}
.native-management-form :is(.dialog-actions,.password-actions)>button{width:auto;margin:0;min-height:var(--input-height,36px)}
.native-management-form :is(.error,[role=alert]):not(:empty){color:var(--text-error);font-size:var(--font-ui-small);overflow-wrap:anywhere}
.native-management-mobile #delete-dialog .dialog-actions,.native-management-mobile .native-management-form :is(.dialog-actions,.password-actions){display:flex;flex-direction:column-reverse;align-items:stretch;gap:12px}
.native-management-mobile #delete-dialog .dialog-actions>button,.native-management-mobile .native-management-form :is(.dialog-actions,.password-actions)>button{width:100%;margin:0;min-height:var(--input-height,44px)}
.native-management-mobile :is(.ui-dialog.ignis-confirm,.ui-dialog#delete-dialog) .dialog-actions{flex-direction:column-reverse;align-items:stretch;gap:12px}
.native-management-mobile :is(.ui-dialog.ignis-confirm,.ui-dialog#delete-dialog) .dialog-actions>button{width:100%;margin:0;min-height:var(--input-height,44px)}
.native-management-form #reset-result .password-with-copy input{padding-inline-end:88px}
.native-management-form #reset-result .password-copy{inset-inline-end:44px}
.native-management-form #reset-result .copy-feedback{position:absolute;inset-inline-end:0;bottom:calc(100% + 6px);padding:4px 8px;border-radius:var(--radius-s,4px);background:var(--background-secondary);color:var(--text-normal);box-shadow:var(--shadow-s);font-size:var(--font-ui-small);pointer-events:none}
.native-management-form #reset-result .copy-feedback:empty{display:none}
`;
