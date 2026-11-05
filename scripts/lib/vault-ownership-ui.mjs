import assert from 'node:assert/strict';
export async function vaultOwnershipUi({owner,member,vault,origin}){
 const uuid=JSON.stringify(vault.id);
 // Earlier import scenarios deliberately open their new vaults. Select the
 // source explicitly so this exercises an active, rather than background, move.
 await owner.call('Page.navigate',{url:origin+'/?vault='+encodeURIComponent(vault.id)});
 await owner.wait(`!!window.app?.workspace && window.__currentVaultUuid===${uuid}`,'owner opens the transfer source');
 await owner.run(`new Promise(resolve=>app.workspace.onLayoutReady(resolve))`);
 await owner.run(`(async()=>{await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Shared.md'));})()`);
 const added=await owner.run(`(async()=>{const members=await(await fetch('/api/vault/members?vault='+${uuid})).json(),session=await(await fetch('/api/auth/session')).json(),csrf=await(await fetch('/api/auth/csrf')).json();return (await fetch('/api/vault/members',{method:'POST',headers:{'Content-Type':'application/json','X-Ignis-Context':session.sessionId,'X-Ignis-Csrf':csrf.csrfToken},body:JSON.stringify({vault:${uuid},login:'receiver',role:'reader',expectedRole:null,revision:members.revision})})).status;})()`);
 assert.equal(added,200);
 await member.call('Page.navigate',{url:origin+'/?vault='+encodeURIComponent(vault.id)});
 await member.wait(`!!window.app?.workspace && window.__currentVaultUuid===${uuid}`,'member opens the original UUID');
 await member.run(`new Promise(resolve=>app.workspace.onLayoutReady(resolve))`);
 await member.run(`(async()=>{await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Shared.md'));window.transferView=app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md').view;})()`);
 await owner.run(`IgnisUI.showVaultManager()`);
 await owner.wait(`Array.from(document.querySelectorAll('.vault-manager-overlay .list-item')).some(el=>el.querySelector('.vault-path')?.textContent===${JSON.stringify(vault.path)})`,'owner vault menu');
 await owner.run(`Array.from(document.querySelectorAll('.vault-manager-overlay .list-item')).find(el=>el.querySelector('.vault-path')?.textContent===${JSON.stringify(vault.path)}).querySelector('.popover-trigger').click()`);
 await owner.run(`Array.from(document.querySelectorAll('.popover-item')).find(el=>el.textContent.trim()==='Manage access').click()`);
 await owner.wait(`Array.from(document.querySelectorAll('.access-body')).some(el=>el.textContent.includes('receiver'))`,'current membership loaded');
 await owner.run(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='Transfer ownership').click()`);
 await owner.wait(`!!document.querySelector('.confirmation')`,'ownership confirmation');
 await owner.run(`{const modal=document.querySelector('.confirmation').closest('.modal-shell'),select=modal.querySelector('select');select.value='receiver';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
 await owner.run(`document.querySelector('.confirmation input').click()`);
 await owner.run(`Array.from(document.querySelector('.confirmation').closest('.modal-shell').querySelectorAll('button')).find(el=>el.textContent.trim()==='Transfer ownership').click()`);
 await owner.wait(`location.search.includes('manager=1')&&!document.querySelector('.confirmation')`,'initiator returns safely to manager');
 await member.wait(`window.__currentVaultId==='receiver/Owner'&&!window.__ignisAuth.blocked`,'member keeps the same UUID after the namespace move');
 assert.equal(await member.run(`window.__currentVaultUuid`),vault.id);
 assert.equal(await member.run(`window.transferView===app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view`),true,'open editor survives the ownership move');
 await member.run(`(async()=>{transferView.editor.setValue('saved after ownership transfer');await transferView.save();})()`);
 const final=await member.run(`(async()=>{const list=await(await fetch('/api/vault/list')).json();return list.find(v=>v.uuid===${uuid});})()`);
 assert.equal(final.membership,'owner');assert.equal(final.id,'receiver/Owner');
 console.log(JSON.stringify({vaultOwnership:'passed',mobile:process.argv.includes('--mobile'),checks:['real owner confirmation','active editor save coordination','safe manager return','member keeps editor and UUID','new owner can save','readable destination namespace']}));
}
