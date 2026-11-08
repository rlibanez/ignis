// Real native CSS, standalone controllers and synthetic API data; no user vaults.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser} from './lib/chrome.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const web=path.join(repo,'apps/ignis-server/server/auth/web');
const assets=process.env.IGNIS_E2E_OBSIDIAN_ASSETS;
if(!assets)throw Error('Set IGNIS_E2E_OBSIDIAN_ASSETS to privately obtained Obsidian assets');
const policy={minLength:8,minSpecialChars:0};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(url.pathname==='/api/auth/status')return json({initialized:!req.headers.referer?.includes('/setup'),setupAvailable:true,oidcAvailable:true,oidcButtonText:'Authentik',passwordPolicy:policy});
 if(url.pathname==='/api/auth/session')return req.headers.referer?.includes('/login')?json({},401):json({sessionId:'session',user:{id:'user',login:'user'}});
 if(url.pathname==='/api/auth/reset-password')return json({context:'reset',passwordPolicy:policy});
 if(url.pathname==='/api/vault/list')return json([{uuid:'vault',name:'Vault',membership:'owner'}]);
 if(url.pathname==='/api/fs/tree')return json({'Folder':{type:'directory'},'Folder/Note.md':{type:'file'}});
 if(url.pathname==='/api/auth/csrf')return json({csrfToken:'synthetic'});
 const routes=Object.fromEntries(['setup','login','reset-password','share-target'].map(name=>['/'+name,path.join(web,name+'.html')]));
 routes['/auth/native.css']=path.join(assets,'app.css');
 const shared={'ui-environment.js':'ui-environment.cjs','resource-tree.js':'resource-tree.cjs','resource-tree.css':'resource-tree.css','password-visibility.js':'password-visibility.cjs','oidc-start.js':'oidc-start.cjs'};
 for(const name of ['entry.css','entry.js','setup.js','login.js','reset-password.js','i18n.js','pwa.js','events.js','share-target.css','share-target.js','share-store.js'])routes['/auth/'+name]=path.join(web,name);
 for(const [name,file] of Object.entries(shared))routes['/auth/'+name]=path.join(repo,'packages/management/src',file);
 if(routes[url.pathname]){const file=routes[url.pathname];
  if(file.endsWith('.html'))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self'; manifest-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/javascript');return res.end(fs.readFileSync(file));}
 // PWA resources are irrelevant to this isolated visual fixture.
 res.end('');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
