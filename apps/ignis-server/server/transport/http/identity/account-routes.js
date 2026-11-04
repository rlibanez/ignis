function createRoutes({identity,config,csrf,limits,cookies,resetCookies,safe,originAllowed,sweepSockets,finishRemember,rebindSession,now}) {
  return async function handle(req,res,pathname,session) {
    const token=cookies.read(req.headers.cookie);
    if (pathname === "/api/auth/reset-password" && req.method === "GET") {
      const grant = identity.readReset(resetCookies.read(req.headers.cookie));
      return grant ? res.json({ login: grant.login, context: grant.context, passwordPolicy: config.passwordPolicy }) : safe(res, 401, "Password reset authorization required");
    }
    if (pathname === "/api/auth/reset-password" && req.method === "POST") {
      if (!originAllowed(req, true) || !csrf.valid(req, session)) return safe(res, 403, "Request rejected");
      if (!limits.resetPassword(req.ip)) return safe(res, 429, "Too many attempts; try again later");
      const body = req.body;
      if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== "password") ||
          typeof body.password !== "string") return safe(res, 400, "Invalid reset request");
      try {
        const completed = await identity.completeReset(resetCookies.read(req.headers.cookie),req.headers["x-ignis-reset-context"],body.password);
        req.ignisLogUsername = completed.username;
      } catch (error) {
        if (["INVALID_RESET", "PASSWORD_POLICY", "PASSWORD_UNCHANGED"].includes(error.code)) return res.status(400).json({ code: error.code, error: "Invalid reset secret or password policy" });
        throw error;
      }
      csrf.consume(req);
      sweepSockets();
      res.append("Set-Cookie", cookies.clear());
      res.append("Set-Cookie", resetCookies.clear());
      return res.json({ reset: true });
    }
    if (pathname === "/api/auth/oidc/unlink" && req.method === "POST") {
      if (!session) return safe(res, 401, "Authentication required");
      if (!identity.oidcAvailable()) return safe(res, 404, "OpenID Connect unavailable");
      if (!originAllowed(req, true) || !csrf.valid(req, session)) return safe(res, 403, "Request rejected");
      if (req.headers["x-ignis-context"] !== session.id) return safe(res, 409, "Session changed");
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).join(",") !== "password" || typeof req.body.password !== "string")
        return safe(res, 400, "Expected password only");
      const attempt = limits.checkLogin(req.ip, session.user.login);
      if (!attempt.allowed) {
        res.set("Retry-After", String(attempt.retryAfterSeconds));
        return safe(res, 429, "Too many requests");
      }
      req.ignisLogUsername = session.user.login;
      try {
        const result=await identity.unlinkOwn(token,session.id,req.body.password);
        csrf.consume(req);
        res.append("Set-Cookie", cookies.clear());
        sweepSockets();
        return res.json({ ...result, signedOut: true });
      } catch (error) {
        if(error.code==="INVALID_PASSWORD")return safe(res,400,"Incorrect password");
        if(error.code==="SESSION_CHANGED")return safe(res,409,"Session changed");
        if (["LOCAL_PASSWORD_REQUIRED", "OIDC_NOT_LINKED"].includes(error.code)) return safe(res, 409, "Account linking changed");
        throw error;
      }
    }
    if (pathname === "/api/auth/email" && req.method === "POST") {
      if(!session)return safe(res,401,"Authentication required");
      if(!originAllowed(req,true) || !csrf.valid(req,session))return safe(res,403,"Request rejected");
      if(req.headers["x-ignis-context"]!==session.id)return safe(res,409,"Session changed");
      const body=req.body;
      if(!body || Array.isArray(body) || Object.keys(body).some(key=>!["email","expectedEmail","expectedEmailTrust"].includes(key)) ||
        !(body.email===null || typeof body.email==="string") || !(body.expectedEmail===null || typeof body.expectedEmail==="string") ||
        !["unverified","admin_confirmed","oidc_verified"].includes(body.expectedEmailTrust))return safe(res,400,"Invalid email update");
      const token=cookies.read(req.headers.cookie);
      const isCurrent=identity.guard(token,session.id,{recent:true});
      if(!isCurrent())return res.status(403).json({error:"Confirm your identity before changing your email",code:"REAUTH_REQUIRED"});
      try{
        const result=identity.changeEmail(token,session.id,body);
        csrf.consume(req);
        const signedOut=result.signedOut;
        if(signedOut){res.append("Set-Cookie",cookies.clear());sweepSockets();}
        return res.json({...result,signedOut});
      }catch(error){
        if(["EMAIL_CHANGED","AUTH_CONTEXT_CHANGED","SESSION_CHANGED"].includes(error.code))return res.status(409).json({error:"Account changed; reopen your account settings",code:error.code});
        if(error.code==="INVALID_EMAIL")return res.status(400).json({error:"Invalid or unavailable email",code:error.code});
        throw error;
      }
    }
    if (pathname === "/api/auth/reauth" && req.method === "POST") {
      if (!session) return safe(res, 401, "Authentication required");
      if (!originAllowed(req, true) || !csrf.valid(req, session))
        return safe(res, 403, "Request rejected");
      if (req.headers["x-ignis-context"] !== session.id) return safe(res, 409, "Session changed");
      if (!req.body || Object.keys(req.body).some(key => key !== "password") || typeof req.body.password !== "string")
        return safe(res, 400, "Expected password only");
      const attempt = limits.checkLogin(req.ip, session.user.login);
      if (!attempt.allowed) {
        res.set("Retry-After", String(attempt.retryAfterSeconds));
        return safe(res, 429, "Too many requests");
      }
      const previous = cookies.read(req.headers.cookie);
      const keepSignedIn=identity.remembered(previous);
      const result = await identity.reauthenticate(previous, session.id, req.body.password);
      if (!result) return res.status(400).json({ error: "Incorrect password" });
      rebindSession(previous,result.token);
      finishRemember(req,res,result,keepSignedIn);
      csrf.consume(req);
      res.append("Set-Cookie", cookies.serialize(result.token, result.session.expiresAt, now()));
      sweepSockets();
      return res.json({ sessionId: result.session.id, userId: result.session.user.id });
    }
    if (pathname === "/api/auth/password" && req.method === "POST") {
      if (!session) return safe(res, 401, "Authentication required");
      req.ignisLogUsername = session.user.login;
      if (!originAllowed(req, true) || !csrf.valid(req, session))
        return safe(res, 403, "Request rejected");
      const attempt = limits.checkLogin(req.ip, session.user.login);
      if (!attempt.allowed) {
        res.set("Retry-After", String(attempt.retryAfterSeconds));
        return safe(res, 429, "Too many requests");
      }
      const body = req.body;
      if (!body || Array.isArray(body) ||
          Object.keys(body).some((key) => !["currentPassword", "newPassword"].includes(key)) ||
          (body.currentPassword !== undefined && typeof body.currentPassword !== "string") || typeof body.newPassword !== "string" ||
          Buffer.byteLength(body.currentPassword ?? "") > 1024 || Buffer.byteLength(body.newPassword) > 1024)
        return safe(res, 400, "Invalid password change request");
      const token = cookies.read(req.headers.cookie);
      try {
        if(body.currentPassword===undefined && req.headers["x-ignis-context"]!==session.id)return safe(res,409,"Session changed");
        await identity.changePassword(token,session.id,body);
      } catch (error) {
        const messages = {
          REAUTH_REQUIRED: "Confirm your identity with your linked provider before setting a local password.",
          LOCAL_PASSWORD_EXISTS: "A local password already exists. Use Change password.",
          INVALID_PASSWORD: "The current password is incorrect or no local password is configured.",
          PASSWORD_POLICY: "The new password does not meet the password policy.",
          PASSWORD_UNCHANGED: "Choose a different password.",
          SESSION_CHANGED: "Your session changed. Sign in again before retrying.",
        };
        if (Object.hasOwn(messages, error.code))
          return res.status(error.code === "SESSION_CHANGED" ? 401 : 400).json({ error: messages[error.code], code: error.code });
        throw error;
      }
      csrf.consume(req);
      res.append("Set-Cookie", cookies.clear());
      sweepSockets();
      return res.json({ signedOut: true });
    }

  };
}
module.exports = {createRoutes};
