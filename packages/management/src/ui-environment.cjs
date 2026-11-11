// Shared startup policy. Interaction mode stays stable during rotation/resizing.
(() => {
 const preferenceKey = 'ignis:device-interface-mode';
 let storage;
 try { storage = globalThis.localStorage; } catch { /* Storage can be disabled. */ }
 const modes = ['auto', 'phone', 'tablet', 'desktop'];
 function hasWebDeviceSettings(host) {
  return !host.__ignisAndroidInterfaceMode &&
   (/Android|iPhone|iPad|iPod/i.test(host.navigator?.userAgent ?? '') ||
    (host.navigator?.platform === 'MacIntel' && host.navigator.maxTouchPoints > 1));
 }
 function webPreference(host) {
  if (!hasWebDeviceSettings(host)) return 'auto';
  try {
   const value = storage?.getItem(preferenceKey);
   return modes.includes(value) ? value : 'auto';
  } catch { return 'auto'; }
 }
 function setWebPreference(value) {
  if (!storage || !modes.includes(value)) return false;
  try { storage.setItem(preferenceKey, value); return true; } catch { return false; }
 }

 function mode(host, { inherit = true } = {}) {
  switch (host.__ignisAndroidInterfaceMode || webPreference(host)) {
   case 'phone': return 'phone';
   case 'tablet': return 'tablet';
   case 'desktop': return 'desktop';
  }
  if (inherit && host.document?.body?.classList.contains('is-mobile')) {
   return host.document.body.classList.contains('is-tablet') ? 'tablet' : 'phone';
  }
  const coarse = host.matchMedia?.('(pointer: coarse)')?.matches;
  if ((coarse || host.__ignisAndroidInterfaceMode === 'auto') &&
      host.matchMedia?.('(min-width: 600px) and (min-height: 600px)')?.matches) return 'tablet';
  return host.innerWidth < 600 ||
   (coarse && host.innerWidth <= 1024) ? 'phone' : 'desktop';
 }
 function applyMode(host, mode) {
  host.document.body.classList.toggle('is-mobile', mode !== 'desktop');
  host.document.body.classList.toggle('is-phone', mode === 'phone');
  host.document.body.classList.toggle('is-tablet', mode === 'tablet');
 }
 function mobile(host, options) { return mode(host, options) !== 'desktop'; }
 const themeKey = 'ignis:external-theme';
 const themeStorage = host => host === globalThis && storage ? storage : host.localStorage;
 const validTheme = value => value === 'light' || value === 'dark';
 function theme(host) {
  if (validTheme(host.__ignisAndroidExternalTheme)) return host.__ignisAndroidExternalTheme;
  try {
   const value = themeStorage(host)?.getItem(themeKey);
   if (validTheme(value)) return value;
  } catch { /* Storage is optional. */ }
  return 'dark';
 }
 function applyTheme(host) {
  const selected = theme(host);
  host.document.body.classList.toggle('theme-dark',selected === 'dark');
  host.document.body.classList.toggle('theme-light',selected === 'light');
  if (host.document.documentElement?.style) host.document.documentElement.style.colorScheme=selected;
  for (const meta of host.document.querySelectorAll?.('meta[name=theme-color]') ?? []) {
   meta.content = selected === 'dark' ? '#17191e' : '#f4f5f8';
  }
 }
 function setTheme(host, value) {
  if (!validTheme(value)) return false;
  try {
   if (validTheme(host.__ignisAndroidExternalTheme)) {
    if (host.prompt('IgnisAndroid:external-theme',value) !== value) return false;
    host.__ignisAndroidExternalTheme=value;
   } else themeStorage(host).setItem(themeKey,value);
   return true;
  } catch { return false; }
 }
 function clearBrowserPreferences(host) {
  const preferences = themeStorage(host);
  const selected = preferences.getItem(themeKey);
  const local = host.localStorage;
  const account = host.__ignisAuth?.userId;
  // Obsidian stores these choices through the account facade. The login page
  // sees the same keys with their backing account prefix.
  const savedTrust = [];
  for (let index = 0; index < local.length; index++) {
   const key = local.key(index);
   const match = /^(?:ignis-account-v1:([^:]+):)?enable-plugin-ignis-v1:([^:]+):[^:]+$/.exec(key);
   if (!match || (match[1] ?? (account && encodeURIComponent(account))) !== match[2]) continue;
   const value = local.getItem(key);
   if (value === 'true' || value === 'false') savedTrust.push([key,value]);
  }
  local.clear();
  for (const [key,value] of savedTrust) local.setItem(key,value);
  if (validTheme(selected)) preferences.setItem(themeKey,selected);
 }
 function initialize(host) {
  applyMode(host,mode(host));
  const apply=()=>applyTheme(host);
  apply();
  host.addEventListener?.('ignis:external-theme',apply);
  host.addEventListener?.('storage',apply);
  return ()=>{
   host.removeEventListener?.('ignis:external-theme',apply);
   host.removeEventListener?.('storage',apply);
  };
 }
 const api={mobile,mode,applyMode,initialize,hasWebDeviceSettings,webPreference,setWebPreference,theme,applyTheme,setTheme,clearBrowserPreferences};
 if(typeof module!=='undefined')module.exports=api;
 else globalThis.IgnisUiEnvironment=api;
})();