try {
 for(const viewport of [{mobile:false,width:1280,height:900},{mobile:true,width:390,height:844},{mobile:true,width:360,height:800},{mobile:true,width:844,height:390}]) {
  const {mobile,width,height}=viewport;
  const client=await browser({mobile});
  try {
   await client.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
   for(const theme of ['light','dark']) {
    await client.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
    for(const page of ['setup','login','reset-password','share-target']) {
     await client.call('Page.navigate',{url:origin+'/'+page});
     await client.wait(`location.pathname==='/${page}' && document.readyState==='complete' && document.body.classList.contains('theme-${theme}') && !!window.IgnisI18n`,'standalone theme');
     if(page==='share-target') {
      await client.wait(`!!window.IgnisIncoming`,'incoming store');
      await client.run(`IgnisIncoming.change('synthetic',()=>({id:'synthetic',createdAt:Date.now(),title:'Shared title',text:'https://example.com',url:'',files:[],names:[],completed:[],state:'pending'}))`);
      await client.call('Page.navigate',{url:origin+'/share-target?id=synthetic'});
      await client.wait(`document.querySelector('#capture')?.hidden===false`,'incoming form');
     } else await client.wait(`document.querySelector('form')?.hidden===false`,'entry form');
     const layout=await client.run(`(()=>{const main=document.querySelector('main'),input=main.querySelector('input:not([type=hidden]):not([type=checkbox])'),style=getComputedStyle(input),box=main.getBoundingClientRect();return {width:box.width,left:box.left,scroll:document.documentElement.scrollWidth,viewport:innerWidth,font:style.fontSize,height:input.getBoundingClientRect().height,color:getComputedStyle(document.body).backgroundColor,theme:document.body.classList.contains('theme-${theme}'),native:!!getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim(),contain:getComputedStyle(document.body).contain};})()`);
     if(mobile){
      const brandTop=await client.run(`document.querySelector('.brand').getBoundingClientRect().top`);
      assert.ok(brandTop>=16 && brandTop<=17,'mobile brand uses a single 16px top gap, plus an optional card border');
     }
     assert.equal(layout.native,true,'installed native CSS provides tokens');assert.equal(layout.contain,'none','entry page can grow and scroll');
     const maximum=page==='share-target'?704:400;
     assert.equal(layout.width,Math.min(maximum,width-32),'entry page uses its designated width, including padding and border');assert.ok(layout.left>=0);assert.ok(layout.scroll<=layout.viewport,'no horizontal overflow');assert.ok(layout.height>=28);
     if(page==='share-target') {
      if(mobile){
       await client.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'display-mode',value:'standalone'}]});
       const overflow=await client.run(`document.scrollingElement.scrollHeight>innerHeight`);
       if(overflow){
        for(let swipe=0;swipe<5;swipe++){
         await client.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width-20,y:height*.8}]});
         for(let step=1;step<=8;step++){
          await client.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width-20,y:height*(.8-step*.07)}]});
          await client.run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
         }
         await client.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        }
        await client.run('new Promise(resolve=>setTimeout(resolve,150))');
        assert.equal(await client.run(`(()=>{const r=document.querySelector('#cancel').getBoundingClientRect();return scrollY>0 && r.top>=0 && r.bottom<=innerHeight;})()`),true,'touch scrolling reaches the final share action in standalone mode: '+await client.run(`JSON.stringify({scrollY,body:document.body.scrollTop,root:document.scrollingElement.tagName,height:innerHeight,total:document.scrollingElement.scrollHeight,cancel:document.querySelector('#cancel').getBoundingClientRect().toJSON(),overflow:getComputedStyle(document.body).overflow,htmlOverflow:getComputedStyle(document.documentElement).overflow})`));
        await client.run('scrollTo(0,0)');
       }
      }
      assert.equal(await client.run(`(()=>{const input=document.querySelector('#preview'),title=document.querySelector('#preview-title'),card=document.querySelector('.incoming-content');return input.tagName==='TEXTAREA' && !input.disabled && title.value==='Shared title' && getComputedStyle(card).borderTopStyle!=='none';})()`),true,'incoming content is editable and subtly framed');
      await client.run(`IgnisIncoming.change('synthetic',item=>({...item,title:''}))`);
      await client.call('Page.reload');await client.wait(`document.querySelector('#capture')?.hidden===false`,'incoming form without title');
      assert.equal(await client.run(`(()=>{const heading=document.querySelector('#preview-heading').getBoundingClientRect(),card=document.querySelector('.incoming-content').getBoundingClientRect();return document.querySelector('#preview-title-field').getClientRects().length===0 && card.top-heading.bottom<=24;})()`),true,'missing title and empty status reserve no space');
      await client.run(`document.querySelector('#destination-tree .resource-tree-row:nth-child(2) .resource-tree-toggle').click()`);
      assert.equal(await client.run(`!!document.querySelector('#destination-tree [data-path="Folder/Note.md"]')`),true,'shared resource tree expands');
      await client.run(`document.querySelector('#mkdir').click()`);
      assert.equal(await client.run(`document.querySelector('#resource-dialog').open`),true,'native-styled creation dialog opens');
      assert.equal(await client.run(`document.querySelector('#resource-dialog').getBoundingClientRect().right<=innerWidth`),true,'creation dialog fits viewport');
      await client.run(`document.querySelector('#resource-cancel').click()`);
     }
     if(page!=='share-target') {
      assert.equal(await client.run(`(()=>{const inputs=[...document.querySelector('form').querySelectorAll('input:not([type=checkbox])')];return inputs.every(input=>Math.abs(input.getBoundingClientRect().width-inputs[0].getBoundingClientRect().width)<1 && Math.abs(input.getBoundingClientRect().height-inputs[0].getBoundingClientRect().height)<1);})()`),true,'text and password fields have identical native dimensions');
      const toggle=await client.run(`(()=>{const button=document.querySelector('.password-toggle');if(!button)return false;const field=button.parentElement.querySelector('input');const width=field.getBoundingClientRect().width;button.click();return button.getAttribute('aria-pressed')==='true' && field.getBoundingClientRect().width===width;})()`);
      assert.equal(toggle,true,'password visibility works without reflow');
     }
     if(page==='login') {
      const before=await client.run(`document.querySelector('main').getBoundingClientRect().height`);
      await client.run(`const error=document.querySelector('#login-error');error.hidden=false;error.textContent='Invalid username or password.';`);
      assert.equal(await client.run(`document.querySelector('main').getBoundingClientRect().height`),before,'login feedback does not reflow');
     }
     if(page==='reset-password') {
      await client.run(`document.querySelector('#reset-password').value='Password1!';document.querySelector('#reset-confirmation').value='Different!';document.querySelector('#reset-form').requestSubmit()`);
      assert.equal(await client.run(`document.querySelector('#reset-confirmation').validity.customError`),true);
     }
     const screenshot=process.env.IGNIS_UI_SCREENSHOTS;
     if(screenshot){fs.mkdirSync(screenshot,{recursive:true});const {data}=await client.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(screenshot,`${mobile?'mobile':'desktop'}-${width}-${theme}-${page}.png`),Buffer.from(data,'base64'));}
    }
   }
   assert.deepEqual(client.errors.filter(error=>typeof error==='string'),[],'no uncaught browser errors');
   console.log(JSON.stringify({status:'passed',mobile,width,height,pages:4,themes:['light','dark']}));
  }finally{await client.close();}
 }
}finally{await new Promise(resolve=>server.close(resolve));}
