// Serializable identity context, never a credential or a durable authorization.
const RECENT_AUTHENTICATION_MS = 5 * 60 * 1000;
function sessionContext(session) {
  if (!session || typeof session.id !== 'string' || !session.id ||
      typeof session.user?.id !== 'string' || !session.user.id ||
      !['admin','user'].includes(session.user.role) ||
      !Number.isSafeInteger(session.user.authVersion) || session.user.authVersion < 1) {
    throw Object.assign(new Error('Authenticated session context required'),{code:'AUTH_CONTEXT_CHANGED'});
  }
  return Object.freeze({sessionId:session.id,userId:session.user.id,role:session.user.role,authVersion:session.user.authVersion});
}
function matchesSession(context, session) {
  return !!session && context.sessionId === session.id && context.userId === session.user?.id &&
    context.role === session.user.role && context.authVersion === session.user.authVersion;
}
// Only authoritative session data may be used for server authorization.
function recentlyAuthenticated(session, now) {
  return Number.isSafeInteger(session?.authenticatedAt) && Number.isFinite(now) &&
    now >= session.authenticatedAt && now - session.authenticatedAt < RECENT_AUTHENTICATION_MS;
}
module.exports = {sessionContext,matchesSession,recentlyAuthenticated,RECENT_AUTHENTICATION_MS};
