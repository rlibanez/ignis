const t=text=>globalThis.IgnisI18n?.t(text)??text;
export function createExportModal(Modal,Notice){
 return class ExportModal extends Modal {
  constructor(app,vault){super(app);this.vault=vault;this.abort=new AbortController();}
  onOpen(){
   this.setTitle(t('Export vault')+' '+this.vault.name);
   this.modalEl.addClass('mod-lg','mod-form','ignis-password-modal');
   this.contentEl.createEl('p',{text:t('Download your vault as a ZIP. Resources shared with you by other users are excluded. Accounts and sharing permissions are not exported.')});
   const label=this.contentEl.createEl('label',{cls:'ignis-export-options'});
   const checkbox=label.createEl('input');checkbox.type='checkbox';
   label.createSpan({text:t('Include Obsidian configuration')});
   this.contentEl.createEl('p',{cls:'setting-item-description',text:t('Configuration includes installed plugins and themes. Keep this archive private. The import wizard excludes plugins and themes when restoring it.')});
   this.contentEl.createEl('p',{cls:'setting-item-description',text:t('Limits: 10000 entries, 32 MiB per file, 256 MiB total and 64 MiB ZIP. Links, trash and temporary files are excluded.')});
   const progress=this.contentEl.createEl('progress');progress.hidden=true;progress.style.width='100%';progress.setAttribute('aria-label',t('Preparing export…'));
   const buttons=this.contentEl.createDiv({cls:'modal-button-container'});
   const cancel=buttons.createEl('button',{text:t('Cancel')});cancel.type='button';cancel.addEventListener('click',()=>this.close());
   const submit=buttons.createEl('button',{text:t('Export'),cls:'mod-cta'});submit.type='button';
   submit.addEventListener('click',async()=>{
    submit.disabled=checkbox.disabled=true;progress.hidden=false;
    try {
     const session=globalThis.__ignisAuth?.sessionId;
     if(!session || globalThis.__ignisAuth?.blocked)throw Error(t('Session unavailable'));
     const csrfReply=await fetch('/api/auth/csrf',{credentials:'same-origin',cache:'no-store',signal:this.abort.signal});
     const csrf=await csrfReply.json();if(!csrfReply.ok)throw Error(t('Export could not be completed.'));
     const reply=await fetch('/api/vault/export',{method:'POST',credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(300000)]),headers:{'Content-Type':'application/json','X-Ignis-CSRF':csrf.csrfToken,...(session?{'X-Ignis-Context':session}:{})},body:JSON.stringify({vault:this.vault.uuid,configuration:checkbox.checked})});
     if(!reply.ok){const error=await reply.json();throw Error(t(error.error||'Export could not be completed.'));}
     const blob=await reply.blob();this.abort.signal.throwIfAborted();
     if(globalThis.__ignisAuth?.blocked || globalThis.__ignisAuth?.sessionId!==session)throw Error(t('Session changed'));
     const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=this.vault.name+'.zip';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);this.close();
    }catch(error){if(!this.abort.signal.aborted)new Notice(error.message);}
    finally{submit.disabled=checkbox.disabled=false;progress.hidden=true;}
   });
   submit.focus();
  }
  onClose(){this.abort.abort();this.contentEl.empty();}
 };
}
