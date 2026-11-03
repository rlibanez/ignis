const t = text => globalThis.IgnisI18n?.t(text) ?? text;

// Shared construction of native forms and confirmations. Closing goes through cancellation
// handler so pending requests and confirmation state retain their original guards.
export function installManagementDialogs(frame, host, modal, setIcon) {
  const style = document.createElement("style");
  style.textContent = `@scope (.ignis-management-root) { ${managementDialogStyles} }`;
  frame.append(style);
  const mobile = document.body.classList.contains("is-mobile");
  if (mobile) frame.classList.add("native-management-mobile");
  const align = () => {
    // Native mobile opening animations translate the modal from below the screen.
    // Use its layout position, not that transient visual transform, for top-layer dialogs.
    let top = -window.scrollY;
    for (let node = modal; node; node = node.offsetParent) top += node.offsetTop;
    host.style.setProperty("--management-sheet-top", `${Math.max(0, top)}px`);
  };
  const decorate = (fragment = frame) => {
    align();
    // DropdownComponent produces a select.dropdown; retain the existing nodes
    // and controller listeners while inheriting exactly those native styles.
    for (const button of fragment.querySelectorAll(".icon-button:not(.share-dialog-close)")) button.classList.add("ignis-resource-action");
    for (const input of fragment.querySelectorAll("input:not([type])")) input.type = "text";
    for (const select of fragment.querySelectorAll("select")) select.classList.add("dropdown");
    for (const button of fragment.querySelectorAll("button[type=submit],button.account-button:not(.secondary):not(.danger)")) button.classList.add("mod-cta");
    for (const button of fragment.querySelectorAll("button.danger,button.danger-button")) button.classList.add("mod-warning");
    for (const dialog of [ ...(fragment.matches?.("dialog") ? [fragment] : []), ...fragment.querySelectorAll("dialog") ]) {
      if (dialog.dataset.nativeDialog) continue;
      dialog.dataset.nativeDialog = "true";
      const confirmation = dialog.id === "delete-dialog" || dialog.classList.contains("ignis-confirm");
      dialog.classList.add(confirmation ? "native-management-confirmation" : "native-management-form");
      const heading = dialog.querySelector("h2");
      if (heading) {
        if (!heading.id) heading.id = `management-heading-${++headingSequence}`;
        dialog.setAttribute("aria-labelledby", heading.id);
      }
      // Prefer the dialog footer over cancellation of an inline sub-operation.
      const cancel = dialog.querySelector('.dialog-actions [id^="cancel-"]')
        || dialog.querySelector('[id^="cancel-"],#close-reset,[data-close]');
      let close = dialog.querySelector(".share-dialog-close");
      if (!close && cancel) {
        close = document.createElement("button");
        close.type = "button";
        close.setAttribute("aria-label", t("Close"));
        setIcon(close, "x");
        close.addEventListener("click", () => cancel.click());
        dialog.prepend(close);
      }
      close?.classList.add("native-management-close");
      // The standalone password form lists its primary action first. Native
      // desktop forms put Cancel first; mobile reverses that same action row.
      const actions = dialog.querySelector(".password-actions");
      const secondary = actions?.querySelector("#cancel-password");
      if (secondary) actions.prepend(secondary);
      if (dialog.id === "reset-dialog" && cancel) {
        const footer = document.createElement("div");
        footer.className = "dialog-actions";
        footer.append(cancel);
        dialog.append(footer);
      }
    }
  };
  decorate();
  const resized = new ResizeObserver(align);
  resized.observe(modal);
  window.addEventListener("resize", align);
  return {decorate, dispose:() => { resized.disconnect(); window.removeEventListener("resize", align); }};
}
let headingSequence = 0;
export const managementDialogStyles = `

dialog.native-management-confirmation{background:var(--modal-background,var(--background-primary));box-shadow:var(--shadow-l);font-size:var(--font-ui-medium);line-height:var(--line-height-normal,1.5)}
.native-management-confirmation>h2{margin:0 32px 24px 0;font-size:var(--font-ui-medium);font-weight:var(--font-semibold)}
.native-management-confirmation .help{font-size:var(--font-ui-small);color:var(--text-muted)}
.native-management-mobile dialog.native-management-confirmation{border-radius:var(--touch-radius-s,24px)}
.native-management-mobile .native-management-confirmation>h2{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;column-gap:.25em;text-align:center;min-height:var(--touch-size-m,44px);margin:0 48px 24px}
/* Same compact width as Obsidian's .modal.mod-form, without constraining mobile sheets. */
dialog:is(#create-dialog,#edit-dialog,#delete-dialog,#location-dialog,#grant-dialog){max-width:400px;box-sizing:border-box}
.native-management-mobile dialog:is(#create-dialog,#edit-dialog,#delete-dialog,#location-dialog,#grant-dialog){max-width:100%}
dialog.native-management-form{padding:20px;background:var(--modal-background,var(--background-secondary));border:var(--modal-border-width,1px) solid var(--modal-border-color,var(--background-modifier-border))}
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
.native-management-form>h2{margin:0 32px 24px 0;font-size:var(--font-ui-medium);font-weight:var(--font-semibold)}
.native-management-form label{font-size:var(--font-ui-medium)}
button.native-management-close{position:absolute;top:10px;right:10px;width:28px;height:28px;min-height:28px;padding:0;border:0;box-shadow:none;background:transparent;color:var(--text-muted);display:flex;align-items:center;justify-content:center}
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
/* Match Obsidian's .modal.mod-form width; preserve the form and its handlers. */
dialog.native-management-form#reauth-dialog{max-width:400px;height:fit-content;min-height:0}
.native-management-mobile dialog.native-management-form#reauth-dialog{max-width:100%;height:fit-content;min-height:0}
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


.native-management-mobile dialog.native-management-form,.native-management-mobile dialog#delete-dialog{position:fixed;inset:var(--management-sheet-top,0px) 0 auto;margin:0;width:100%;max-width:100%;height:auto;max-height:calc(100dvh - var(--management-sheet-top,0px));padding:var(--size-4-3,12px) var(--size-4-4,16px) max(var(--size-4-4,16px),var(--safe-area-inset-bottom,0px));border-radius:var(--touch-radius-s,24px)}
.native-management-mobile .native-management-form>h2{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;column-gap:.25em;text-align:center;min-height:var(--touch-size-m,44px);margin:0 48px 32px}
.native-management-mobile button.native-management-close{top:var(--size-4-3,12px);right:var(--size-4-4,16px);width:var(--touch-size-m,44px);height:var(--touch-size-m,44px);border-radius:50%;background:var(--background-modifier-hover);color:var(--text-normal)}
.native-management-mobile .native-management-close svg{width:24px;height:24px}
.native-management-mobile .native-management-form .dialog-actions{display:flex;flex-direction:column-reverse;align-items:stretch;gap:12px}
.native-management-mobile .native-management-form .dialog-actions button,.native-management-mobile .native-management-form .reauth-actions>button{width:100%;margin:0;min-height:var(--input-height,44px)}
.native-management-mobile dialog#edit-dialog{border-radius:var(--touch-radius-s,24px);height:auto;bottom:auto}
.native-management-mobile #edit-dialog .edit-account-actions button{min-height:var(--input-height,44px)}
.native-management-mobile #edit-dialog #revoke-confirmation,.native-management-mobile #edit-dialog #unlink-confirmation{flex-direction:column;align-items:stretch}
.native-management-mobile #reauth-form>button[type=submit],.native-management-mobile #reauth-dialog .reauth-actions>button{min-height:var(--input-height,44px);padding:8px 12px;box-sizing:border-box;font-size:var(--font-ui-small);line-height:normal}
        
dialog.native-management-form,dialog.native-management-confirmation{color:var(--text-normal);background:var(--modal-background,var(--background-secondary));padding:20px;box-shadow:var(--shadow-l)}
.native-management-form .setup-field-heading{position:relative;align-items:center;margin:16px 0 8px}
.native-management-form .setup-field-heading label{margin:0}
.native-management-form .setup-help-tooltip{position:absolute;z-index:10;top:calc(100% + 6px);left:0;max-width:100%;border:1px solid var(--background-modifier-border);border-radius:8px;box-shadow:var(--shadow-s)}
.native-management-form .dialog-actions,.native-management-form .password-actions{display:flex;justify-content:flex-end;gap:12px}
.native-management-form :is(.dialog-actions,.password-actions)>button{width:auto;margin:0;min-height:var(--input-height,36px)}
.native-management-form :is(.error,[role=alert]):not(:empty){color:var(--text-error);font-size:var(--font-ui-small);overflow-wrap:anywhere}
.native-management-mobile dialog.native-management-form{border-radius:var(--touch-radius-s,24px);height:auto;bottom:auto;max-height:calc(100dvh - var(--management-sheet-top,0px))}
.native-management-mobile #delete-dialog .dialog-actions,.native-management-mobile .native-management-form :is(.dialog-actions,.password-actions){display:flex;flex-direction:column-reverse;align-items:stretch;gap:12px}
.native-management-mobile #delete-dialog .dialog-actions>button,.native-management-mobile .native-management-form :is(.dialog-actions,.password-actions)>button{width:100%;margin:0;min-height:var(--input-height,44px)}
.native-management-mobile :is(dialog.ignis-confirm,dialog#delete-dialog) .dialog-actions{flex-direction:column-reverse;align-items:stretch;gap:12px}
.native-management-mobile :is(dialog.ignis-confirm,dialog#delete-dialog) .dialog-actions>button{width:100%;margin:0;min-height:var(--input-height,44px)}
.native-management-form #reset-result .password-with-copy input{padding-inline-end:88px}
.native-management-form #reset-result .password-copy{inset-inline-end:44px}
.native-management-form #reset-result .copy-feedback{position:absolute;inset-inline-end:0;bottom:calc(100% + 6px);padding:4px 8px;border-radius:var(--radius-s,4px);background:var(--background-secondary);color:var(--text-normal);box-shadow:var(--shadow-s);font-size:var(--font-ui-small);pointer-events:none}
.native-management-form #reset-result .copy-feedback:empty{display:none}
`;
