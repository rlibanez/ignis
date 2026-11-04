// Native creation selects/focuses contenteditable titles after async filesystem
// operations. Chromium can retain focus without opening Android's keyboard.
export function installRenameKeyboard(plugin, host = window) {
  const document=host.document, policies=new Map();
  const titles='.inline-title, .view-header-title, .is-being-renamed .nav-file-title-content, .is-being-renamed .nav-folder-title-content';
  const restore=field=>{
    if(!policies.has(field))return;
    const policy=policies.get(field);policies.delete(field);
    if(policy===null)field.removeAttribute('virtualkeyboardpolicy');
    else field.setAttribute('virtualkeyboardpolicy',policy);
  };
  const show=event=>{
    const field=event.target;
    if(!document.body.classList.contains('is-mobile') || document.visibilityState==='hidden' ||
      document.activeElement!==field || !field?.isContentEditable || !field.matches(titles))return;
    const keyboard=host.navigator?.virtualKeyboard;
    if(typeof keyboard?.show!=='function')return;
    // show() is asynchronous. Restoring auto immediately can cancel the request
    // before Chromium has actually displayed the keyboard. Keep manual policy
    // for this focus session, including subsequent taps, and restore on blur.
    if(!policies.has(field))policies.set(field,field.getAttribute('virtualkeyboardpolicy'));
    try {
      field.setAttribute('virtualkeyboardpolicy','manual');
      keyboard.show();
      // Native focus/selection handlers run during focusin. Retry once after
      // they finish, provided this exact title is still being edited.
      if(event.type==='focusin')host.requestAnimationFrame?.(()=>{
        if(!policies.has(field) || document.activeElement!==field || !field.isContentEditable || document.visibilityState==='hidden')return;
        try{keyboard.show();}catch{restore(field);}
      });
    } catch { restore(field); }
  };
  plugin.registerDomEvent(document,'focusin',show);
  plugin.registerDomEvent(document,'pointerup',show);
  plugin.registerDomEvent(document,'focusout',event=>restore(event.target));
  plugin.register(()=>{for(const field of policies.keys())restore(field);});
}
