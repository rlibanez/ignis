// Real Obsidian components when the bridge is present; HTML before the editor.
// No prototype patches, runtime imports or application emulation in the fallback.
const controls = new WeakMap();
export function uiRuntime(host = globalThis.window) { return host?.__ignisUiRuntime || null; }
export function createUiElement(document, tag, options = {}) {
  const runtime = uiRuntime(document.defaultView);
  options = {...options,type:options.type || options.attr?.type};
  const name = ({input:'TextComponent',textarea:'TextAreaComponent',select:'DropdownComponent',button:'ButtonComponent'})[tag];
  let element;
  // File and checkbox inputs retain browser semantics; Obsidian has no equivalent
  // file/checkbox component. A ToggleComponent would change the exposed role.
  if (runtime && name && !['file','checkbox','hidden'].includes(options.type)) {
    const component = new runtime[name](document.createElement('div'));
    element = component.inputEl || component.selectEl || component.buttonEl;
    if (!element) throw Error('Native UI component did not expose its control');
    controls.set(element,component);
    runtime.controls.set(element,component);
    element.dataset.uiComponent = name;
  } else element = document.createElement(tag);
  if(tag === "input" && !options.type)element.type="text";
  if (options.type && ["input","button"].includes(tag)) element.type = options.type;
  if (tag === 'button' && !options.type) element.type = 'button';
  if (options.cls) element.classList.add(...options.cls.split(/\s+/).filter(Boolean));
  if (options.text !== undefined) element.textContent = options.text;
  for (const [key,value] of Object.entries(options.attr || {})) element.setAttribute(key,value);
  return element;
}
export function appendUiControl(parent, tag, options) {
  if(!uiRuntime(parent.ownerDocument?.defaultView) && typeof parent.createEl === "function") {
    const element=parent.createEl(tag,options);
    if(tag === "button")element.type=options?.type || "button";
    return element;
  }
  const element = createUiElement(parent.ownerDocument,tag,options);
  parent.append(element);
  mountDropdownMeasure(element);
  return element;
}
export function nativeComponent(element) { return controls.get(element); }
function mountDropdownMeasure(element) {
  const dropdown = element.tagName === "SELECT" && nativeComponent(element);
  if (!dropdown?.measureEl) return;
  // An absolutely positioned measuring select must not extend the form at its static position.
  dropdown.measureEl.style.insetBlockStart = "0";
  dropdown.measureEl.style.insetInlineStart = "0";
  element.after(dropdown.measureEl);
  dropdown.setValue(element.value);
}
// Called once before template controllers attach listeners or retain references.
export function initializeUiControls(root) {
  for(const input of root.querySelectorAll("input:not([type])"))input.type="text";
  if (!uiRuntime(root.ownerDocument.defaultView)) return;
  for (const old of root.querySelectorAll('input,textarea,select,button')) {
    if (controls.has(old)) continue;
    const type = old.type;
    if (old.tagName === 'INPUT' && ['checkbox','file','hidden'].includes(type)) continue;
    const element = createUiElement(root.ownerDocument,old.tagName.toLowerCase(),{type});
    for (const attribute of old.attributes) element.setAttribute(attribute.name,attribute.value);
    if (old.tagName === 'INPUT') element.value=old.value;
    else element.replaceChildren(...old.childNodes);
    old.replaceWith(element);
    mountDropdownMeasure(element);
  }
}
// Select choices are data, not portalled Svelte <option> nodes. Updating a list
// must also work after the field has mounted (for example changed membership).
export function setUiOptions(select, choices) {
  select.replaceChildren();
  const component=nativeComponent(select);
  for(const choice of choices){
    if(component)component.addOption(String(choice.value),String(choice.label));
    else{const option=select.ownerDocument.createElement('option');option.value=String(choice.value);option.textContent=String(choice.label);select.append(option);}
    select.lastElementChild.disabled=choice.disabled===true;
  }
  if (component?.measureEl?.isConnected) component.setValue(select.value);
}
