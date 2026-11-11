import {showManagementNotice} from "./ui-notice.js";
import {installUiLayout} from "./ui-layout.js";
import {appendUiControl} from "./ui-controls.js";
const t=text=>globalThis.IgnisI18n?.t(text)??text;
export function createExportModal(Modal,Notice){
 return class ExportModal extends Modal {
  constructor(app,vault){super(app);this.vault=vault;this.abort=new AbortController();window.addEventListener("ignis:auth-lost",()=>this.close(),{signal:this.abort.signal});}
  onOpen(){
   installUiLayout(document);this.modalEl.addClass("ignis-ui-form");
   this.setTitle(t('Export vault')+' '+this.vault.name);
   this.modalEl.addClass('mod-lg','mod-form','ignis-password-modal');
   this.contentEl.createEl('p',{text:t('Download your vault as a ZIP. Resources shared with you by other users are excluded. Accounts and sharing permissions are not exported.')});
   const options=this.contentEl.createDiv({cls:'ignis-export-options'});
   const addOption=(title,description)=>{
    const group=options.createDiv({cls:'ignis-transfer-option'});
    const label=group.createEl('label',{cls:'ignis-import-enable'});
    const checkbox=appendUiControl(label,"input",{type:"checkbox"});
    label.createSpan({text:t(title)});
    group.createEl('p',{cls:'setting-item-description',text:t(description)});
    return checkbox;
   };
   const configuration=addOption('Export Obsidian preferences','May include themes, CSS snippets, hotkeys, workspaces and graph settings.');
   const plugins=addOption('Community add-ons','Includes installed community add-ons, their settings and activation state. Keep this archive private.');
   this.contentEl.createEl('p',{cls:'setting-item-description',text:t('Limits: 10000 entries, 32 MiB per file, 256 MiB total and 64 MiB ZIP. Links, trash and temporary files are excluded.')});
   const progress=this.contentEl.createEl('progress');progress.hidden=true;progress.style.width='100%';progress.setAttribute('aria-label',t('Preparing export…'));
   const buttons=this.contentEl.createDiv({cls:'modal-button-container'});
   const cancel=appendUiControl(buttons,"button",{text:t('Cancel')});cancel.type='button';cancel.addEventListener('click',()=>this.close());
   const submit=appendUiControl(buttons,"button",{text:t('Export'),cls:'mod-cta'});submit.type='button';
   submit.addEventListener('click',async()=>{
    submit.disabled=configuration.disabled=plugins.disabled=true;progress.hidden=false;
    try {
     const session=globalThis.__ignisAuth?.sessionId;
     if(!session || globalThis.__ignisAuth?.blocked)throw Error(t('Session unavailable'));
     const csrfReply=await fetch('/api/auth/csrf',{credentials:'same-origin',cache:'no-store',signal:this.abort.signal});
     const csrf=await csrfReply.json();if(!csrfReply.ok)throw Error(t('Export could not be completed.'));
     const reply=await fetch('/api/vault/export',{method:'POST',credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(300000)]),headers:{'Content-Type':'application/json','X-Ignis-CSRF':csrf.csrfToken,...(session?{'X-Ignis-Context':session}:{})},body:JSON.stringify({vault:this.vault.uuid,configuration:configuration.checked,plugins:plugins.checked})});
     if(!reply.ok){const error=await reply.json();throw Error(t(error.error||'Export could not be completed.'));}
     const blob=await reply.blob();this.abort.signal.throwIfAborted();
     if(globalThis.__ignisAuth?.blocked || globalThis.__ignisAuth?.sessionId!==session)throw Error(t('Session changed'));
     const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=this.vault.name+'.zip';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);this.close();
    }catch(error){if(!this.abort.signal.aborted)showManagementNotice(Notice,error.message);}
    finally{submit.disabled=configuration.disabled=plugins.disabled=false;progress.hidden=true;}
   });
   submit.focus();
  }
  onClose(){this.abort.abort();this.contentEl.empty();}
 };
}
