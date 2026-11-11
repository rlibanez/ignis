import {createUiElement} from "./ui-controls.js";
const t = text => globalThis.IgnisI18n?.t(text) ?? text;

// Presentation only: retain the existing controller's elements and handlers.
export function arrangeSharedManagement(frame) {
  frame.classList.add("native-shares");
  const workspace = frame.querySelector("#workspace");
  const toolbar = workspace.querySelector(".page-actions");
  const create = frame.querySelector("#new-share");
  const tabs = createUiElement(document,"div");
  tabs.className = "share-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("Shared resources"));
  const panels = ["owned", "received"].map(id => frame.querySelector(`#${id}`).closest("section"));
  const buttons = panels.map((panel, index) => {
    const heading = panel.querySelector("h2");
    const button = createUiElement(document,"button");
    button.type = "button";
    button.id = `share-tab-${index}`;
    button.textContent = t(heading.dataset.i18n);
    button.setAttribute("role", "tab");
    panel.id = `share-panel-${index}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    button.setAttribute("aria-controls", panel.id);
    heading.hidden = true;
    tabs.append(button);
    return button;
  });
  const select = index => {
    panels.forEach((panel, i) => { panel.hidden = i !== index; });
    buttons.forEach((button, i) => {
      button.setAttribute("aria-selected", String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });
    create.hidden = index !== 0;
    toolbar.hidden = index !== 0;
  };
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(index));
    button.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = 1 - index;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 1;
      else return;
      event.preventDefault(); select(next); buttons[next].focus();
    });
  });
  workspace.prepend(tabs, toolbar, ...panels);
  select(0);
}

export const sharedManagementStyles = `
  .native-shares #create-form label{font-size:var(--font-ui-medium);font-weight:var(--font-normal);line-height:1.5}
  .native-shares .share-tabs{display:flex;gap:4px;border-bottom:1px solid var(--background-modifier-border);margin-bottom:20px}
  .native-shares .share-tabs button{flex:1;white-space:normal;border:0;border-radius:var(--radius-s);box-shadow:none;background:transparent;color:var(--text-muted);padding:10px 12px}
  .native-shares .share-tabs button[aria-selected=true]{background:var(--background-modifier-hover);color:var(--text-normal);box-shadow:inset 0 -2px var(--interactive-accent)}
  .native-shares .page-actions{justify-content:flex-end;margin-bottom:16px}
  .native-shares-mobile .page-actions{flex-direction:column;align-items:stretch;gap:12px}
  .native-shares-mobile .page-actions>button{width:100%;margin:0;min-height:var(--input-height,44px)}
  .native-shares .share-panel{background:var(--background-secondary);border-radius:var(--radius-l);padding:16px 24px}
  .native-shares .share-panel header{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .native-shares .share-panel header .help{margin:0 0 16px}
  .native-shares button.account-button:not(.secondary):not(.danger){background:var(--interactive-accent);color:var(--text-on-accent)}
  .native-shares button.danger{background:var(--background-modifier-error);color:var(--text-on-accent)}
  .native-shares th{color:var(--text-muted);font-weight:var(--font-medium);font-size:var(--font-ui-smaller)}
  .native-shares td:last-child{width:1%;white-space:nowrap}
  .native-shares #manage-resource{margin:0 0 16px;color:var(--text-accent);font-size:var(--font-ui-medium);font-weight:var(--font-semibold,600);overflow-wrap:anywhere}
  .native-shares #access-heading{font-size:var(--font-ui-medium);font-weight:var(--font-semibold);margin:0}
  .native-shares #manage-dialog .access-section header{margin-bottom:16px}
  .native-shares #grants th{white-space:nowrap;overflow-wrap:normal}
  .native-shares :is(#owned,#grants) td:last-child .toolbar{flex-wrap:nowrap;gap:8px}
  .native-shares :is(#owned,#grants) .icon-button{display:inline-flex;align-items:center;justify-content:center;flex:none}
  @media(min-width:601px){
    .native-shares #history-entries :is(th,td):first-child{width:1%;white-space:nowrap;overflow-wrap:normal}
    .native-shares #grants th:last-child,.native-shares #grants td:last-child{width:104px;min-width:104px}
    .native-shares #grants th:first-child{width:30%}
  }
  .native-shares #owned :is(th,td):nth-child(2){white-space:nowrap;overflow-wrap:normal}
  .native-shares #history-entries .history-sort{background:transparent;border:0;box-shadow:none;color:inherit;font:inherit;height:auto;padding:4px;text-align:start}
  .native-shares #history-entries .history-sort:hover{color:var(--text-normal);background:var(--background-modifier-hover)}
  .native-shares #history-entries:empty{display:none}
  .native-shares #history-entries td:last-child{width:auto;white-space:normal}
  .native-shares tr:last-child td{border-bottom:0}
  .native-shares #picker{margin-top:16px}
  .native-shares #share-search{margin-top:16px}
  .native-shares #location-search{margin-bottom:10px}
  .native-shares .ui-dialog.ignis-confirm{font-size:var(--font-ui-medium);line-height:var(--line-height-normal,1.5)}
  @media(max-width:600px){
    .native-shares .page-actions{flex-direction:column;align-items:stretch;gap:12px}
    .native-shares .page-actions>button{width:100%;margin:0;min-height:var(--input-height,44px)}
    .native-shares .share-panel{padding:12px}
    .native-shares .responsive-table thead{display:none}
    .native-shares #history-entries thead{display:block}
    .native-shares #history-entries thead tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;border-bottom:1px solid var(--background-modifier-border)}
    .native-shares #history-entries th{border:0;padding:0}
    .native-shares #history-entries .history-sort{width:100%;min-height:var(--input-height,36px);white-space:normal}
    .native-shares .responsive-table,.native-shares tbody,.native-shares tr{display:block}
    .native-shares tr{padding:12px 0;border-bottom:1px solid var(--background-modifier-border)}
    .native-shares tr:last-child{border-bottom:0}
    .native-shares td,.native-shares td:last-child{display:grid;grid-template-columns:minmax(70px,30%) minmax(0,1fr);gap:10px;width:100%;border:0;padding:6px 0;white-space:normal}
    .native-shares td::before{content:attr(data-label);color:var(--text-muted);font-size:var(--font-ui-smaller)}
    .native-shares .dialog-actions{display:flex;justify-content:flex-end}
    .native-shares .dialog-actions button{width:auto}
  }
`;
