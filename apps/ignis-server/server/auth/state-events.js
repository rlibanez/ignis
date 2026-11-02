// Account-scoped invalidations contain no resource names, paths or other users.
// Snapshots are projected separately for each authenticated connection.
function createStateEvents({resolve, snapshot, valid, entries}) {
  function capture(token) { return JSON.stringify(snapshot(token)); }
  function reconcile() {
    for (const [ws,entry] of entries) {
      try {
        if (!valid(ws)) continue;
        const next=capture(entry.token);
        if (next===entry.stateSnapshot) continue;
        const before=JSON.parse(entry.stateSnapshot),after=JSON.parse(next);
        entry.stateSnapshot=next;
        if(entry.events && ws.readyState===1)entry.sendState({type:"ignis-state",
          account:JSON.stringify(before?.user)!==JSON.stringify(after?.user),
          shares:JSON.stringify(before?.shares)!==JSON.stringify(after?.shares),
          vaults:JSON.stringify(before?.vaults)!==JSON.stringify(after?.vaults)});
      } catch { ws.terminate(); }
    }
  }
  function sharedContent(users) {
    for(const [ws,entry] of entries) {
      if(!entry.events)continue;
      try {
        const session=resolve(entry.token);
        if(!session || !users.has(session.user.id) || !valid(ws))continue;
        if(ws.readyState===1)entry.sendState({type:"ignis-state",shares:true});
      } catch { ws.terminate(); }
    }
  }
  return {capture,reconcile,sharedContent};
}
module.exports={createStateEvents};
