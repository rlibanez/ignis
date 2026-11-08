// Shared startup policy. Interaction mode stays stable during rotation/resizing.
(() => {
 function mobile(host) {
  return host.document?.body?.classList.contains('is-mobile') || host.innerWidth<600 ||
   (host.matchMedia?.('(pointer: coarse)').matches && host.innerWidth<=1024);
 }
 function initialize(host) {
  const touch=!!mobile(host),dark=host.matchMedia('(prefers-color-scheme: dark)');
  const apply=()=>{
   host.document.body.classList.toggle('theme-dark',dark.matches);
   host.document.body.classList.toggle('theme-light',!dark.matches);
   host.document.body.classList.toggle('is-mobile',touch);
   host.document.body.classList.toggle('is-phone',touch);
   host.document.documentElement.style.colorScheme=dark.matches?'dark':'light';
  };
  apply();dark.addEventListener('change',apply);
  return ()=>dark.removeEventListener('change',apply);
 }
 const api={mobile,initialize};
 if(typeof module!=='undefined')module.exports=api;
 else globalThis.IgnisUiEnvironment=api;
})();
