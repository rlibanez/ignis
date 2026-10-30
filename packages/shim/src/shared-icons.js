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
      if(!icon){icon=host.document.createElement('span');icon.className='ignis-shared-marker';Object.assign(icon.style,{display:'inline-flex',marginLeft:'6px',flexShrink:'0',color:'var(--text-muted)'});obsidian.setIcon(icon,'users');item.append(icon);}
      const label=(shared.owner?'Shared by '+shared.owner:'Shared')+' · '+(shared.role==='editor'?'Read / Write':'Read');
      icon.setAttribute('aria-label',label);icon.title=label;
    }
  }
  function schedule(){if(!stopped&&!queued){queued=true;queueMicrotask(paint);}}
  const observer=new host.MutationObserver(schedule);observer.observe(host.document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-path']});
  const unsubscribe=sharedFiles.subscribe(schedule);schedule();
  host.addEventListener('ignis:auth-lost',()=>{stopped=true;observer.disconnect();unsubscribe();for(const icon of host.document.querySelectorAll('.ignis-shared-marker'))icon.remove();},{once:true});
}
