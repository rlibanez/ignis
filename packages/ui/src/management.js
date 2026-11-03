import {X, Eye, EyeOff, User, ArrowLeft} from 'lucide-svelte';
import settingsShellStyles from './settings-shell.css';
import {createManagementModal} from '../../management/src/management-modal.js';
import {createAccountSettings} from '../../management/src/account-settings.js';
import {consumeManagementIntent} from '../../management/src/intent.js';
const t=text=>globalThis.IgnisI18n?.t(text) ?? text;
// Small DOM host for the same account forms/controllers when no Obsidian vault
// exists. No fake app, Obsidian module or global DOM prototype patches.
function element(tag,options={}) {
  const el=document.createElement(tag);
  if(options.cls)el.className=options.cls;
  if(options.text!==undefined)el.textContent=options.text;
  for(const key of ['type'])if(options[key])el[key]=options[key];
  for(const [key,value] of Object.entries(options.attr || {}))el.setAttribute(key,value);
  el.addClass=(...names)=>el.classList.add(...names);
  el.empty=()=>el.replaceChildren();
  el.createEl=(name,attrs)=>{const child=element(name,attrs);el.append(child);return child;};
  el.createDiv=attrs=>el.createEl('div',attrs);
  el.createSpan=attrs=>el.createEl('span',attrs);
  return el;
}
const icons=new WeakMap();
function setIcon(target,name){
  icons.get(target)?.$destroy();target.replaceChildren();
  const Icon=({x:X,eye:Eye,'eye-off':EyeOff,user:User,'arrow-left':ArrowLeft})[name] || X;
  icons.set(target,new Icon({target,props:{size:18}}));
}
export class BrowserModal {
  constructor(){
    if(!window.app?.workspace)document.body.classList.add('styled-scrollbars');
    this.containerEl=element('div',{cls:'modal-container ignis-shell-modal'});
    // The Svelte vault manager is at 99999; preserve native layer ordering above it.
    this.containerEl.style.cssText='position:fixed;inset:0;z-index:calc(100000 + var(--layer-modal,50));display:flex;align-items:center;justify-content:center';
    const backdrop=this.containerEl.createDiv({cls:'modal-bg'});
    backdrop.style.cssText='position:absolute;inset:0';
    this.modalEl=this.containerEl.createDiv({cls:'modal'});
    this.modalEl.style.cssText='position:relative;overflow:auto';
    const close=this.modalEl.createEl('button',{type:'button',cls:'modal-header-button mod-raised clickable-icon',attr:{'aria-label':t('Close'),'data-ignis-close':''}});
    setIcon(close,'x');close.addEventListener('click',()=>this.close());
    this.headerEl=this.modalEl.createDiv({cls:'modal-header'});
    this.titleEl=this.headerEl.createDiv({cls:'modal-title'});
    this.contentEl=this.modalEl.createDiv({cls:'modal-content'});
    this.modalEl.setAttribute('role','dialog');this.modalEl.setAttribute('aria-modal','true');
    this.titleEl.id=`ignis-shell-heading-${++sequence}`;this.modalEl.setAttribute('aria-labelledby',this.titleEl.id);
    // Obsidian's delegated tooltip renderer is unavailable before a vault opens.
    // Use its tooltip class in this host, outside the form's layout.
    const hideHelp=()=>{this.tooltip?.remove();this.tooltip=null;};
    this.containerEl.addEventListener('pointerover',event=>{
      const button=event.target.closest?.('.ignis-password-help');
      if(!button)return;
      hideHelp();
      this.tooltip=element('div',{cls:'tooltip',text:button.getAttribute('aria-label'),attr:{role:'tooltip'}});
      const rect=button.getBoundingClientRect();
      this.tooltip.style.cssText=`position:fixed;z-index:calc(100000 + var(--layer-tooltip,70));transform:none;margin:0;max-height:calc(100dvh - 16px);overflow:auto;max-width:min(320px,calc(100vw - 16px));white-space:normal;left:${Math.max(8,Math.min(rect.left,window.innerWidth-328))}px;top:${rect.bottom+8}px`;
      // A dialog is in the browser top layer: help must belong to that layer too.
      (button.closest('dialog[open]') || this.containerEl).append(this.tooltip);
      const height=this.tooltip.getBoundingClientRect().height;
      const top=rect.bottom+8+height>window.innerHeight-8?rect.top-height-8:rect.bottom+8;
      this.tooltip.style.top=`${Math.max(8,Math.min(top,window.innerHeight-height-8))}px`;
    });
    this.containerEl.addEventListener('pointerout',hideHelp);
    this.lost=()=>this.close();
    this.keydown=event=>{
      if([...document.querySelectorAll('.ignis-shell-modal')].at(-1)!==this.containerEl || this.containerEl.querySelector('dialog[open]'))return;
      if(event.key==='Tab'){
        const fields=[...this.containerEl.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el=>!el.disabled && el.tabIndex>=0 && el.getClientRects().length);
        const first=fields[0],last=fields.at(-1);
        if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
      }
      if(event.key==='Escape' && [...document.querySelectorAll('.ignis-shell-modal')].at(-1)===this.containerEl && !this.containerEl.querySelector('dialog[open]')){event.preventDefault();this.close();}
    };
  }
  setTitle(title){this.titleEl.textContent=title;}
  open(){
    if(!window.app?.workspace && (document.body.classList.contains('is-mobile') || window.matchMedia('(max-width: 599px)').matches)){
      document.body.classList.add('is-mobile','is-phone');
      this.containerEl.style.alignItems='flex-start';
      this.containerEl.style.paddingTop='max(var(--safe-area-inset-top,0px),env(safe-area-inset-top,0px))';
      this.modalEl.addClass('mod-lg');
      this.modalEl.style.margin='0';this.modalEl.style.width='100%';
      this.modalEl.style.maxHeight='calc(100dvh - max(var(--safe-area-inset-top,0px),env(safe-area-inset-top,0px)))';
    }
    this.previousFocus=document.activeElement;
    document.body.append(this.containerEl);document.addEventListener('keydown',this.keydown);
    window.addEventListener('ignis:auth-lost',this.lost);window.addEventListener('pagehide',this.lost);
    this.onOpen?.();
    if(document.activeElement===this.previousFocus)this.containerEl.querySelector('button,input')?.focus();
    return this;
  }
  close(){if(!this.containerEl.isConnected)return;this.onClose?.();document.removeEventListener('keydown',this.keydown);window.removeEventListener('ignis:auth-lost',this.lost);window.removeEventListener('pagehide',this.lost);this.containerEl.remove();if(this.previousFocus?.isConnected)this.previousFocus.focus();}
}
let sequence=0;
class Notice {
  constructor(message){
    let container=document.querySelector('.ignis-shell-notices');
    if(!container){container=element('div',{cls:'notice-container ignis-shell-notices'});container.style.zIndex='calc(100000 + var(--layer-notice,60))';document.body.append(container);}
    const el=container.createDiv({cls:'notice',attr:{role:'alert'}});
    el.createDiv({cls:'notice-message',text:message});
    const remove=()=>{el.remove();if(!container.childElementCount)container.remove();};
    const timeout=setTimeout(remove,5000);
    el.addEventListener('click',()=>{clearTimeout(timeout);remove();},{once:true});
  }
}
const ManagementModal=createManagementModal(BrowserModal,setIcon);
const {settingDefinitions}=createAccountSettings({Modal:BrowserModal,Notice,setIcon,ManagementModal});
class AccountModal extends BrowserModal {
  constructor(kind){super();this.kind=kind;}
  onOpen(){
    if(!document.getElementById('ignis-settings-shell-styles')){
      const style=element('style');style.id='ignis-settings-shell-styles';style.textContent=settingsShellStyles;document.head.append(style);
    }
    this.modalEl.addClass('mod-settings','mod-sidebar-layout','ignis-shell-settings');
    this.modalEl.style.overflow='hidden';
    if(!document.body.classList.contains('is-phone')){
      this.modalEl.style.width='var(--modal-width,90vw)';
      this.modalEl.style.maxWidth='var(--modal-max-width,1100px)';
      this.modalEl.style.height='var(--modal-height,85vh)';
    }
    this.contentEl.addClass('vertical-tabs-container');
    const sidebar=this.contentEl.createDiv({cls:'vertical-tab-header'});
    const search=sidebar.createDiv({cls:'setting-search-container'}).createDiv({cls:'search-input-container'});
    this.search=search.createEl('input',{type:'search',attr:{placeholder:t('Search settings...'),'aria-label':t('Search settings...')}});
    const groups=sidebar.createDiv({cls:'vertical-tab-header-group-container'});
    const group=groups.createDiv({cls:'vertical-tab-header-group'});
    group.createDiv({cls:'vertical-tab-header-group-title',text:t('Ignis')});
    const tabs=group.createDiv({cls:'vertical-tab-header-group-items',attr:{role:'tablist','aria-label':t('Settings')}});
    this.accountTab=tabs.createEl('button',{type:'button',cls:'vertical-tab-nav-item is-active',attr:{role:'tab','aria-selected':'true'}});
    this.accountTab.id=`ignis-shell-account-tab-${sequence}`;
    setIcon(this.accountTab.createDiv({cls:'vertical-tab-nav-item-icon'}),'user');
    this.accountTab.createSpan({cls:'vertical-tab-nav-item-title',text:t('Account')});
    const content=this.contentEl.createDiv({cls:'vertical-tab-content-container'});
    this.accountContent=content.createDiv({cls:'vertical-tab-content',attr:{role:'tabpanel','aria-labelledby':this.accountTab.id}});
    this.accountContent.id=`ignis-shell-account-panel-${sequence}`;
    this.accountTab.setAttribute('aria-controls',this.accountContent.id);
    const back=this.modalEl.createEl('button',{type:'button',cls:'modal-header-button mod-start mod-raised clickable-icon',attr:{'aria-label':t('Back')}});
    setIcon(back,'arrow-left');back.addEventListener('click',()=>this.showAccount(false));
    this.accountTab.addEventListener('click',()=>{this.showAccount(true);this.accountContent.querySelector('button')?.focus();});
    this.search.addEventListener('input',()=>this.filter());
    this.tab={app:null,pendingEmailEdit:this.kind==='email',isActive:()=>this.containerEl.isConnected,update:()=>this.render()};
    this.showAccount(true);this.render();
  }
  showAccount(selected){
    this.modalEl.dataset.view=selected?'account':'navigation';
    this.setTitle(t(selected?'Account':'Settings'));
    if(!selected)this.accountTab.focus();
  }
  filter(){
    const query=this.search.value.trim().toLocaleLowerCase();
    const matchesTab=[t('Account'),t('Ignis')].some(text=>text.toLocaleLowerCase().includes(query));
    let visible=0;
    for(const row of this.accountContent.querySelectorAll('.setting-item')){
      row.hidden=!!query && !matchesTab && !row.textContent.toLocaleLowerCase().includes(query);
      if(!row.hidden)visible++;
    }
    if(this.empty)this.empty.hidden=visible>0 || !query;
  }
  render(){
    if(!this.containerEl.isConnected)return;
    this.accountContent.replaceChildren();
    for(const group of settingDefinitions(this.tab)){
      const items=this.accountContent.createDiv({cls:'setting-group'}).createDiv({cls:'setting-items'});
      for(const item of group.items){
        const row=items.createDiv({cls:'setting-item'}),info=row.createDiv({cls:'setting-item-info'});
        if(item.name)info.createDiv({cls:'setting-item-name',text:item.name});
        const desc=info.createDiv({cls:'setting-item-description'}),controls=row.createDiv({cls:'setting-item-control'});
        const setting={settingEl:row,setDesc(text){desc.textContent=text;return this;},addButton(fn){
          const el=controls.createEl('button',{type:'button'});
          const button={setButtonText(text){el.textContent=text;return this;},setDisabled(disabled){el.disabled=disabled;return this;},setWarning(){el.classList.add('mod-destructive','mod-cta');return this;},onClick(fn){el.addEventListener('click',fn);return this;}};
          fn(button);return this;
        }};
        item.render(setting);
      }
    }
    this.empty=this.accountContent.createEl('p',{cls:'ignis-settings-empty',text:t('No results found')});this.empty.hidden=true;
    this.filter();
  }
}
export function openAccount(kind='account') {
  if(window.__ignisOpenManagement && window.app?.workspace){window.__ignisOpenManagement(kind);return;}
  if(['users','shares'].includes(kind))new ManagementModal(null,kind).open();
  else if(kind==='password')new ManagementModal(null,'password',{passwordSetup:true}).open();
  else new AccountModal(kind).open();
}
export function openRequestedManagement(){consumeManagementIntent(window,openAccount);}
