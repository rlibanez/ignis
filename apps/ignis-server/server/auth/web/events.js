// One account connection per document. No credentials, paths or grants in events.
(() => {
  if(window.IgnisEvents)return;
  let socket,context,retry,stopped=false,suspended=false,checking=false,pending=false;
  const emit=detail=>window.dispatchEvent(new CustomEvent("ignis:state-changed",{detail}));
  function connect(id){
    if(stopped || suspended || !id)return;
    if(context && context!==id){stop();return;}
    context=id;
    if(socket || document.visibilityState==="hidden")return;
    const current=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/ws?events=1&context=${encodeURIComponent(id)}`);
    socket=current;
    current.onopen=()=>{if(socket!==current || stopped)return;emit({account:true,shares:true,vaults:true,reconnected:true});};
    current.onmessage=event=>{
      if(socket!==current || stopped)return;
      try{const data=JSON.parse(event.data);if(data.type==="ignis-state")emit({account:data.account===true,shares:data.shares===true,vaults:data.vaults===true});}catch{}
    };
    current.onerror=()=>{};
    current.onclose=()=>{
      if(socket!==current)return;
      socket=null;if(stopped)return;
      void check();
      clearTimeout(retry);retry=setTimeout(()=>connect(context),2000);
    };
  }
  async function check(){
    if(stopped || suspended || document.visibilityState==="hidden")return;
    if(checking){pending=true;return;}
    checking=true;
    try{
      const response=await fetch("/api/auth/session",{credentials:"same-origin",cache:"no-store"});
      if(response.status===401){stop();if(window.__ignisAuth)window.__ignisAuth.check();else location.replace("/login");return;}
      if(!response.ok)return;
      const session=await response.json();
      if(context && context!==session.sessionId){stop();if(window.__ignisAuth)window.__ignisAuth.check();else location.replace("/login");return;}
      connect(session.sessionId);
    }catch{/* An outage is not proof of session revocation. */}
    finally{
      checking=false;
      if(pending){pending=false;void check();}
      else if(!socket && !stopped && !suspended && document.visibilityState!=="hidden"){
        clearTimeout(retry);retry=setTimeout(()=>{retry=null;void check();},2000);
      }
    }
  }
  function release(){const previous=socket;socket=null;previous?.close();}
  function stop(){stopped=true;clearTimeout(retry);release();}
  window.IgnisEvents={connect,stop};
  window.addEventListener("ignis:auth-lost",stop,{once:true});
  window.addEventListener("pagehide",()=>{suspended=true;clearTimeout(retry);release();});
  window.addEventListener("pageshow",()=>{suspended=false;if(context && !stopped)void check();});
  window.addEventListener("online",()=>{if(context && !stopped)void check();});
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState!=="visible" || stopped || !context)return;
    // Mobile can retain an apparently open but suspended socket. Reconnect and
    // request fresh state rather than trusting that no events were lost.
    release();void check();
  });
  // Session checks happen on server events/reconnection, never on an interval.
  window.addEventListener("ignis:state-changed",event=>{if(event.detail.account)void check();});
  if(window.__ignisAuth)window.__ignisAuth.ready.then(()=>connect(window.__ignisAuth.sessionId)).catch(()=>{});
  else if(location.pathname!=="/login")void check();
})();
