import {it,expect} from 'vitest';
import {installDialogHost} from './dialog-host.js';
import {fixture} from './ui-fixture.test-helper.js';
function mounted(primary=false) {
 const {doc,Modal}=fixture(),owner=new Modal();owner.open();
 const frame=doc.createElement('div');owner.contentEl.append(frame);
 const sections=['Edit user','Confirm'].map(title=>{const section=doc.createElement('section');section.setAttribute('data-ui-dialog','');const heading=doc.createElement('h2');heading.textContent=title;section.append(heading);frame.append(section);return section;});
 const created=[];const host=installDialogHost({frame,owner,primary,createModal:()=>{const modal=new Modal();created.push(modal);return modal;}});
 return {frame,owner,sections,host,created};
}
it('opens one real host per operation and restores the parent frame on cancellation',async()=>{
 const f=mounted();const [edit,confirm]=f.sections;
 edit.showModal();expect(f.created[0].title).toBe('Edit user');expect(f.frame.parentNode).toBe(f.owner.contentEl);expect(edit.parentNode.parentNode).toBe(f.created[0].contentEl);expect(f.owner.containerEl.hidden).toBe(false);expect(f.host.root.querySelectorAll('[data-ui-dialog]')).toHaveLength(2);
 confirm.showModal();expect(confirm.parentNode.parentNode).toBe(f.created[1].contentEl);
 confirm.close();expect(edit.parentNode.parentNode).toBe(f.created[0].contentEl);expect(edit.open).toBe(true);expect(confirm.open).toBe(false);
 edit.close();expect(f.frame.parentNode).toBe(f.owner.contentEl);expect(f.owner.containerEl.hidden).toBe(false);f.host.dispose();
});
it('honors a busy form cancellation guard for X and Escape',()=>{
 const f=mounted(),section=f.sections[0];section.showModal();
 const deny=event=>event.preventDefault();section.addEventListener('cancel',deny);
 f.created[0].close();expect(section.open).toBe(true);
 section.removeEventListener('cancel',deny);f.created[0].close();expect(section.open).toBe(false);f.host.dispose();
});
it('reuses the primary Modal for an individual resource instead of opening a catalog behind it',()=>{
 const f=mounted(true);Object.assign(f.owner.modalEl.style,{width:'900px',maxWidth:'1100px',height:'800px',maxHeight:'1000px'});f.sections[0].showModal();expect(f.owner.modalEl.style.width).toBe('');expect(f.owner.modalEl.style.maxWidth).toBe('');expect(f.owner.modalEl.style.height).toBe('');expect(f.owner.modalEl.style.maxHeight).toBe('');expect(f.created).toHaveLength(0);expect(f.frame.parentNode).toBe(f.owner.contentEl);expect(f.owner.title).toBe('Edit user');f.host.dispose();
});
it('closes child hosts and suppresses late close callbacks when its session scope is disposed',async()=>{
 const f=mounted();let callbacks=0;for(const section of f.sections){section.addEventListener('close',()=>callbacks++);section.showModal();}
 f.host.dispose();await Promise.resolve();expect(f.created.every(modal=>!modal.opened)).toBe(true);expect(callbacks).toBe(0);expect(f.frame.parentNode).toBe(f.owner.contentEl);
});

it('ignores a late native close animation after the same form has reopened',()=>{
 const f=mounted(),section=f.sections[0];section.showModal();const old=f.created[0];
 section.close();section.showModal();const current=f.created[1];old.onClose();
 expect(section.open).toBe(true);expect(section.parentNode.parentNode).toBe(current.contentEl);f.host.dispose();
});

it('keeps an individual action alive until its asynchronous confirmation result is consumed',async()=>{
 const f=mounted(true),confirmation=f.sections[1];confirmation.classList.add('ignis-confirm');
 let accepted=false;confirmation.addEventListener('close',()=>{accepted=confirmation.returnValue==='confirmed';});
 confirmation.showModal();expect(f.created).toHaveLength(1);confirmation.close('confirmed');await Promise.resolve();
 expect(accepted).toBe(true);expect(f.owner.opened).toBe(true);f.host.dispose();
});

it('releases removed one-shot confirmations from the logical component scope',async()=>{
 const f=mounted(),section=f.frame.ownerDocument.createElement('section');
 section.setAttribute('data-ui-dialog','');f.frame.append(section);f.host.decorate(section);
 section.addEventListener('close',()=>section.remove(),{once:true});
 section.showModal();expect(f.host.root.querySelectorAll('[data-ui-dialog]')).toHaveLength(3);
 section.close();await Promise.resolve();
 expect(f.host.root.querySelectorAll('[data-ui-dialog]')).toHaveLength(2);f.host.dispose();
});

it('clears secrets in portalled child forms when the owner is disposed',()=>{
 const f=mounted(),section=f.sections[0],input=f.frame.ownerDocument.createElement('input');
 input.value='temporary secret';section.append(input);section.showModal();
 f.host.dispose();expect(input.value).toBe('');
});
