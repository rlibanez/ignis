<script>
  import {createEventDispatcher,onMount} from 'svelte';
  import {createUiElement,setUiOptions} from '../../../../management/src/ui-controls.js';
  export let value='',checked=false,type='text',disabled=false,options=[];
  const dispatch=createEventDispatcher();
  let container,element,classes=[],choicesKey;
  export function focus(){element?.focus();}
  export function select(){element?.select();}
  function update(value,checked,disabled,props,options){
    if(!element)return;
    if(type==='select'){
      const key=JSON.stringify(options);
      if(key!==choicesKey){setUiOptions(element,options);choicesKey=key;}
    }
    for(const [key,val] of Object.entries(props)){
      if(key==='class'){
        element.classList.remove(...classes);
        classes=String(val).split(/\s+/).filter(Boolean);
        element.classList.add(...classes);
      }else if(val!==undefined && val!==false)element.setAttribute(key,val===true?'':val);
      else element.removeAttribute(key);
    }
    element.disabled=disabled;
    if(type==='checkbox')element.checked=checked;
    else element.value=value;
  }
  onMount(()=>{
    const tag=type==='select'?'select':type==='textarea'?'textarea':'input';
    element=createUiElement(document,tag,{type:tag==='input'?type:undefined});
    container.append(element);
    for(const name of ['input','change'])element.addEventListener(name,event=>{
      value=element.value;checked=element.checked;dispatch(name,event);
    });
    element.addEventListener('keydown',event=>dispatch('keydown',event));
    update(value,checked,disabled,$$restProps,options);
    if($$restProps.autofocus)element.focus();
    return ()=>element.remove();
  });
  $: update(value,checked,disabled,$$restProps,options);
</script>
<span class="ui-field" bind:this={container}></span>
<style>.ui-field{display:contents}</style>
