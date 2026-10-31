// Shared presentation helpers; callers retain authorization and request handling.
export function errorBlock(el) {
  el.classList.add('ignis-ui-error');
  el.setAttribute('role', 'alert');
  return el;
}

export function addFieldHelp(host, label, text) {
  const region=host.document.createElement('span');region.className='ignis-ui-help';
  const toggle=host.document.createElement('button');toggle.type='button';toggle.textContent='?';
  toggle.setAttribute('aria-label','About '+label.firstChild.textContent);
  const tip=host.document.createElement('span');tip.className='ignis-ui-tooltip';tip.textContent=text;tip.hidden=true;tip.setAttribute('role','tooltip');
  tip.id='ignis-help-'+host.crypto.randomUUID();toggle.setAttribute('aria-controls',tip.id);
  const show=open=>{tip.hidden=!open;toggle.setAttribute('aria-expanded',String(open));};show(false);
  toggle.onclick=event=>{event.preventDefault();show(tip.hidden);};
  region.onmouseenter=()=>show(true);region.onmouseleave=()=>show(false);
  region.onfocusout=event=>{if(!region.contains(event.relatedTarget))show(false);};
  region.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();show(false);}};
  region.append(toggle,tip);label.append(region);
}

export function confirmSharedAction(obsidian, app, host, title, message, action) {
  return new Promise(resolve=>{
    class Confirmation extends obsidian.Modal {
      onOpen(){
        this.modalEl.classList.add("ignis-management-modal");
        this.setTitle(title);
        const text=host.document.createElement('p');text.textContent=message;
        const actions=host.document.createElement('div');actions.className='ignis-ui-actions';
        const cancel=host.document.createElement('button');cancel.textContent='Cancel';cancel.onclick=()=>this.close();
        const accept=host.document.createElement('button');accept.textContent=action;accept.className='mod-warning';
        accept.onclick=()=>{this.accepted=true;this.close();};
        actions.append(cancel,accept);this.contentEl.append(text,actions);cancel.focus();
        this.lost=()=>this.close();host.addEventListener('ignis:auth-lost',this.lost);
      }
      onClose(){host.removeEventListener('ignis:auth-lost',this.lost);this.contentEl.empty();resolve(this.accepted===true && !host.__ignisAuth?.blocked);}
    }
    new Confirmation(app).open();
  });
}
