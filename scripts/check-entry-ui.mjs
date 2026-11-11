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
 if(url.pathname==='/api/auth/session')return (/\/login|signed-out=1/.test(req.headers.referer ?? ''))?json({},401):json({sessionId:'session',user:{id:'user',login:'user'}});
 if(url.pathname==='/api/auth/login' && req.method==='POST')return json({sessionId:'session',user:{id:'user',login:'user'}});
 if(url.pathname==='/api/auth/reset-password')return json({context:'reset',passwordPolicy:policy});
 if(url.pathname==='/api/vault/list')return json([{uuid:'vault',name:'Vault',membership:'owner'}]);
 if(url.pathname==='/api/fs/tree')return json({'Folder':{type:'directory'},'Folder/Note.md':{type:'file'}});
 if(url.pathname==='/api/auth/csrf')return json({csrfToken:'synthetic'});
 if(url.pathname==='/favicon.png'){
  res.setHeader('Content-Type','image/png');
  return res.end(fs.readFileSync(path.join(repo,'images/favicon.png')));
 }
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
 for(const viewport of [{mobile:false,width:1280,height:900},{mobile:false,width:744,height:534},{mobile:true,width:390,height:844},{mobile:true,width:360,height:800},{mobile:true,width:844,height:390},{mobile:true,tablet:true,width:800,height:1024},{mobile:true,tablet:true,width:1024,height:650}]) {
  const {mobile,tablet,width,height}=viewport;
  const client=await browser({mobile:viewport.touch??mobile});
  try {
   await client.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
   for(const theme of ['light','dark']) {
    await client.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
    await client.call('Page.navigate',{url:origin+'/login'});
    await client.wait(`location.pathname==='/login' && !!document.querySelector('.ignis-language button')`,'theme selector alongside language');
    assert.equal(await client.run(`(()=>{
     const dropdown=document.querySelector('.ignis-language-dropdown');
     return !!dropdown?.querySelector('select') && getComputedStyle(dropdown,'::after').content!=='none';
    })()`),true,'language selector shows its chevrons');

    await client.run(`if(IgnisUiEnvironment.theme(window)!=='${theme}')document.querySelector('.ignis-language button').click();`);
    await client.wait(`document.body.classList.contains('theme-${theme}')`,'chosen theme applies immediately');

    for(const page of ['setup','login','reset-password','share-target']) {
     await client.call('Page.navigate',{url:origin+'/'+page});
     await client.wait(`location.pathname==='/${page}' && document.readyState==='complete' && document.body.classList.contains('theme-${theme}') && !!window.IgnisI18n`,'standalone theme');
     if(page==='share-target') {
      await client.wait(`!!window.IgnisIncoming`,'incoming store');
      await client.run(`IgnisIncoming.change('synthetic',()=>({id:'synthetic',createdAt:Date.now(),title:'Shared title',text:'https://example.com',url:'',files:[],names:[],completed:[],state:'pending'}))`);
      await client.call('Page.navigate',{url:origin+'/share-target?id=synthetic&signed-out=1'});
      await client.wait(`location.pathname==='/share-target' && location.search==='?id=synthetic&signed-out=1' && document.body?.classList.contains('ignis-access-entry') && document.querySelector('#signin')?.hidden===false`,'signed-out share uses the access panel');
      assert.equal(await client.run(`(()=>{const actions=document.querySelector('#signin .dialog-actions');return actions.children.length===1 && actions.firstElementChild.matches('a.mod-cta');})()`),true,'signed-out capture offers only sign-in');
      await client.run("document.querySelector('#share-sign-in').click();void 0;");
      await client.wait(`location.pathname==='/login' && sessionStorage.getItem('ignis-share-sign-in')==='synthetic' && document.querySelector('#login-form')?.hidden===false`,'sign-in remembers the pending share in the same tab');
      await client.run(`{const form=document.querySelector('#login-form');form.elements.login.value='user';form.elements.password.value='password';form.requestSubmit();}`);
      await client.wait(`location.pathname==='/share-target' && location.search==='?id=synthetic'`,'sign-in automatically resumes the original share');
      await client.wait(`document.querySelector('#capture')?.hidden===false`,'incoming form');
     } else await client.wait(`document.querySelector('form')?.hidden===false`,'entry form');
     if(['setup','login','share-target'].includes(page)){
      assert.equal(await client.run(`(()=>{
       const icon=document.querySelector('.entry-brand img');
       const name=document.querySelector('.entry-brand [data-ignis-app-name]');
       if(!icon?.naturalWidth || icon.alt!=='' || !name?.textContent.trim())return false;
       const imageBox=icon.getBoundingClientRect(),nameBox=name.getBoundingClientRect();
       return imageBox.width===28 && imageBox.height===28 &&
        getComputedStyle(name).fontSize==='24px' &&
        getComputedStyle(name).color===getComputedStyle(document.querySelector('h1')).color &&
        (getComputedStyle(icon).filter!=='none')===('${theme}'==='light') &&
        nameBox.height===imageBox.height && Math.abs(nameBox.top-imageBox.top)<1;
      })()`),true,'the access heading displays the Ignis icon beside its name');
     }
     const layout=await client.run(`(()=>{const main=document.querySelector('main'),input=main.querySelector('input:not([type=hidden]):not([type=checkbox])'),style=getComputedStyle(input),box=main.getBoundingClientRect();return {width:box.width,left:box.left,scroll:document.documentElement.scrollWidth,viewport:innerWidth,available:document.body.clientWidth,font:style.fontSize,height:input.getBoundingClientRect().height,color:getComputedStyle(document.body).backgroundColor,theme:document.body.classList.contains('theme-${theme}'),native:!!getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim(),contain:getComputedStyle(document.body).contain};})()`);
     assert.equal(await client.run("document.body.classList.contains('is-mobile')"),mobile,'interaction mode');
     if(page==='share-target'){
      for(const button of ['choose-new-note','mkdir']){
       await client.run(`document.getElementById('${button}').click();void 0;`);
       assert.equal(await client.run(`(()=>{const d=document.querySelector('#resource-dialog'),i=document.querySelector('#resource-name'),x=document.querySelector('#resource-close');return d.open && document.activeElement===i && i.getBoundingClientRect().height>=${mobile?40:30} && x.getBoundingClientRect().width>0 && getComputedStyle(d).backgroundColor!=='rgba(0, 0, 0, 0)';})()`),true);
       await client.run("document.querySelector('#resource-close').click();void 0;");
       assert.equal(await client.run("document.querySelector('#resource-dialog').open"),false);
      }
     }
     if(page==='share-target'){
      assert.equal(await client.run(`[...document.querySelectorAll('.resource-actions button svg')].every(svg=>{
       const icon=svg.getBoundingClientRect(),button=svg.parentElement.getBoundingClientRect();
       return icon.width===18 && icon.height===18 &&
        Math.abs(icon.left+icon.width/2-button.left-button.width/2)<1 &&
        Math.abs(icon.top+icon.height/2-button.top-button.height/2)<1;
      })`),true,'both share action icons stay full-sized and centered');
      assert.equal(await client.run("getComputedStyle(document.querySelector('.resource-actions button')).height"),mobile?'44px':'32px');
      assert.equal(await client.run("getComputedStyle(document.querySelector('.destination-tree')).getPropertyValue('--incoming-toggle-width').trim()"),mobile?'44px':'32px');
     }else{
      assert.equal(await client.run("getComputedStyle(document.querySelector('main')).borderTopWidth"),mobile?'0px':'1px');
     }
     if(mobile && ['setup','login'].includes(page)){
      const formWidth=await client.run("document.querySelector('form').getBoundingClientRect().width");
      assert.equal(formWidth,layout.width-48,'mobile access form keeps its usable width');
      if(page==='login')assert.equal(await client.run("document.querySelector('.login-actions').getBoundingClientRect().width"),formWidth,'provider actions align with the form');
      assert.equal(await client.run('document.activeElement?.id'),page==='setup'?'initial-key':'login');
      await client.call('Input.insertText',{text:'focus-check'});
      assert.equal(await client.run('document.activeElement.value'),'focus-check','typing reaches the focused field');
      assert.equal(await client.run(`(()=>{
       const field=document.activeElement,button=document.querySelector('.ignis-language button');
       button.click();
       const changed=IgnisUiEnvironment.theme(window)!=='${theme}';
       button.click();
       return changed && IgnisUiEnvironment.theme(window)==='${theme}' && field.value==='focus-check';
      })()`),true,'changing the entry theme preserves the typed form values');

      await client.run("document.activeElement.value=''");
     }
     if(page==='setup')assert.equal(await client.run(`[...document.querySelectorAll('.setup-help-toggle')].every(button=>{const rect=button.getBoundingClientRect();return rect.width===22&&rect.height===22;})`),true,'help buttons stay circular in every mode');
     const accessPanel=mobile;
     if(accessPanel && !tablet && height>=800 && page==='login'){
      assert.ok(await client.run(`(()=>{const r=document.querySelector('main').getBoundingClientRect(),s=getComputedStyle(document.body);return r.height>=innerHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom)-1;})()`),'phone login fills the safe viewport');
     }

     if(tablet && accessPanel){
      const panel=await client.run(`(()=>{const r=document.querySelector('main').getBoundingClientRect(),s=getComputedStyle(document.body);return {top:r.top,height:r.height,available:innerHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom),inset:parseFloat(s.paddingTop)};})()`);
      assert.ok(Math.abs(panel.top-panel.inset-Math.max(0,(panel.available-panel.height)/2))<1,'tablet panel centers when it fits and starts inside the safe area when it overflows');
      if(page==='login')assert.ok(panel.height<panel.available,'tablet login fits its content');
      if(panel.height>panel.available){
       assert.equal(await client.run(`(()=>{const main=document.querySelector('main');window.scrollTo(0,document.scrollingElement.scrollHeight);const reachable=main.getBoundingClientRect().bottom<=innerHeight;window.scrollTo(0,0);return reachable;})()`),true,'long tablet panel can scroll to its end');
      }
     }
     if(mobile && !(tablet && accessPanel)){
      const brandTop=await client.run(`document.querySelector('.brand').getBoundingClientRect().top`);
      const expectedTop=accessPanel?36:16;
      assert.ok(brandTop>=expectedTop && brandTop<=expectedTop+1,'mobile brand respects the top inset and panel padding');
     }
     assert.equal(layout.native,true,'installed native CSS provides tokens');assert.equal(layout.contain,'none','entry page can grow and scroll');
     const maximum=page==='share-target'&&!mobile?704:400;
     assert.equal(layout.width,Math.min(maximum,layout.available-(accessPanel?0:32)),'entry page uses its designated width, including padding and border');assert.ok(layout.left>=0);assert.ok(layout.scroll<=layout.viewport,'no horizontal overflow');assert.ok(layout.height>=28);
     if(page==='share-target') {
      assert.equal(await client.run(`(()=>{
       const style=getComputedStyle(document.querySelector('main'));
       return parseFloat(style.borderBottomLeftRadius)>0 && style.backgroundColor!=='rgba(0, 0, 0, 0)';
      })()`),true,'sharing uses a rounded panel with its own background');
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
     if(page==='setup' && mobile) {
      assert.equal(await client.run('document.activeElement?.id'),'initial-key','mobile setup focuses the installation key once the form is visible');
     }
     if(page!=='share-target') {
      assert.equal(await client.run(`(()=>{const inputs=[...document.querySelector('form').querySelectorAll('input:not([type=checkbox])')];return inputs.every(input=>Math.abs(input.getBoundingClientRect().width-inputs[0].getBoundingClientRect().width)<1 && Math.abs(input.getBoundingClientRect().height-inputs[0].getBoundingClientRect().height)<1);})()`),true,'text and password fields have identical native dimensions');
      const toggle=await client.run(`(()=>{const button=document.querySelector('.password-toggle');if(!button)return false;const field=button.parentElement.querySelector('input');const width=field.getBoundingClientRect().width;button.click();return button.getAttribute('aria-pressed')==='true' && field.getBoundingClientRect().width===width;})()`);
      assert.equal(toggle,true,'password visibility works without reflow');
     }
     if(page==='login') {
      if(mobile)assert.equal(await client.run('document.activeElement?.id'),'login','mobile login focuses the username once the form is visible');
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
   if (width===390) {
    await client.call('Page.addScriptToEvaluateOnNewDocument',{source:`
     window.__ignisAndroidExternalLanguage=sessionStorage.getItem('test-device-language') || 'es';
     window.__ignisAndroidExternalTheme='light';
     window.prompt=(action,value)=>{
      if(action!=='IgnisAndroid:external-language')return null;
      sessionStorage.setItem('test-device-language',value);
      return value;
     };
    `});
    for(const page of ['setup','login']){
     await client.call('Page.navigate',{url:origin+'/'+page});
     await client.wait(`location.pathname==='/${page}' && document.documentElement.lang==='es' && document.body.classList.contains('theme-light') && document.querySelector('[data-ignis-language]')?.value==='es'`,'native setup preferences reach '+page);
    }
    await client.run(`{const selector=document.querySelector('[data-ignis-language]');selector.value='en';selector.dispatchEvent(new Event('change'));}`);
    await client.wait(`document.documentElement?.lang==='en' && sessionStorage.getItem('test-device-language')==='en'`,'language selector updates the Android preference');
   }
   assert.deepEqual(client.errors.filter(error=>typeof error==='string'),[],'no uncaught browser errors');
   console.log(JSON.stringify({status:'passed',mobile,width,height,pages:4,themes:['light','dark']}));
  }finally{await client.close();}
 }
}finally{await new Promise(resolve=>server.close(resolve));}
