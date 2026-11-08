// Categories belong to the host, never to a particular form ID.
export function installUiLayout(document=globalThis.document) {
  if(document.getElementById('ignis-ui-layout'))return;
  const style=document.createElement('style');style.id='ignis-ui-layout';
  style.textContent=`
body:has(.vault-manager-overlay) .modal-container:has(.ignis-ui-form,.ignis-ui-list,.ignis-management-root,.ignis-shell-settings){z-index:calc(100000 + var(--layer-modal,50))}
.notice-container.ignis-management-notices{z-index:calc(100000 + var(--layer-notice,60))}
.modal.ignis-ui-form{width:var(--modal-width,90vw);max-width:min(400px,calc(100vw - 32px));height:auto}
.modal.ignis-ui-list{width:var(--modal-width,90vw);max-width:var(--modal-max-width,1100px)}
.ignis-ui-form .ui-field>:is(input:not([type=checkbox]),select,textarea){box-sizing:border-box;width:100%;min-width:0}
.ignis-ui-actions,.ignis-ui-footer>div{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:24px}
.ignis-ui-body{display:contents}
.ignis-ui-footer{margin-top:16px}
.ignis-ui-footer>div{margin:0;padding:0;border:0}
body.is-mobile .modal:is(.ignis-ui-form,.ignis-ui-list){width:100%;max-width:100%;height:100%;max-height:calc(100dvh - var(--safe-area-inset-top,0px))}
body.is-mobile .ignis-ui-actions,body.is-mobile .ignis-ui-footer>div{flex-direction:column-reverse;align-items:stretch}
body.is-mobile .ignis-ui-actions>button,body.is-mobile .ignis-ui-footer>div>button{width:100%;margin:0}
`;
  document.head.append(style);
}
