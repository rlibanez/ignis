// Keep our notices above the legacy vault manager without changing the native
// notice container or any notices created by upstream code.
export function showManagementNotice(Notice, ...args) {
  const notice = new Notice(...args);
  const element = notice.noticeEl?.closest?.('.notice');
  const document = element?.ownerDocument;
  if (!document?.querySelector('.vault-manager-overlay')) return notice;
  let layer = document.querySelector('.ignis-management-notices');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'notice-container ignis-management-notices';
    document.body.append(layer);
    const observer = new document.defaultView.MutationObserver(() => {
      if (!layer.childElementCount) { observer.disconnect(); layer.remove(); }
    });
    observer.observe(layer, {childList:true});
  }
  layer.append(element);
  return notice;
}
