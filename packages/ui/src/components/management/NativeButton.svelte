<script>
 import {createEventDispatcher,onMount} from 'svelte';
 import {createUiElement} from '../../../../management/src/ui-controls.js';
 export let variant='primary',disabled=false,title='',type='button';
 const dispatch=createEventDispatcher();let container,content,button;
 export function getElement(){return button;}
 onMount(()=>{
  button=createUiElement(document,'button',{type});container.append(button);button.append(content);
  button.addEventListener('click',event=>{if(!disabled)dispatch('click',event);});
  update(variant,disabled,title,type,$$restProps);return ()=>button?.remove();
 });
 function update(variant,disabled,title,type,props){if(!button)return;button.disabled=disabled;button.title=title;button.type=type;
  for(const [key,value] of Object.entries(props)){if(key==="class")button.classList.add(...String(value).split(/\s+/).filter(Boolean));else if(value!==undefined&&value!==false)button.setAttribute(key,value===true?"":value);else button.removeAttribute(key);}

  button.classList.toggle('mod-cta',variant==='primary'||variant==='danger');
  button.classList.toggle('mod-destructive',variant==='danger');
  button.classList.toggle('ignis-ghost',variant==='ghost');
 }
 $: update(variant,disabled,title,type,$$restProps);
</script>
<span class="ui-button" bind:this={container}><span class="ui-button-content" bind:this={content}>{#if $$slots.icon}<span class="ui-button-icon"><slot name="icon" /></span>{/if}<slot /></span></span>
<style>
.ui-button{display:contents}.ui-button-content{display:inline-flex;align-items:center;justify-content:center;gap:6px}.ui-button-icon{display:inline-flex}
:global(button.ignis-ghost){background:transparent;box-shadow:none;color:var(--text-accent)}
</style>
