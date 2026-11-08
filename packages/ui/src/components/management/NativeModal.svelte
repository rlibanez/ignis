<script>
  import {createEventDispatcher,onMount,onDestroy} from 'svelte';
  import {BrowserModal} from '../../management.js';
  import {uiRuntime} from '../../../../management/src/ui-controls.js';
  import {installUiLayout} from '../../../../management/src/ui-layout.js';
  export let title='';
  export let overlayClass='';
  export let width='480px';
  export let closeOnOverlayClick=true;
  const dispatch=createEventDispatcher();
  let content,footer,icon,modal,disposing=false;
  function requestClose(escape=false){dispatch(escape?'escape':'close');}
  export function dismiss(){if(modal){const current=modal;modal=null;if(current.finish)current.finish();else current.close();}}
  onMount(()=>{
    installUiLayout();
    const runtime=uiRuntime(),Base=runtime?.Modal || BrowserModal;
    class HostedModal extends Base {
      close(){requestClose(true);}
      finish(){super.close();}
      onOpen(){
        this.setTitle(title);
        this.modalEl.classList.add('mod-lg',parseFloat(width)>620?'ignis-ui-list':'ignis-ui-form');
        for(const name of overlayClass.split(/\s+/).filter(Boolean))this.containerEl.classList.add(name);
        this.contentEl.append(content);
        if(footer){footer.classList.add('ignis-ui-footer');this.contentEl.append(footer);}
        if(icon?.childNodes.length){icon.hidden=true;}
      }
      onClose(){if(!disposing)requestClose(false);}
    }
    modal=new HostedModal(runtime?.app);modal.open();
    // Preserve the caller's cancellation guard, including busy/destructive flows.
    const lost=()=>{
      const current=modal;modal=null;if(!current)return;disposing=true;
      for(const field of current.contentEl.querySelectorAll('input,textarea'))field.value='';
      current.finish();requestClose(false);
    };
    window.addEventListener('ignis:auth-lost',lost);
    const bg=modal.containerEl.querySelector('.modal-bg');
    if(bg)bg.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();if(closeOnOverlayClick)requestClose(true);},true);
    return ()=>{window.removeEventListener('ignis:auth-lost',lost);const current=modal;modal=null;if(current){disposing=true;if(current.finish)current.finish();else current.close();}};
  });
  $: if(modal)modal.setTitle(title);
  onDestroy(()=>{disposing=true;});
</script>
<div class="ui-staging">
 <div bind:this={icon}><slot name="icon" /></div>
 <div class="ignis-ui-body" bind:this={content}><slot /></div>
 {#if $$slots.footer}<div bind:this={footer}><slot name="footer" /></div>{/if}
</div>
<style>.ui-staging{display:none}</style>
