// One DOM renderer for standalone pages and Obsidian. Adapters supply only
// visible rows and data operations; this component owns icons and interaction.
(() => {
  const icons = {folder:'M3 7V5h6l2 2h10v12H3Z',file:'M6 3h8l4 4v14H6ZM14 3v5h4',right:'m9 6 6 6-6 6',down:'m6 9 6 6 6-6'};
  function render(container, rows, {selected='',disabled=false,onSelect,onToggle,translate=x=>x}={}) {
    const doc=container.ownerDocument;
    const focused=container.getRootNode().activeElement;
    const focusPath=container.contains(focused)?focused.dataset.path:undefined;
    const focusToggle=focused?.classList.contains('resource-tree-toggle');
    container.classList.add('resource-tree');
    const icon=name=>{const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','aria-hidden':'true'}))svg.setAttribute(k,v);const path=doc.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',icons[name]);svg.append(path);return svg;};
    const elements=rows.map(entry=>{
      const row=doc.createElement('div');row.className='resource-tree-row';row.style.setProperty('--depth',String(entry.depth||0));
      const toggle=doc.createElement('button');toggle.type='button';toggle.className='resource-tree-toggle';toggle.dataset.path=entry.path;
      toggle.disabled=disabled||entry.loading===true;
      if(entry.children){toggle.append(icon(entry.open?'down':'right'));toggle.setAttribute('aria-expanded',String(!!entry.open));toggle.setAttribute('aria-label',translate(entry.open?'Collapse ':'Expand ')+entry.name);toggle.onclick=()=>onToggle?.(entry);}
      else{toggle.style.visibility='hidden';toggle.tabIndex=-1;}
      const button=doc.createElement('button');button.type='button';button.className='resource-tree-select';button.dataset.path=entry.path;button.disabled=disabled||entry.selectable===false;button.setAttribute('aria-pressed',String(selected===entry.path));
      const text=doc.createElement('span');text.textContent=entry.name;button.append(icon(entry.kind==='file'?'file':'folder'),text);button.onclick=()=>onSelect?.(entry);
      button.onkeydown=event=>{if((event.key==='ArrowRight'&&!entry.open||event.key==='ArrowLeft'&&entry.open)&&entry.children){event.preventDefault();onToggle?.(entry);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){const buttons=[...container.querySelectorAll('.resource-tree-select:not(:disabled)')];const i=buttons.indexOf(button);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:i+(event.key==='ArrowDown'?1:-1);event.preventDefault();buttons[next]?.focus();}};
      row.append(toggle,button);return row;
    });
    container.replaceChildren(...elements);
    if(focusPath!==undefined)[...container.querySelectorAll(focusToggle?'.resource-tree-toggle':'.resource-tree-select')].find(el=>el.dataset.path===focusPath)?.focus();
  }
  if (typeof module !== "undefined" && module.exports) module.exports = {render};
  else globalThis.IgnisResourceTree={render};
})();
