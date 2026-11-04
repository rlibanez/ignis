function createSharingEventStore(db,sessions,sharing){
 return Object.freeze({
  snapshot(token){
   const session=sessions.resolve(token);if(!session)return null;
   return {user:session.user,shares:sharing?.catalog(token),vaults:db.prepare(`SELECT v.id,v.name,v.directory,v.status,v.policy_version,m.role AS membership
    FROM vaults v JOIN memberships m ON m.vault_id=v.id WHERE m.user_id=? ORDER BY v.id`).all(session.user.id)};
  },
  sources(users){
   const result=new Set();if(!users.size)return result;
   for(const row of db.prepare(`SELECT DISTINCT v.directory,g.user_id,m.user_id AS owner_id FROM shared_resources r
    JOIN vaults v ON v.id=r.vault_id JOIN memberships m ON m.vault_id=v.id AND m.role='owner'
    LEFT JOIN resource_grants g ON g.resource_id=r.id WHERE v.status='active'`).all())
    if(users.has(row.user_id)||users.has(row.owner_id))result.add(row.directory);
   return result;
  },
  affectedUsers(directory,paths){
   const users=new Set();
   for(const row of db.prepare(`SELECT r.path,m.user_id AS owner_id,g.user_id FROM shared_resources r
    JOIN vaults v ON v.id=r.vault_id JOIN memberships m ON m.vault_id=v.id AND m.role='owner'
    LEFT JOIN resource_grants g ON g.resource_id=r.id WHERE v.directory=? AND v.status='active'`).all(directory)){
    if([...paths].some(path=>!path||path===row.path||path.startsWith(row.path+'/')||row.path.startsWith(path+'/'))){users.add(row.owner_id);if(row.user_id)users.add(row.user_id);}
   }
   return users;
  },
 });
}
module.exports={createSharingEventStore};
