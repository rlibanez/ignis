// One account connection per document. No credentials, paths or grants in events.
(() => {
  if(window.IgnisEvents)return;
  let socket,context,retry,stopped=false,suspended=false,checking=false,pending=false,generation=0,delay=1000,requested=false;
  const emit=detail=>window.dispatchEvent(new CustomEvent('ignis:state-changed',{detail}));
  function schedule(){
    if(retry || socket || stopped || suspended || document.visibilityState==='hidden' || !requested)return;
    const wait=Math.min(30000,Math.round(delay*(0.8+Math.random()*0.4)));
    delay=Math.min(30000,delay*2);
    retry=setTimeout(()=>{retry=null;void check();},wait);
  }
  function connect(id){
    if(stopped || suspended || !id)return;
    if(context && context!==id){stop();return;}
    context=id;requested=true;
    if(socket || document.visibilityState==='hidden')return;
    clearTimeout(retry);retry=null;
    const current=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws?events=1&context=${encodeURIComponent(id)}`);
    socket=current;
    current.onopen=()=>{
      if(socket!==current || stopped)return;
      delay=1000;clearTimeout(retry);retry=null;emit({account:true,shares:true,vaults:true,reconnected:true});
    };
    current.onmessage=event=>{
      if(socket!==current || stopped)return;
      try{const data=JSON.parse(event.data);if(data.type==='ignis-state')emit({account:data.account===true,shares:data.shares===true,vaults:data.vaults===true});}catch{}
    };
    current.onerror=()=>{};
    current.onclose=()=>{if(socket!==current)return;socket=null;schedule();};
  }
  async function check(){
    if(stopped || suspended || document.visibilityState==='hidden')return;
    if(checking){pending=true;return;}
    const epoch=generation;checking=true;
    try{
      const response=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});
      if(epoch!==generation || stopped || suspended)return;
      if(response.status===401){stop();if(window.__ignisAuth)window.__ignisAuth.check();else location.replace('/login');return;}
      if(!response.ok)return;
      const session=await response.json();
      if(epoch!==generation || stopped || suspended)return;
      if(typeof session?.sessionId!=='string' || !session.sessionId)return;
      if(context && context!==session.sessionId){stop();if(window.__ignisAuth)window.__ignisAuth.check();else location.replace('/login');return;}
      connect(session.sessionId);
    }catch{/* An outage is not proof of session revocation. */}
    finally{
      checking=false;
      if(pending){pending=false;void check();}else schedule();
    }
  }
  function release(){generation++;const previous=socket;socket=null;previous?.close();}
  function stop(){stopped=true;pending=false;clearTimeout(retry);retry=null;release();}
  window.IgnisEvents={connect,stop};
  window.addEventListener('ignis:auth-lost',stop,{once:true});
  window.addEventListener('pagehide',()=>{suspended=true;clearTimeout(retry);retry=null;release();});
  window.addEventListener('pageshow',()=>{suspended=false;if(context && !stopped)void check();});
  window.addEventListener('online',()=>{if(context && !stopped){clearTimeout(retry);retry=null;void check();}});
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState!=='visible' || stopped || !requested)return;
    // Reconnect after background suspension and refresh authorized state; events
    // are invalidations, not a durable history that a client can replay blindly.
    clearTimeout(retry);retry=null;release();void check();
  });
  window.addEventListener('ignis:state-changed',event=>{if(event.detail.account)void check();});
  if(window.__ignisAuth)window.__ignisAuth.ready.then(()=>connect(window.__ignisAuth.sessionId)).catch(()=>{});
  else if(location.pathname!=='/login'){requested=true;void check();}
})();
