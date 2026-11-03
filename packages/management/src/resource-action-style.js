// Shared by the Obsidian sidebar and the resource management window.
export const resourceActionStyles = `
.ignis-resource-action {
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  box-sizing:border-box;min-width:36px;height:var(--input-height,30px);
  min-height:var(--input-height,30px);margin:0;
  padding:var(--size-4-1,4px) var(--size-4-3,12px);
  border:0;border-radius:var(--button-radius);box-shadow:var(--input-shadow);
  background:var(--interactive-normal);color:var(--text-normal);
  font-size:var(--font-ui-small);line-height:normal;
}
.ignis-resource-action:hover { background:var(--interactive-hover); }
.ignis-resource-action svg { width:18px;height:18px; }
body.is-mobile .ignis-resource-action,
.native-management-mobile .ignis-resource-action {
  min-width:var(--touch-size-m,44px);height:var(--touch-size-m,44px);
  min-height:var(--touch-size-m,44px);
}
`;
