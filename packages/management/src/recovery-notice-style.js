// Persistent recovery actions are product UI; all visual tokens come from the
// current Obsidian theme. These rules never target native/upstream notices.
export function installRecoveryNoticeStyle(document) {
  if(document.getElementById('ignis-recovery-notice-style'))return;
  const style=document.createElement('style');style.id='ignis-recovery-notice-style';
  style.textContent=`
.ignis-recovery-notice{position:fixed;inset-block-end:var(--size-4-5,20px);inset-inline-end:var(--size-4-5,20px);box-sizing:border-box;width:min(420px,calc(100vw - 2 * var(--size-4-5,20px)));max-height:calc(100dvh - 2 * var(--size-4-5,20px));overflow:auto;padding:var(--size-4-4,16px);background:var(--background-primary);color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:var(--radius-m,8px);box-shadow:var(--shadow-l);font:var(--font-ui-small) var(--font-interface);line-height:var(--line-height-normal,1.5)}
.ignis-recovery-notice>p{margin:0 0 var(--size-4-3,12px);overflow-wrap:anywhere}
.ignis-recovery-notice>ul{max-height:120px;overflow:auto;overflow-wrap:anywhere}
.ignis-recovery-notice>.ignis-recovery-close{float:inline-end;margin-inline-start:var(--size-4-2,8px);padding:0;width:var(--input-height,30px);height:var(--input-height,30px);color:var(--text-muted);background:transparent;box-shadow:none}
.ignis-recovery-actions{display:flex;flex-direction:column;gap:var(--size-4-3,12px);margin-top:var(--size-4-3,12px)}
.ignis-recovery-actions>:is(button,a){box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:auto;min-height:var(--input-height,30px);margin:0;padding:var(--size-4-2,8px) var(--size-4-3,12px);font-size:var(--font-ui-small);line-height:var(--line-height-normal,1.5);text-align:center;white-space:normal}
.ignis-recovery-actions>a{border-radius:var(--button-radius);background:var(--interactive-normal);color:var(--text-normal);box-shadow:var(--input-shadow);text-decoration:none}
.ignis-recovery-actions>a:hover{background:var(--interactive-hover)}
.ignis-recovery-toggle{margin:0;padding:0 var(--size-4-2,8px);height:auto;min-height:0;font:inherit;color:var(--text-muted);background:transparent;border:0;box-shadow:none}
`;
  document.head.append(style);
}
