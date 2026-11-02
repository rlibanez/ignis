// Presentation-only destinations. Never take a redirect URL or an account id.
export function readManagementIntent(search) {
  const params=new URLSearchParams(search),kind=params.get('manage');
  return ['account','users','shares','password','email'].includes(kind) ? kind : null;
}
export function consumeManagementIntent(host, open) {
  let kind=readManagementIntent(host.location.search);
  // Login reauthentication already saves this bounded presentation intent before
  // leaving for the provider. It never authorizes or replays a user operation.
  try{
    const saved=host.sessionStorage.getItem('ignis-reauth-return');
    host.sessionStorage.removeItem('ignis-reauth-return');
    if(!kind)kind=saved==='users'?'users':saved==='link'?'account':null;
  }catch{}
  if(!kind)return;
  open(kind);
  const url=new URL(host.location.href);
  for(const key of ['manage','reauth','oidc'])url.searchParams.delete(key);
  host.history.replaceState(null,'',url.pathname+url.search+url.hash);
}
