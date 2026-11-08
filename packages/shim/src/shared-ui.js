import {createUiElement} from "../../management/src/ui-controls.js";
import {nativeTooltip} from './native-tooltip.js';

const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
// Shared presentation helpers; callers retain authorization and request handling.
export function errorBlock(el) {
  el.classList.add('ignis-ui-error');
  el.setAttribute('role', 'alert');
  return el;
}

export function addFieldHelp(host, label, text) {
  const region=createUiElement(host.document,'span');region.className='ignis-ui-help';
  const toggle=createUiElement(host.document,'button');toggle.type='button';toggle.textContent='?';
  nativeTooltip(host,toggle,text,{help:true});
  region.append(toggle);label.append(region);
}

export function confirmSharedAction(obsidian, app, host, title, message, action) {
  return new Promise(resolve=>{
    class Confirmation extends obsidian.Modal {
      onOpen(){
        this.modalEl.classList.add("ignis-management-modal","ignis-ui-form","mod-lg","mod-form");
        this.setTitle(title);
        const text=createUiElement(host.document,'p');text.textContent=message;
        const actions=createUiElement(host.document,'div');actions.className='ignis-ui-actions';
        const cancel=createUiElement(host.document,'button');cancel.textContent=translateIgnis("Cancel");cancel.onclick=()=>this.close();
        const accept=createUiElement(host.document,'button');accept.textContent=action;accept.className='mod-warning';
        accept.onclick=()=>{this.accepted=true;this.close();};
        actions.append(cancel,accept);this.contentEl.append(text,actions);cancel.focus();
        this.lost=()=>this.close();host.addEventListener('ignis:auth-lost',this.lost);
      }
      onClose(){host.removeEventListener('ignis:auth-lost',this.lost);this.contentEl.empty();resolve(this.accepted===true && !host.__ignisAuth?.blocked);}
    }
    new Confirmation(app).open();
  });
}
