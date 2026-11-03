const t=text=>globalThis.IgnisI18n?.t(text)??text;
const reasons={
 'appearance-state':'Appearance settings are not imported because the original themes and snippets are excluded.',
 'community-plugins-state':'Community plugins start disabled.',
 'core-plugins-state':'The default Ignis core plugins are used.',
 'workspace-state':'The workspace layout and open tabs are recreated.',
 'preferences-disabled':'Obsidian preferences were not selected.',
 'plugins-themes':'Plugins and themes are not imported.',
 'unsupported-configuration':'This Obsidian configuration is not imported.',
 'generated-files':'Generated files and system metadata are not imported.',
 'hidden-state':'Hidden files and folders are not imported.',
};
export function createExclusionsModal(Modal){
 return class ExclusionsModal extends Modal{
  constructor(app,entries,onDismiss,onApply){super(app);this.entries=[...entries].sort((a,b)=>a.path.localeCompare(b.path));this.onDismiss=onDismiss;this.onApply=onApply;this.selected=new Set(entries.filter(e=>e.selected).map(e=>e.path));}
  onOpen(){
   this.setTitle(t('Excluded items'));this.modalEl.addClass('mod-lg','mod-form','ignis-password-modal','ignis-import-exclusions');
   this.contentEl.createEl('p',{text:t('Select the excluded items to import. Protected items cannot be selected. Your original files are unchanged.')});
   this.selectAll=this.contentEl.createEl('button',{attr:{type:'button','data-import-select-all':''}});
   this.selectAll.addEventListener('click',()=>{if(this.busy)return;const allowed=this.entries.filter(entry=>entry.selectable),all=allowed.every(entry=>this.selected.has(entry.path));for(const entry of allowed){if(all)this.selected.delete(entry.path);else this.selected.add(entry.path);}this.render();});
   this.list=this.contentEl.createEl('ul',{cls:'ignis-import-exclusion-list'});
   this.empty=this.contentEl.createEl('p',{text:t('No results found')});
   this.more=this.contentEl.createEl('button',{text:t('Show more')});this.more.type='button';
   this.more.addEventListener('click',()=>{this.count+=100;this.render();});
   const buttons=this.contentEl.createDiv({cls:'modal-button-container'}),close=buttons.createEl('button',{text:t('Close')});close.type='button';close.addEventListener('click',()=>this.close());
   this.apply=buttons.createEl('button',{text:t('Apply'),cls:'mod-cta'});this.apply.type='button';this.apply.addEventListener('click',async()=>{if(this.busy)return;this.busy=true;this.selectAll.disabled=true;this.apply.disabled=true;close.disabled=true;try{await this.onApply([...this.selected]);this.busy=false;this.close();}catch(error){this.error.textContent=error.message;}finally{this.busy=false;this.apply.disabled=false;close.disabled=false;this.updateSelectAll();}});
   this.error=this.contentEl.createEl('p',{attr:{role:'alert'}});this.count=100;this.render();close.focus();
  }
  render(){
   const entries=this.entries;
   const position=this.list.scrollTop;this.list.empty();
   for(const entry of entries.slice(0,this.count)){
    const row=this.list.createEl('li',{cls:entry.selectable?'':'is-disabled'}),label=row.createEl('label');if(!entry.selectable)label.title=t('This item cannot be selected.');const checkbox=label.createEl('input',{attr:{type:'checkbox'}});checkbox.disabled=!entry.selectable;checkbox.checked=entry.selectable&&this.selected.has(entry.path);checkbox.addEventListener('change',()=>{if(!entry.selectable){checkbox.checked=false;return;}if(checkbox.checked)this.selected.add(entry.path);else this.selected.delete(entry.path);this.updateSelectAll();});label.createEl('strong',{text:entry.path+(entry.kind==='directory'?'/':'')});
    row.createEl('small',{cls:'setting-item-description',text:t(entry.kind==='directory'?'Folder':'File')+' · '+(!entry.selectable?t('Not selectable')+' · ':'')+t(entry.selectable?'Optional Obsidian preferences.':(reasons[entry.reason]||'This item is not imported.'))});
   }
   this.updateSelectAll();this.list.scrollTop=position;this.empty.hidden=entries.length>0;this.more.hidden=entries.length<=this.count;
  }
  updateSelectAll(){const allowed=this.entries.filter(entry=>entry.selectable);this.selectAll.disabled=this.busy||allowed.length===0;this.selectAll.textContent=t(allowed.length&&allowed.every(entry=>this.selected.has(entry.path))?'Deselect all':'Select all');}
  onClose(){this.contentEl.empty();this.entries=[];this.onDismiss?.();}
 };
}
