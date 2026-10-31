
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
// Decorations only: never change file names, contents or permissions.
export function installSharedIcons(obsidian, sharedFiles, host = window) {
  let stopped=false,queued=false;
  const selector='.nav-file-title[data-path], .nav-folder-title[data-path]';
  function paint(){
    queued=false;if(stopped)return;
    for(const item of host.document.querySelectorAll(selector)){
      const shared=sharedFiles.describe(item.getAttribute('data-path'));
      let icon=item.querySelector('.ignis-shared-marker');
      if(!shared){icon?.remove();continue;}
      if(!icon){icon=host.document.createElement('span');icon.className='ignis-shared-marker';Object.assign(icon.style,{display:'inline-flex',width:'1em',height:'1em',lineHeight:'1',alignItems:'center',justifyContent:'center',alignSelf:'center',verticalAlign:'middle',marginLeft:'6px',flexShrink:'0',color:'var(--text-muted)'});item.append(icon);}
      const name=shared.direction==='outgoing'?'share-2':'users';
      if(icon.__ignisShareIcon!==name){
        obsidian.setIcon(icon,name);
        // Obsidian's default SVG size can exceed the explorer text line height.
        // Scale the decoration to the row's font without changing the row itself.
        const svg=icon.querySelector?.('svg');
        if(svg)Object.assign(svg.style,{width:'100%',height:'100%',display:'block'});
        icon.__ignisShareIcon=name;
      }
      const label=shared.direction==='outgoing'?translateIgnis("Shared by you"):(shared.owner?translateIgnis("Shared by ")+shared.owner:translateIgnis("Shared"))+' · '+(shared.role==='editor'?translateIgnis("Read / Write"):translateIgnis("Read"));
      icon.setAttribute('aria-label',label);icon.title=label;
    }
  }
  function schedule(){if(!stopped&&!queued){queued=true;queueMicrotask(paint);}}
  const observer=new host.MutationObserver(schedule);observer.observe(host.document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-path']});
  const unsubscribe=sharedFiles.subscribe(schedule);schedule();
  host.addEventListener('ignis:auth-lost',()=>{stopped=true;observer.disconnect();unsubscribe();for(const icon of host.document.querySelectorAll('.ignis-shared-marker'))icon.remove();},{once:true});
}
