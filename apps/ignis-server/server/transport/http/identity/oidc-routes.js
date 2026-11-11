const {emit, sessionClient} = require("@ignis/server-core/src/logger");

function createRoutes({identity,config,csrf,limits,cookies,rememberCookies,safe,originAllowed,initialized,sweepSockets,now}) {
  return async function handle(req,res,pathname,session) {
    const token=cookies.read(req.headers.cookie);
    if (pathname === "/api/auth/oidc/callback" && req.method === "GET") {
      if (!identity.oidcAvailable() || !initialized()) return safe(res, 404, "Not found");
      if (!limits.oidcCallback(req.ip))
        return safe(res, 429, "Too many requests");
      try {
        const previous = cookies.read(req.headers.cookie);
        const result=await identity.completeOidc(config.publicOrigin+req.url,previous,req.headers.cookie,{rememberToken:rememberCookies.read(req.headers.cookie)});
        csrf.consume(req);
        const authentication = result.authentication;
        res.append("Set-Cookie",result.rememberGrant?rememberCookies.serialize(result.rememberGrant.token,result.rememberGrant.expiresAt,now()):rememberCookies.clear());
        res.append(
          "Set-Cookie",
          cookies.serialize(
            authentication.token,
            authentication.session.expiresAt,
            now(),
          ),
        );
        sweepSockets();
        req.ignisLogUsername = authentication.session.user.login;
        if (result.kind === "login") req.ignisLogChanges = result.clientInfo;
        return res.redirect(
          303,
          result.kind === "email" ? "/?manage=email" : result.kind === "password" ? "/?manage=password" : result.kind === "reauth" ? "/?manage=users&reauth=success" : result.kind === "link"
            ? "/?manage=account"
            : "/",
        );
      } catch {
        // Never render provider errors, code, state, URLs or claims.
        emit("warn", "oidc.callback_failed", {requestId:req.ignisRequestId});
        return res.redirect(303, "/login?oidc=failed");
      }
    }
    if (
      pathname === "/api/auth/oidc/start" ||
      pathname === "/api/auth/oidc/link" || pathname === "/api/auth/oidc/reauth"
    ) {
      if (!identity.oidcAvailable() || !initialized() || req.method !== "POST")
        return safe(res, 404, "Not found");
      if (!originAllowed(req, true) || !csrf.valid(req, session))
        return safe(res, 403, "Request rejected");
      if (!limits.oidcStart(req.ip)) return safe(res, 429, "Too many requests");
      if (req.body?.rememberMe !== undefined && typeof req.body.rememberMe !== "boolean") return safe(res,400,"Invalid remember preference");
      const kind = pathname.endsWith("/reauth") ? (["password","email"].includes(req.body?.purpose) ? req.body.purpose : "reauth") : pathname.endsWith("/link") ? "link" : "login";
      try {
        const result=await identity.beginOidc(kind,token,req.headers.cookie,{sessionId:req.headers["x-ignis-context"],rememberMe:req.body?.rememberMe, clientInfo:kind === "login" ? sessionClient(req.headers) : undefined});
        csrf.consume(req);
        res.append("Set-Cookie", result.cookie);
        return res.json({ authorizationUrl: result.url });
      } catch (error) {
        if(error.code==="REAUTH_UNAVAILABLE")return safe(res,403,"Reauthentication unavailable");
        if(error.code==="LINK_UNAVAILABLE")return safe(res,403,"Account linking unavailable");
        if(error.code==="REAUTH_REQUIRED")return res.status(403).json({error:"Sign in again before linking an account",code:error.code});
        if (error.code === "OIDC_UNAVAILABLE")
          return safe(res, 503, "OpenID Connect is unavailable; try again later");
        return safe(
          res,
          403,
          "OIDC request unavailable; sign in again if linking an account",
        );
      }
    }

  };
}
module.exports = {createRoutes};
