// Minimal structural DOM for lifecycle contracts; geometry uses real-browser tests.
export function fixture() {
 const doc={defaultView:{Event}};
 class Node extends EventTarget {
  constructor(tag){super();this.tagName=tag.toUpperCase();this.children=[];this.ownerDocument=doc;this.attributes=new Map();this.dataset={};this.style={setProperty(key,value){this[key]=value;}};const names=new Set();this.classList={add:(...values)=>values.forEach(value=>names.add(value)),contains:value=>names.has(value),toggle:(value,enabled)=>enabled?names.add(value):names.delete(value)};}
  get parentNode(){return this.parent;}
  append(...nodes){for(const node of nodes){node.remove();this.children.push(node);node.parent=this;}}
  insertBefore(node,before){node.remove();this.children.splice(this.children.indexOf(before),0,node);node.parent=this;}
  before(node){this.parent.insertBefore(node,this);}
  after(node){const parent=this.parent,index=parent.children.indexOf(this);node.remove();parent.children.splice(index+1,0,node);node.parent=parent;}
  remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  hasAttribute(key){return this.attributes.has(key);}
  removeAttribute(key){this.attributes.delete(key);}
  toggleAttribute(key,value){if(value)this.setAttribute(key,'');else this.removeAttribute(key);}
  matches(selector){return selector.split(',').some(part=>part.trim()==='[data-ui-dialog]'?this.hasAttribute('data-ui-dialog'):this.tagName===part.trim().toUpperCase());}
  querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
  querySelector(selector){return this.children.find(node=>node.tagName===selector.toUpperCase()) || null;}
 }
 doc.createElement=tag=>new Node(tag);doc.createComment=()=>new Node('comment');doc.head=new Node('head');doc.body=new Node('body');doc.getElementById=id=>doc.head.children.find(node=>node.id===id);
 class Modal {
  constructor(){this.containerEl=new Node('div');this.modalEl=new Node('div');this.contentEl=new Node('div');this.containerEl.append(this.modalEl);this.modalEl.append(this.contentEl);}
  setTitle(value){this.title=value;}
  open(){doc.body.append(this.containerEl);this.opened=true;this.onOpen?.();}
  close(){if(this.requestClose)return this.requestClose();this.forceClose();}
  forceClose(){if(!this.opened)return;this.opened=false;this.onClose?.();this.containerEl.remove();}
 }
 return {doc,Node,Modal};
}
