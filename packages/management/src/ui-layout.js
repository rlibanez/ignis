// Categories belong to the host, never to a particular form ID.
export function installUiLayout(document=globalThis.document) {
  if(document.getElementById('ignis-ui-layout'))return;
  const style=document.createElement('style');style.id='ignis-ui-layout';
  style.textContent=`
body:has(.vault-manager-overlay) .modal-container:has(.ignis-ui-form,.ignis-ui-list,.ignis-management-root,.ignis-shell-settings){z-index:calc(100000 + var(--layer-modal,50))}
/* Obsidian mounts tooltips on the body, outside the elevated management modal. */
body:has(.vault-manager-overlay .modal-shell):has(.modal.ignis-ui-form) > .tooltip{z-index:calc(100000 + var(--layer-modal,50) + 1)}
.notice-container.ignis-management-notices{z-index:calc(100000 + var(--layer-notice,60))}
.modal.ignis-ui-form{width:var(--modal-width,90vw);max-width:min(400px,calc(100vw - 32px));height:auto}
.modal.ignis-ui-list{width:var(--modal-width,90vw);max-width:var(--modal-max-width,1100px)}
.ignis-ui-form .ui-field>:is(input:not([type=checkbox]),select,textarea){box-sizing:border-box;width:100%;min-width:0}
.modal.ignis-ui-form button:is(.help-toggle,.setup-help-toggle,.ignis-password-help){
  box-sizing:border-box;flex:none;width:22px;height:22px;min-width:22px;min-height:22px;padding:0;border-radius:50%;
}
.ignis-ui-actions,.ignis-ui-footer>div{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:24px}
.ignis-ui-body{display:contents}
.ignis-ui-footer{margin-top:16px}
.ignis-ui-footer>div{margin:0;padding:0;border:0}
body.is-mobile .modal:is(.ignis-ui-form,.ignis-ui-list){width:100%;max-height:calc(100dvh - var(--safe-area-inset-top,0px))}
body.is-mobile .modal.ignis-ui-form{max-width:400px}
body.is-mobile .ignis-management-root{--ignis-tree-control-size:44px}
body.is-tablet .modal.ignis-ui-form{height:auto;max-height:var(--dialog-max-height,85vh)}
body.is-phone .modal.ignis-ui-form{height:100%;align-self:flex-start;margin-top:0}
body.is-phone .modal-container:not(.ignis-shell-modal)>.modal.ignis-ui-form{margin-top:max(var(--safe-area-inset-top,0px),env(safe-area-inset-top,0px))}
body.is-mobile .modal.ignis-ui-list{height:100%;max-width:100%}
body.is-mobile .ignis-ui-actions,body.is-mobile .ignis-ui-footer>div{flex-direction:column-reverse;align-items:stretch}
body.is-mobile .ignis-ui-actions>button,body.is-mobile .ignis-ui-footer>div>button{width:100%;margin:0}
.ignis-device-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--input-height);
  padding: var(--input-padding);
  border-radius: var(--input-radius);
  background: var(--interactive-normal);
  box-shadow: var(--input-shadow);
  color: var(--text-normal);
  font-size: var(--font-ui-small);
  font-weight: var(--input-font-weight);
  text-decoration: none;
}
.ignis-device-action:hover { background: var(--interactive-hover); text-decoration: none; }
body.is-phone .ignis-device-action { width: 100%; }
`;
  document.head.append(style);
}
