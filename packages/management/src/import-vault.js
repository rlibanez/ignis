import {createManagementClient} from './client.js';
import {readDirectory,directoryFromDrop,folderFromFiles,zipFromDrop} from './folder-source.js';
import {createExclusionsModal} from './import-exclusions.js';
const t=text=>globalThis.IgnisI18n?.t(text)??text;
export function createImportModal(Modal,Notice){
 const ExclusionsModal=createExclusionsModal(Modal);
 return class ImportModal extends Modal{
  constructor(app,session){super(app);this.session=session;this.abort=new AbortController();this.request=createManagementClient({signal:this.abort.signal,timeoutMs:3600000});this.entries=[];this.selection=null;this.stage=null;this.plans=[];this.sourceStage=null;this.committing=false;this.closed=false;const hex=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');this.attempt=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}
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
   this.pages[0].createEl('p',{text:t('Maximum: 10000 files and folders, 512 MiB per file, 4 GiB total; ZIP upload up to 1 GiB.')});
   this.singleOptions=this.pages[1].createDiv();this.detectedOptions=this.pages[1].createDiv({cls:'ignis-import-detected'});this.sourceDetails=this.pages[1].createEl('p',{cls:'setting-item-description'});this.outsideLink=this.pages[1].createEl('a',{attr:{href:'#'}});this.outsideLink.addEventListener('click',event=>{event.preventDefault();this.openExclusions(null,this.sourceStage.outside);});
   this.name=field(this.singleOptions,'Vault name').createEl('input');this.name.type='text';this.name.required=true;this.name.maxLength=255;this.name.addEventListener('input',()=>this.name.setCustomValidity(''));
   const preferences=this.singleOptions.createEl('label',{cls:'ignis-password-field'});preferences.style.flexDirection='row';preferences.style.alignItems='center';this.configuration=preferences.createEl('input');this.configuration.type='checkbox';preferences.createSpan({text:t('Import Obsidian preferences')});this.configuration.addEventListener('change',()=>{const plan=this.plans[0];if(plan){plan.configuration=this.configuration.checked;if(!plan.configuration)plan.selected=[];plan.review=null;}});
   this.singleOptions.createEl('p',{text:t('App, hotkey and graph preferences are imported by default. You can select additional preferences in Excluded items. Plugins, themes, hidden state and sharing permissions remain excluded. Community plugins start disabled.')});
   this.singleOptions.createEl('p',{text:t('The new vault belongs to your account. It will only become available after the import completes.')});
   this.review=this.pages[2].createEl('p');this.review.style.whiteSpace='pre-line';this.reviewSummary=this.review.createSpan();
   this.excludedLink=this.review.createEl('a',{attr:{href:'#','aria-haspopup':'dialog','data-import-exclusions':''}});
   this.excludedLink.addEventListener('click',event=>{event.preventDefault();this.openExclusions(this.plans[0]);});
   this.batchReview=this.pages[2].createDiv({cls:'ignis-import-detected'});this.completedList=this.pages[3].createDiv({cls:'ignis-import-detected'});
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
  show(){for(const plan of this.plans){if(plan.input)plan.input.disabled=!!(this.busy||this.selecting||plan.result||!plan.enabled);if(plan.check)plan.check.disabled=!!(this.busy||this.selecting||plan.result);if(plan.configInput)plan.configInput.disabled=!!(this.busy||this.selecting||plan.result||!plan.enabled);}this.configuration.disabled=!!(this.busy||this.selecting);const zip=this.source.value==='zip';this.dropZone.textContent=t(zip?'Click here or drop a ZIP file.':'Click here or drop a folder');this.dropZone.setAttribute('aria-disabled',String(!!(this.busy||this.selecting)));this.dropZone.setAttribute('aria-label',this.dropZone.textContent);this.folderWarning.hidden=zip||this.folderSupported;this.next.disabled=!!(this.busy||this.selecting||(this.step===0&&!this.selection)||(this.step===1&&this.plans.length>1&&!this.plans.some(p=>p.enabled)));this.back.disabled=this.source.disabled=!!(this.busy||this.selecting);this.pages.forEach((page,i)=>{page.hidden=i!==this.step;});this.back.hidden=this.step===0||this.step===3;this.next.hidden=this.step===3;this.openButton.hidden=this.step!==3||this.plans.length!==1;this.next.textContent=t(this.step===1?'Review import':this.step===2?'Import':'Next');this.cancel.textContent=t(this.step===3?'Close':'Cancel');}
  async api(operation,input={},binary=false,query={}){
   if(!this.csrfToken||Date.now()-this.csrfAt>300000){const csrf=await this.request('/api/auth/csrf');if(!csrf.ok)throw Error(t('Session unavailable'));this.csrfToken=(await csrf.json()).csrfToken;this.csrfAt=Date.now();}
   const url='/api/vault/import/'+operation+new URLSearchParams(query).toString().replace(/^(.+)$/,'?$1');
   const response=await this.request(url,{method:'POST',headers:{'Content-Type':binary?'application/octet-stream':'application/json','X-Ignis-Csrf':this.csrfToken,'X-Ignis-Context':this.session.sessionId},body:binary?input:JSON.stringify(input)});
   const result=await response.json();if(!response.ok)throw Object.assign(Error(t(result.error||'Import could not be completed.')),{status:response.status});return result;
  }
  inputFor(plan){return {id:this.sourceStage.id,root:plan.root,name:plan.name.trim(),configuration:plan.configuration,selected:plan.selected};}
  async scanSource(){
   if(this.scanStarted&&!this.sourceStage)await this.api('cancel-source',{attempt:this.attempt});
   this.scanStarted=true;
   this.sourceStage=this.source.value==='zip'?await this.api('scan-zip',this.zipFile,true,{attempt:this.attempt}):await this.api('scan',{attempt:this.attempt,files:this.entries.map(({path,kind,size})=>({path,kind,size}))});
   this.plans=this.sourceStage.vaults.map(v=>({...v,name:v.name||this.name.value,enabled:true,configuration:false,selected:[],uploaded:new Set()}));
   const many=this.plans.length>1;this.setTitle(t(many?'Import vaults':'Import vault'));this.singleOptions.hidden=many;this.detectedOptions.hidden=!many;this.detectedOptions.empty();
   this.sourceDetails.textContent=this.sourceStage.nested.length?t('Nested vaults remain inside their containing vault and are not imported separately.')+' '+this.sourceStage.nested.join(', '):'';
   this.sourceDetails.hidden=!this.sourceStage.nested.length;
   this.outsideLink.textContent=t('Outside detected vaults')+': '+this.sourceStage.outside.length;this.outsideLink.hidden=!this.sourceStage.outside.length;
   if(!many){this.name.value=this.plans[0].name;this.configuration.checked=false;this.plans[0].input=this.name;return;}
   this.detectedOptions.createEl('p',{text:t('Select the vaults to import. Names and preferences are independent for each vault.')});
   for(const plan of this.plans){
    const row=this.detectedOptions.createDiv({cls:'ignis-import-vault'}),enable=row.createEl('label',{cls:'ignis-import-enable'}),check=enable.createEl('input',{attr:{type:'checkbox'}});check.checked=true;enable.createEl('strong',{text:plan.root});
    const name=row.createEl('label',{cls:'ignis-password-field',text:t('Vault name')}).createEl('input');name.type='text';name.value=plan.name;name.maxLength=255;name.required=true;plan.input=name;plan.check=check;
    name.addEventListener('input',()=>{plan.name=name.value;name.setCustomValidity('');});
    const label=row.createEl('label',{cls:'ignis-import-enable'}),config=label.createEl('input',{attr:{type:'checkbox'}});plan.configInput=config;label.createSpan({text:t('Import Obsidian preferences')});
    config.addEventListener('change',()=>{plan.configuration=config.checked;if(!config.checked)plan.selected=[];plan.review=null;});
    check.addEventListener('change',()=>{plan.enabled=check.checked;name.disabled=config.disabled=!check.checked;this.show();});
   }
  }
  async openExclusions(plan,entries=plan?.review?.excludedEntries){
   if(this.busy||this.excludedModal||!entries?.length)return;
   this.excludedModal=new ExclusionsModal(this.app,entries,()=>{this.excludedModal=null;},plan?async selected=>{
    if(!plan)return;
    // Save the choice only after the server validates it. Another vault's
    // choices never enter this request, even if both have the same paths.
    this.busy=true;this.show();try{const review=await this.api('review',{...this.inputFor(plan),selected});plan.selected=selected;plan.review=review;this.updateReview();}finally{this.busy=false;if(!this.closed)this.show();}
   }:null);this.excludedModal.open();this.excludedModal.setTitle(t(plan?'Excluded items':'Outside detected vaults')+(plan?' '+plan.name:''));
  }
  async discard(){for(const plan of this.plans)if(plan.stage&&!plan.result){try{await this.api('cancel',{},false,{id:plan.stage.id});}catch(error){if(error.status!==404)throw error;}plan.stage=null;plan.uploaded.clear();}}
  async previous(){
   if(this.busy)return;this.excludedModal?.close();this.busy=true;this.show();
   try{await this.discard();if(this.step===1){try{await this.api('cancel-source',{id:this.sourceStage.id});}catch(error){if(error.status!==404)throw error;}this.sourceStage=null;this.scanStarted=false;this.plans=[];}this.step--;this.status.textContent='';}
   catch(error){new Notice(error.message);}finally{this.busy=false;if(!this.closed)this.show();}
  }
  updateReview(){
   const many=this.plans.length>1;this.review.hidden=many;this.batchReview.hidden=!many;this.batchReview.empty();
   for(const plan of this.plans.filter(p=>p.enabled)){
    if(!plan.review)continue;
    const data=plan.review,summary=plan.name+'\n'+t('Files')+': '+data.files+'\n'+t('Folders')+': '+data.directories+'\n'+t('Size')+': '+(data.bytes/1048576).toFixed(1)+' MiB\n';
    if(!many){this.reviewSummary.textContent=summary;this.excludedLink.textContent=t('Excluded')+': '+data.excluded;this.excludedLink.hidden=!data.excludedEntries.length;}
    else{
     const row=this.batchReview.createDiv({cls:'ignis-import-vault'});row.createEl('p',{cls:'ignis-import-summary',text:summary});const link=row.createEl('a',{text:t('Excluded')+': '+data.excluded,attr:{href:'#','data-import-exclusions':''}});link.hidden=!data.excludedEntries.length;link.addEventListener('click',event=>{event.preventDefault();this.openExclusions(plan);});
     row.createEl('p',{cls:'setting-item-description ignis-import-result',text:t(plan.result?'Imported':plan.error?'Import failed. Retry the pending vaults.':'Pending'),attr:{role:'status'}});
    }
   }
  }
  async importPlan(plan){
   const prepared=await this.api('prepare',this.inputFor(plan));
   if(prepared.completed){plan.result=prepared.completed;plan.stage=null;window.dispatchEvent(new Event('ignis:vaults-changed'));return;}
   if(plan.stage?.id!==prepared.id)plan.uploaded.clear();plan.stage=prepared;
   const stage=plan.stage;
   if(this.source.value==='folder')for(const [position,index] of stage.upload.entries()){
    this.progress.max=stage.upload.length;this.progress.value=position;this.status.textContent=plan.name+' · '+t('Uploading files…')+' '+(position+1)+' / '+stage.upload.length;
    if(!plan.uploaded.has(index)){await this.api('file',this.entries[stage.sourceIndexes[index]].file,true,{id:stage.id,index:String(index)});plan.uploaded.add(index);}
   }
   this.committing=true;this.cancel.disabled=true;this.status.textContent=plan.name+' · '+t('Finishing import…');this.progress.removeAttribute('value');
   try{plan.result=await this.api('commit',{},false,{id:stage.id});plan.stage=null;window.dispatchEvent(new Event('ignis:vaults-changed'));}
   finally{this.committing=false;this.cancel.disabled=false;}
  }
  async advance(){
   if(this.busy||this.selecting)return;
   if(this.step===1){
    if(this.plans.length===1){const plan=this.plans[0];plan.name=this.name.value.trim();if(plan.configuration&&!this.configuration.checked)plan.selected=[];plan.configuration=this.configuration.checked;}
    const selected=this.plans.filter(p=>p.enabled);if(!selected.length){new Notice(t('Select at least one vault.'));return;}
    const names=new Set();for(const plan of selected){if(plan.result)continue;plan.input.value=plan.name.trim();plan.name=plan.input.value;plan.input.setCustomValidity('');if(!plan.input.reportValidity())return;const key=plan.name.normalize('NFC').toLowerCase();if(names.has(key)){plan.input.setCustomValidity(t('Choose a different name for each vault.'));plan.input.reportValidity();return;}names.add(key);}
   }
   const openingName=this.step===0;this.busy=true;this.show();this.status.textContent='';this.progress.hidden=false;
   try{
    if(this.step===0){await this.scanSource();this.step=1;this.status.textContent='';this.show();this.plans[0]?.input.focus();}
    else if(this.step===1){
     for(const plan of this.plans.filter(p=>p.enabled&&!p.result)){try{plan.review=await this.api('review',this.inputFor(plan));}catch(error){if(error.status===409){plan.input.setCustomValidity(t('A vault with this name already exists.'));this.invalidName=plan.input;}throw error;}}
     this.updateReview();this.step=2;
    }else if(this.step===2){
     for(const plan of this.plans.filter(p=>p.enabled&&!p.result)){
      try{await this.importPlan(plan);plan.error=null;}catch(error){plan.error=error.message;if(plan.stage&&!this.closed){try{await this.api('cancel',{},false,{id:plan.stage.id});plan.stage=null;plan.uploaded.clear();}catch(cancelError){if(cancelError.status===404){plan.stage=null;plan.uploaded.clear();}}}if(error.status===409){this.step=1;plan.input.setCustomValidity(t('A vault with this name already exists.'));this.invalidName=plan.input;}else if(!this.closed)new Notice(plan.name+': '+error.message);if(this.closed||error.status===401)break;}
     }
     this.updateReview();const chosen=this.plans.filter(p=>p.enabled);
     if(chosen.every(p=>p.result)){this.result=chosen[0].result;this.step=3;this.status.textContent=t(this.plans.length>1?'Vaults imported successfully.':'Vault imported successfully.');this.completedList.empty();if(this.plans.length>1)for(const plan of chosen){const button=this.completedList.createEl('button',{text:t('Open vault')+' '+plan.name});button.type='button';button.addEventListener('click',()=>window.location.assign('/?vault='+encodeURIComponent(plan.result.id)));}}
    }
   }catch(error){if(!this.closed&&error.status!==409)new Notice(error.message);}
   finally{this.committing=false;this.busy=false;this.cancel.disabled=false;this.progress.hidden=true;if(!this.closed){this.show();if(this.invalidName){this.invalidName.reportValidity();this.invalidName=null;}else if(openingName&&this.step===1)this.plans[0]?.input.focus();}}
  }
  close(){if(!this.committing)super.close();}
  onClose(){
   this.excludedModal?.close();this.closed=true;this.abort.abort();
   if(this.scanStarted){const source=this.sourceStage,id=source?.id,attempt=this.attempt,session=this.session.sessionId;void (async()=>{try{const csrf=await fetch('/api/auth/csrf',{credentials:'same-origin'});if(csrf.ok)await fetch('/api/vault/import/cancel-source',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Ignis-Csrf':(await csrf.json()).csrfToken,'X-Ignis-Context':session},body:JSON.stringify(id?{id}:{attempt})});}catch{/* Expiring private staging is never published. */}})();}this.contentEl.empty();
  }
 };
}
