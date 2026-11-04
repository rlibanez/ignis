import {createManagementClient} from './client.js';
import {readDirectory,directoryFromDrop,folderFromFiles,zipFromDrop} from './folder-source.js';
import {createExclusionsModal} from './import-exclusions.js';
const t=text=>globalThis.IgnisI18n?.t(text)??text;
export function createImportModal(Modal,Notice){
 const ExclusionsModal=createExclusionsModal(Modal);
 return class ImportModal extends Modal{
  constructor(app,session){super(app);this.session=session;this.abort=new AbortController();this.request=createManagementClient({signal:this.abort.signal,timeoutMs:300000});this.entries=[];this.selection=null;this.stage=null;this.committing=false;this.closed=false;const hex=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');this.attempt=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}
  onOpen(){
   this.setTitle(t('Import vault'));this.modalEl.addClass('mod-lg','mod-form','ignis-password-modal','ignis-import-wizard');
   const form=this.contentEl.createEl('form');form.addEventListener('submit',e=>e.preventDefault());
   this.pages=[0,1,2,3].map(()=>form.createDiv());
   const field=(parent,text)=>parent.createEl('label',{cls:'ignis-password-field',text:t(text)});
   const button=(parent,text,action,primary=false)=>{const el=parent.createEl('button',{text:t(text),cls:primary?'mod-cta':''});el.type='button';el.addEventListener('click',action);return el;};
   this.folderSupported=typeof globalThis.showDirectoryPicker==='function';
   const source=field(this.pages[0],'Source');this.source=source.createEl('select',{cls:'dropdown'});
   for(const [value,text] of [['zip','ZIP file'],['folder','Local folder']]){const option=this.source.createEl('option',{text:t(text)});option.value=value;}
   this.picker=this.pages[0].createEl('input');this.picker.type='file';this.picker.hidden=true;this.picker.accept='.zip,application/zip';
   const configure=()=>{this.picker.value='';this.picker.webkitdirectory=this.source.value==='folder';this.picker.multiple=this.source.value==='folder';this.picker.accept=this.source.value==='zip'?'.zip,application/zip':'';this.entries=[];this.selection=null;this.zipFile=null;this.selected.hidden=true;this.selectedName.textContent='';this.selectedCounts.textContent='';this.name.value='';if(typeof this.step==='number')this.show();};
   this.source.addEventListener('change',configure);
   this.selected=this.pages[0].createDiv({cls:'ignis-import-selection',attr:{role:'status'}});
   this.selectedName=this.selected.createEl('strong');this.selectedCounts=this.selected.createEl('small',{cls:'setting-item-description'});
   this.picker.addEventListener('change',()=>{
    if(this.closed||this.busy||this.selecting)return;
    if(!this.picker.files.length){const folder=this.source.value==='folder';configure();if(folder)new Notice(t('No files were provided. Drag the folder here to import an empty folder.'));return;}
    if(this.source.value==='zip'){this.setZip(this.picker.files[0]);return;}
    try{const {name,entries}=folderFromFiles(Array.from(this.picker.files));this.setFolder(name,entries);}
    catch(error){configure();new Notice(error.message);}
   });
   this.dropZone=this.pages[0].createDiv({cls:'ignis-import-drop',attr:{role:'button',tabindex:'0','data-import-drop':''}});
   this.dropZone.addEventListener('click',()=>{this.selectSource();});
   this.dropZone.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();this.selectSource();}});
   this.dropZone.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';this.dropZone.classList.add('is-dragover');});
   this.dropZone.addEventListener('dragleave',()=>this.dropZone.classList.remove('is-dragover'));
   this.dropZone.addEventListener('drop',event=>{
    event.preventDefault();event.stopPropagation();this.dropZone.classList.remove('is-dragover');if(this.busy||this.selecting)return;
    if(this.source.value==='folder'){void this.selectDirectory(directoryFromDrop(event.dataTransfer));return;}
    try{this.setZip(zipFromDrop(event.dataTransfer));}catch(error){new Notice(error.message);}
   });
   this.folderWarning=this.pages[0].createEl('p',{cls:'setting-item-description',text:t('This folder picker does not report empty folders. Drag the folder here or use ZIP to include them.')});
   this.pages[0].createEl('p',{text:t('Maximum: 10000 files and folders, 32 MiB per file, 256 MiB total; ZIP upload up to 64 MiB.')});
   this.pages[0].createEl('p',{text:t('A single outer ZIP folder is treated as the vault name.')});
   this.name=field(this.pages[1],'Vault name').createEl('input');this.name.type='text';this.name.required=true;this.name.maxLength=255;this.name.addEventListener('input',()=>this.name.setCustomValidity(''));
   const preferences=this.pages[1].createEl('label',{cls:'ignis-password-field'});preferences.style.flexDirection='row';preferences.style.alignItems='center';this.configuration=preferences.createEl('input');this.configuration.type='checkbox';preferences.createSpan({text:t('Import Obsidian preferences')});
   this.pages[1].createEl('p',{text:t('App, hotkey and graph preferences are imported by default. You can select additional preferences in Excluded items. Plugins, themes, hidden state and sharing permissions remain excluded. Community plugins start disabled.')});
   this.pages[1].createEl('p',{text:t('The new vault belongs to your account. It will only become available after the import completes.')});
   this.review=this.pages[2].createEl('p');this.review.style.whiteSpace='pre-line';this.reviewSummary=this.review.createSpan();
   this.excludedLink=this.review.createEl('a',{attr:{href:'#','aria-haspopup':'dialog','data-import-exclusions':''}});
   this.excludedLink.addEventListener('click',event=>{event.preventDefault();if(this.busy||!this.exclusionEntries?.length||this.excludedModal)return;this.excludedModal=new ExclusionsModal(this.app,this.exclusionEntries,()=>{this.excludedModal=null;},async selected=>{this.busy=true;this.next.disabled=this.back.disabled=true;try{await this.applySelection(selected);}finally{this.busy=false;if(!this.closed)this.show();}});this.excludedModal.open();});
   this.progress=form.createEl('progress');this.progress.hidden=true;this.status=form.createEl('p',{attr:{role:'status'}});
   const actions=form.createDiv({cls:'modal-button-container'});
   this.cancel=button(actions,'Cancel',()=>this.close());this.cancel.setAttribute('data-import-cancel','');this.back=button(actions,'Back',()=>void this.previous());this.next=button(actions,'Next',()=>void this.advance(),true);this.next.setAttribute('data-import-next','');
   this.openButton=button(actions,'Open vault',()=>{window.location.assign('/?vault='+encodeURIComponent(this.result.id));},true);
   configure();this.step=0;this.show();window.addEventListener('ignis:auth-lost',()=>{this.committing=false;this.close();},{signal:this.abort.signal});
  }
  setSelection(name,vaultName,description){this.selection=name;this.name.value=vaultName;this.selectedName.textContent=name;this.selectedCounts.textContent=description;this.selected.hidden=false;this.show();}
  setZip(file){this.zipFile=file;this.setSelection(file.name,file.name.replace(/\.zip$/i,''),(file.size/1048576).toFixed(1)+' MiB');}
  setFolder(name,entries){this.entries=entries;this.setSelection(name,name,t('Files')+': '+entries.filter(e=>e.kind==='file').length+' · '+t('Folders')+': '+entries.filter(e=>e.kind==='directory').length);}
  selectSource(){
   if(this.busy||this.selecting)return;
   if(this.source.value==='zip'||!this.folderSupported){this.picker.value='';this.picker.click();return;}
   // Call directly in the click gesture, before awaiting anything.
   try{void this.selectDirectory(globalThis.showDirectoryPicker({mode:'read',id:'ignis-import-vault'}));}
   catch(error){void this.selectDirectory(Promise.reject(error));}
  }
  async selectDirectory(pending){
   this.selecting=true;this.show();
   try{
    const directory=await pending,entries=await readDirectory(directory,this.abort.signal);this.abort.signal.throwIfAborted();this.setFolder(directory.name,entries);
   }catch(error){if(!this.closed&&error.name!=='AbortError'){
    if(['SecurityError','NotSupportedError','TypeError'].includes(error.name))this.folderSupported=false;
    new Notice(error.name==='Error'?error.message:t('Unable to read the selected folder. Use a ZIP file or try again.'));
   }}
   finally{this.selecting=false;if(!this.closed)this.show();}
  }
  show(){const zip=this.source.value==='zip';this.dropZone.textContent=t(zip?'Click here or drop a ZIP file.':'Click here or drop a folder');this.dropZone.setAttribute('aria-disabled',String(!!(this.busy||this.selecting)));this.dropZone.setAttribute('aria-label',this.dropZone.textContent);this.folderWarning.hidden=zip||this.folderSupported;this.next.disabled=!!(this.busy||this.selecting||(this.step===0&&!this.selection));this.back.disabled=this.source.disabled=!!(this.busy||this.selecting);this.pages.forEach((page,i)=>{page.hidden=i!==this.step;});this.back.hidden=this.step===0||this.step===3;this.next.hidden=this.step===3;this.openButton.hidden=this.step!==3;this.next.textContent=t(this.step===1?'Review import':this.step===2?'Import':'Next');this.cancel.textContent=t(this.step===3?'Close':'Cancel');}
  async api(operation,input={},binary=false,query={}){
   if(!this.csrfToken||Date.now()-this.csrfAt>300000){const csrf=await this.request('/api/auth/csrf');if(!csrf.ok)throw Error(t('Session unavailable'));this.csrfToken=(await csrf.json()).csrfToken;this.csrfAt=Date.now();}
   const url='/api/vault/import/'+operation+new URLSearchParams(query).toString().replace(/^(.+)$/,'?$1');
   const response=await this.request(url,{method:'POST',headers:{'Content-Type':binary?'application/octet-stream':'application/json','X-Ignis-Csrf':this.csrfToken,'X-Ignis-Context':this.session.sessionId},body:binary?input:JSON.stringify(input)});
   const result=await response.json();if(!response.ok)throw Object.assign(Error(t(result.error||'Import could not be completed.')),{status:response.status});return result;
  }
  async discard(){if(!this.stage)return;const id=this.stage.id;try{await this.api('cancel',{},false,{id});}catch(error){if(error.status!==404)throw error;}this.stage=null;this.started=false;}
  async previous(){if(this.busy)return;this.excludedModal?.close();this.busy=true;this.back.disabled=this.next.disabled=true;try{await this.discard();this.step--;this.status.textContent='';this.show();}catch(error){new Notice(error.message);}finally{this.busy=false;if(!this.closed)this.show();}}
  async prepareStage(selected=[]){
   if(this.stage)await this.discard();
   if(this.started&&!this.stage)await this.api('cancel',{attempt:this.attempt});
   this.started=true;this.progress.hidden=false;this.progress.removeAttribute('value');this.status.textContent=t('Preparing import…');
   const data={name:this.name.value.trim(),configuration:this.configuration.checked,attempt:this.attempt,selected};
   if(this.source.value==='zip')this.stage=await this.api('zip',this.zipFile,true,{name:data.name,configuration:String(data.configuration),attempt:this.attempt,selected:JSON.stringify(selected)});
   else this.stage=await this.api('start',{...data,files:this.entries.map(({path,kind,size})=>({path,kind,size}))});
   this.uploaded=new Set();this.pendingSelection=null;this.updateReview();
  }
  async applySelection(selected){
   this.pendingSelection=selected;this.stage=await this.api('select',{selected},false,{id:this.stage.id});this.pendingSelection=null;this.updateReview();
  }
  updateReview(){
   this.exclusionEntries=this.stage.excludedEntries;
   this.reviewSummary.textContent=this.name.value+'\n'+t('Files')+': '+this.stage.files+'\n'+t('Folders')+': '+this.stage.directories+'\n'+t('Size')+': '+(this.stage.bytes/1048576).toFixed(1)+' MiB\n';this.excludedLink.textContent=t('Excluded')+': '+this.stage.excluded;this.excludedLink.hidden=this.stage.excludedEntries.length===0;
  }
  async advance(){
   if(this.busy)return;
   if(this.step===0){if(!this.selection){new Notice(t('Select a folder or ZIP file first.'));return;}this.step=1;this.status.textContent='';this.show();this.name.focus();return;}
   if(this.step===1){this.name.value=this.name.value.trim();if(!this.name.reportValidity())return;}
   this.busy=true;this.next.disabled=this.back.disabled=true;this.status.textContent='';
   try{
    if(this.step===1){
     await this.prepareStage([]);
     this.step=2;this.status.textContent='';
    }else if(this.step===2){
     if(this.pendingSelection)await this.applySelection(this.pendingSelection);
     this.excludedModal?.close();this.progress.hidden=false;
     if(this.source.value==='folder')for(const [position,index] of this.stage.upload.entries()){this.progress.max=this.stage.upload.length;this.progress.value=position;this.status.textContent=t('Uploading files…')+' '+(position+1)+' / '+this.stage.upload.length;if(!this.uploaded.has(index)){await this.api('file',this.entries[index].file,true,{id:this.stage.id,index:String(index)});this.uploaded.add(index);}}
     this.committing=true;this.cancel.disabled=true;this.status.textContent=t('Finishing import…');this.progress.removeAttribute('value');
     this.result=await this.api('commit',{},false,{id:this.stage.id});this.stage=null;this.step=3;window.dispatchEvent(new Event('ignis:vaults-changed'));this.status.textContent=t('Vault imported successfully.');
    }
   }catch(error){if(!this.closed){this.status.textContent='';if(error.status===409){this.step=1;this.show();this.name.setCustomValidity(t('A vault with this name already exists.'));this.name.reportValidity();}else new Notice(error.message);}}
   finally{this.committing=false;this.busy=false;this.cancel.disabled=this.next.disabled=this.back.disabled=false;this.progress.hidden=true;if(!this.closed)this.show();}
  }
  close(){if(!this.committing)super.close();}
  onClose(){this.excludedModal?.close();this.closed=true;this.abort.abort();if(this.started&&!this.result){const id=this.stage?.id,attempt=this.attempt,session=this.session.sessionId;void (async()=>{try{const csrf=await fetch('/api/auth/csrf',{credentials:'same-origin'});if(csrf.ok)await fetch('/api/vault/import/cancel'+(id?'?id='+encodeURIComponent(id):''),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Ignis-Csrf':(await csrf.json()).csrfToken,'X-Ignis-Context':session},body:JSON.stringify(id?{}:{attempt})});}catch{/* Expiring private staging is never published. */}})();}this.contentEl.empty();}
 };
}
