import {nativeTooltip} from './native-tooltip.js';

const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import {errorBlock} from "./shared-ui.js";
// This picker is only a convenience; the server rechecks both endpoints.
export function copyDestinationFolders(files, source, describe) {
  return files.filter(file=>Array.isArray(file.children) && file.path &&
    !file.path.split('/').some(part=>!part || part.startsWith('.')) &&
    file.path!==source && !file.path.startsWith(source+'/') &&
    describe(file.path)?.role!=='reader').sort((a,b)=>a.path.localeCompare(b.path));
}
export function copyFolderTree(folders,expanded,query='') {
  const parent=path=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
  const byParent=new Map(),visible=new Set(),filter=query.trim().toLocaleLowerCase();
  for(const entry of folders){const key=parent(entry.path);if(!byParent.has(key))byParent.set(key,[]);byParent.get(key).push(entry);}
  if(filter)for(const entry of folders)if(entry.path.toLocaleLowerCase().includes(filter)){
    let path=entry.path;while(path){visible.add(path);path=parent(path);}
  }
  const rows=[];
  function visit(path,depth){
    for(const entry of byParent.get(path)||[]){
      if(filter&&!visible.has(entry.path))continue;
      const children=(byParent.get(entry.path)||[]).some(child=>!filter||visible.has(child.path));
      const open=children&&(!!filter||expanded.has(entry.path));
      rows.push({...entry,depth,children,open});if(open)visit(entry.path,depth+1);
    }
  }
  if(filter||expanded.has(''))visit('',1);
  return rows;
}
export function copyDestinationPath(folder,name) {
  // eslint-disable-next-line no-control-regex
  if(typeof name!=='string' || !name || name!==name.trim() || name.startsWith('.') || /[\\/\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name))
    throw new Error(translateIgnis("Enter a file or folder name without slashes or leading/trailing spaces."));
  return folder ? folder+'/'+name : name;
}
export function openCopyDialog(obsidian,app,file,describe,copy,options={}) {
  let destinationVault=app.vault;
  class CopyDialog extends obsidian.Modal {
    onClose(){this.closed=true;}
    async onOpen() {
      this.closed=false;
      this.modalEl.classList.add('ignis-management-modal');
      this.setTitle(options.title || translateIgnis("Copy ")+file.name);
      if(options.load){
        const loading=document.createElement('p');loading.textContent=translateIgnis("Loading vault…");this.contentEl.append(loading);
        try{destinationVault=await options.load();}catch(error){loading.textContent=translateIgnis(error.message);return;}
        if(this.closed)return;loading.remove();
      }
      let folder='',busy=false;const expanded=new Set(['']);
      const create=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
      const content=this.contentEl;
      const label=create('div',translateIgnis("Destination folder"));label.style.fontWeight='600';
      const search=create('input');search.type='search';search.placeholder=translateIgnis("Search folders…");search.setAttribute('aria-label',translateIgnis("Search destination folders"));search.style.cssText='width:100%;margin:10px 0';
      const location=create('div');location.style.cssText='margin:8px 0;color:var(--text-muted);overflow-wrap:anywhere';location.setAttribute('aria-live','polite');
      const list=create('div');list.className='ignis-folder-picker';list.style.cssText='max-height:240px;overflow:auto;min-height:90px;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px';
      const hint=create('p');hint.style.cssText='color:var(--text-muted);font-size:var(--font-smallest)';
      const nameLabel=create('label',translateIgnis("Name of the copy")),name=create('input');name.type='text';name.value=file.name;name.style.cssText='width:100%;margin:8px 0 12px';nameLabel.append(name);
      const error=errorBlock(create('div'));
      const actions=create('div');actions.className='ignis-ui-actions';
      const cancel=create('button',translateIgnis("Cancel")),submit=create('button',(options.submit || translateIgnis("Copy here")));submit.className='mod-cta';actions.append(cancel,submit);
      const render=()=>{
        submit.disabled=busy || (options.multipleVaults && !folder);
        location.textContent=translateIgnis("Destination: ")+(folder ? (destinationVault.displayPath?.(folder) || folder) : options.multipleVaults ? translateIgnis("Destination folder") : translateIgnis("Vault root"));list.replaceChildren();search.disabled=busy;
        const folders=copyDestinationFolders(destinationVault.getAllLoadedFiles(),file.path,describe);
        const rows=copyFolderTree(folders,expanded,search.value);
        const draw=(entry)=>{
          const row=create('div');row.className='ignis-folder-row';row.style.setProperty('--tree-depth',String(entry.depth));row.style.cssText+=`display:flex;align-items:center;gap:4px;padding-left:${entry.depth*16}px;margin:2px 0`;
          const toggle=create('button');toggle.className='ignis-folder-toggle';toggle.style.cssText='width:26px;padding:2px;box-shadow:none;background:transparent';toggle.disabled=busy;
          if(entry.children){obsidian.setIcon?.(toggle,entry.open?'chevron-down':'chevron-right');toggle.setAttribute('aria-label',(entry.open?translateIgnis("Collapse "):translateIgnis("Expand "))+entry.name);toggle.setAttribute('aria-expanded',String(entry.open));
            toggle.disabled=busy||!!search.value.trim();toggle.onclick=()=>{if(expanded.has(entry.path))expanded.delete(entry.path);else expanded.add(entry.path);render();list.querySelector(`[data-toggle="${entry.index}"]`)?.focus();};
          }else{toggle.style.visibility='hidden';toggle.tabIndex=-1;}
          toggle.dataset.toggle=String(entry.index);
          const button=create('button');button.className='ignis-folder-select';button.style.cssText='display:flex;align-items:center;gap:8px;flex:1;min-width:0;justify-content:flex-start;box-shadow:none';button.style.background=entry.path===folder?'var(--background-modifier-hover)':'transparent';
          const icon=create('span'),text=create('span',entry.name);text.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          obsidian.setIcon?.(icon,describe(entry.path)?'folder-input':'folder');button.append(icon,text);nativeTooltip(window,button,destinationVault.displayPath?.(entry.path) || entry.path || translateIgnis("Vault root"));button.setAttribute('aria-pressed',String(entry.path===folder));button.dataset.folder=String(entry.index);
          button.disabled=busy;button.onclick=()=>{folder=entry.path;error.textContent='';render();list.querySelector(`[data-folder="${entry.index}"]`)?.focus();};row.append(toggle,button);list.append(row);
        };
        if(!options.multipleVaults)draw({path:'',name:translateIgnis("Vault root"),depth:0,children:folders.length>0,open:!!search.value.trim()||expanded.has(''),index:0});
        rows.forEach((entry,index)=>draw({...entry,depth:options.multipleVaults?entry.depth-1:entry.depth,index:index+1}));
        if(search.value.trim()&&!rows.length)list.append(create('div',translateIgnis("No matching folders")));
        hint.textContent=options.hint || (describe(folder)?.direction==='incoming'?translateIgnis("Shared folder: the copy will be visible to its recipients."):translateIgnis("Select a folder, then choose Copy here. Existing items will not be overwritten."));
      };
      search.oninput=render;
      cancel.onclick=()=>this.close();
      submit.onclick=async()=>{
        if(busy || (options.multipleVaults && !folder))return;error.textContent='';
        try{
          const destination=copyDestinationPath(folder,name.value);
          if(destinationVault.getAbstractFileByPath(destination))throw new Error(translateIgnis("An item with that name already exists. Choose another name or folder."));
          busy=true;submit.disabled=true;cancel.disabled=true;name.disabled=true;submit.textContent=translateIgnis("Copying…");render();
          await copy(file.path,destination);this.close();new obsidian.Notice(translateIgnis("Copy complete"));
        }catch(e){error.textContent=translateIgnis(e.message) || translateIgnis("Copy failed");}
        finally{busy=false;submit.disabled=false;cancel.disabled=false;name.disabled=false;submit.textContent=(options.submit || translateIgnis("Copy here"));render();}
      };
      content.append(label,search,list,location,hint,nameLabel,error,actions);render();
    }
  }
  new CopyDialog(app).open();
}
