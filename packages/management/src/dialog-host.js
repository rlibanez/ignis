import {installUiLayout} from "./ui-layout.js";
// A single dialog lifecycle for Obsidian and the independent browser host.
// Templates are inert sections; they never enter the browser top layer inside a Modal.
export function installDialogHost({frame,owner,createModal,primary=false}) {
 installUiLayout(frame.ownerDocument);
 const ownerDisplay=owner.containerEl.style.display;
 const entries=new Map(),stack=[],listeners=[];let disposed=false;
 const home=frame.parentNode,marker=frame.ownerDocument.createComment('management-content');
 home.insertBefore(marker,frame);
 const Event=frame.ownerDocument.defaultView.Event;
 function activate() {
  const current=stack.at(-1);
  frame.classList.toggle('ui-dialog-active',!!current && current.modal===owner);
  // Keep each parent surface mounted behind its child. Only the form is portalled.
  for(const entry of entries.values())entry.section.toggleAttribute('data-ui-active',entry===current);
  owner.containerEl.hidden=false;
  owner.containerEl.style.display=ownerDisplay;
 }
 function bind(section) {
  if(entries.has(section))return;
  section.classList.add('ui-dialog');
  const placeholder=frame.ownerDocument.createComment('dialog-content');section.before(placeholder);
  const entry={section,placeholder,modal:null,closing:false};entries.set(section,entry);
  for(const [type,listener,options] of listeners)section.addEventListener(type,listener,options);
  Object.defineProperty(section,'open',{get:()=>section.hasAttribute('open')});
  section.showModal=()=>{
   if(disposed||section.open)return;
   section.setAttribute('open','');
   const list=section.hasAttribute("data-ui-list");
   const useOwner=primary && stack.length===0 && !list && !section.classList.contains("ignis-confirm");
   const modal=entry.modal=useOwner?owner:createModal(section);
   entry.baseClose=(modal.forceClose || modal.close).bind(modal);
   entry.ownerClose=useOwner?modal.requestClose:null;
   modal.modalEl.classList.add('ignis-managed-dialog-shell');
   if(!list)modal.modalEl.classList.add('mod-lg','mod-form','ignis-ui-form');
   // Individual forms must not inherit the catalog owner's inline dimensions.
   if(useOwner)for(const property of ['width','maxWidth','height','maxHeight'])modal.modalEl.style[property]='';
   const heading=section.querySelector('h2');
   const title=()=>modal.setTitle(heading?.textContent || '');title();
   const previousClose=useOwner?null:modal.onClose?.bind(modal);
   if(!useOwner)modal.onClose=()=>{previousClose?.();if(entry.modal===modal)finish(entry);};
   modal.requestClose=()=>{
    if(entry.closing)return;
    if(!section.dispatchEvent(new Event('cancel',{cancelable:true})))return;
    close(entry);
   };
   const surface=frame.ownerDocument.createElement('div');
   surface.className=frame.className || '';modal.contentEl.classList.add('ignis-management-root');
   for(const style of frame.querySelectorAll('style'))surface.append(style.cloneNode(true));
   surface.append(section);modal.contentEl.append(surface);entry.surface=surface;
   stack.push(entry);
   if(!useOwner)modal.open();
   activate();
  };
  section.close=value=>{section.returnValue=value || '';close(entry);};
 }
 function finish(entry) {
  if(disposed||!entry.section.open)return;
  entry.section.removeAttribute('open');
  const index=stack.indexOf(entry);if(index>=0)stack.splice(index,1);
  if(entry.placeholder.parentNode)entry.placeholder.after(entry.section);
  entry.section.removeAttribute('data-ui-active');entry.surface?.remove();
  activate();entry.closing=false;
  queueMicrotask(()=>{
   if(disposed)return;
   entry.section.dispatchEvent(new Event('close'));
   // One-shot confirmations remove themselves after close; do not retain their DOM.
   if(!entry.section.parentNode){
    entries.delete(entry.section);entry.placeholder.remove();
    for(const [type,listener,options] of listeners)entry.section.removeEventListener(type,listener,options);
   }
  });
 }
 function close(entry) {
  if(entry.closing||!entry.section.open)return;
  // A parent cannot leave a child modal and its pending callbacks orphaned.
  for(const child of stack.slice(stack.indexOf(entry)+1).reverse())close(child);
  entry.closing=true;
  if(entry.modal===owner){owner.requestClose=entry.ownerClose;finish(entry);entry.baseClose();}
  else{entry.baseClose();finish(entry);}
 }
 function decorate(fragment=frame) {
  if(fragment.matches?.('[data-ui-dialog]'))bind(fragment);
  for(const section of fragment.querySelectorAll('[data-ui-dialog]'))bind(section);
 }
 decorate();
 // Controllers retain one logical scope across the catalog and its native portals.
 const querySelectorAll=selector=>[...new Set([ ...frame.querySelectorAll(selector), ...[...entries.values()].flatMap(({section})=>[...(section.matches(selector)?[section]:[]),...section.querySelectorAll(selector)]) ])];
 const root={ownerDocument:frame.ownerDocument,querySelectorAll,querySelector:selector=>querySelectorAll(selector)[0] || null,append:(...nodes)=>frame.append(...nodes),addEventListener(type,listener,options){frame.addEventListener(type,listener,options);const forwarded=event=>{if(!frame.contains(event.target))listener(event);};listeners.push([type,forwarded,options]);for(const {section} of entries.values())section.addEventListener(type,forwarded,options);}};
 return {root,decorate,dispose(){
  disposed=true;
  // Portalled fields no longer belong to the owner's contentEl. Clear them here
  // before native close animations or late callbacks can retain their secrets.
  for(const {section} of entries.values())for(const field of section.querySelectorAll('input,textarea'))field.value='';
  for(const entry of [...stack].reverse()){
   
   if(entry.modal===owner){owner.requestClose=entry.ownerClose;entry.section.removeAttribute('open');}
   else{entry.closing=true;entry.baseClose();}
  }
  stack.length=0;owner.containerEl.hidden=false;owner.containerEl.style.display=ownerDisplay;
  if(marker.parentNode){marker.after(frame);marker.remove();}
 }};
}
export const dialogHostStyles=`
.ui-dialog:not([open]){display:none!important}
.ui-dialog-active>:not(style):not([data-ui-active]){display:none!important}
.ui-dialog[open]{position:static;inset:auto;display:block;margin:0;padding:0;width:100%;max-width:none;height:auto;max-height:none;overflow:visible;border:0;box-shadow:none;background:transparent}
.ui-dialog[open]>h2,.ui-dialog[open]>.native-management-close{display:none}
.ignis-managed-dialog-shell .modal-content{overflow:auto}
`;
