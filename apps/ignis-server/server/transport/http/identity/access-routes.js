function createRoutes({identity,config,csrf,limits,cookies,rememberCookies,resetCookies,safe,originAllowed,initialized,sweepSockets,finishRemember,normalizeLogin,now}) {
  return async function handle(req,res,pathname,session) {
    const token=cookies.read(req.headers.cookie);
    if (req.method === "GET" && pathname === "/api/auth/status") {
      return res.json({
        initialized: initialized(),
        ...(identity.oidcAvailable() && initialized() ? { oidcAvailable: true, oidcButtonText: config.oidcButtonText } : {}),
        setupAvailable: identity.setupAvailable(),
        ...((identity.setupAvailable() || initialized()) ? { passwordPolicy: config.passwordPolicy } : {}),
      });
    }
    if (req.method === "GET" && pathname === "/api/auth/csrf") {
      const challenge=csrf.issue(req,res,session);
      return challenge?res.json({csrfToken:challenge}):safe(res,429,"Too many requests");
    }
    if(req.method==="GET" && pathname==="/api/auth/session") {
      if(!session)req.ignisExpectedLogOutcome="no-session";
      return session?res.json(identity.account(token,session.id)):safe(res,401,"Authentication required");
    }
    if (
      req.method !== "POST" ||
      !["/api/auth/login", "/api/auth/logout", "/api/auth/setup"].includes(
        pathname,
      )
    )
      return safe(res, 404, "Not found");
    if (!originAllowed(req, true) || !csrf.valid(req, session))
      return safe(res, 403, "Request rejected");
    if (pathname === "/api/auth/setup") {
      if (!limits.setup(req.ip)) {
        res.set("Retry-After", "900");
        return safe(res, 429, "Too many requests");
      }
      const result = await identity.setup(req.body);
      if (result.error) return safe(res, result.status, result.error);
      csrf.consume(req);
      req.ignisLogUsername = result.username;
      return res.status(201).json({ initialized: true });
    }
    if (pathname === "/api/auth/logout") {
      identity.forget(rememberCookies.read(req.headers.cookie));
      res.append("Set-Cookie",rememberCookies.clear());
      identity.revoke(cookies.read(req.headers.cookie));
      csrf.consume(req);
      res.append("Set-Cookie", cookies.clear());
      sweepSockets();
      req.ignisLogUsername = session?.user.login;
      return res.status(204).end();
    }
    if (req.body?.rememberMe !== undefined && typeof req.body.rememberMe !== "boolean") return safe(res,400,"Invalid remember preference");
    let login = null;
    try {
      login = normalizeLogin(req.body?.login);
    } catch {
      /* Account-independent failure. */
    }
    req.ignisLogAttemptedUsername = login;
    if (!limits.login(req.ip, login)) {
      res.set("Retry-After", "60");
      return safe(res, 429, "Too many requests");
    }
    if (!initialized()) return safe(res, 403, "Initial administrator required");
    const loginResult = await identity.login(login,req.body?.password);
    const result=loginResult?.authentication;
    if (!result) {
      const reset = loginResult?.reset;
      if (!reset) return safe(res, 401, "Invalid credentials");
      identity.revoke(cookies.read(req.headers.cookie));
      csrf.consume(req);
      res.append("Set-Cookie", cookies.clear());
      identity.forget(rememberCookies.read(req.headers.cookie));
      res.append("Set-Cookie",rememberCookies.clear());
      res.append("Set-Cookie", resetCookies.serialize(reset.token, reset.expiresAt, now()));
      sweepSockets();
      req.ignisLogUsername = login;
      return res.json({ passwordResetRequired: true });
    }
    res.append("Set-Cookie", resetCookies.clear());
    // End the browser's previous identity only after successful authentication.
    identity.revoke(cookies.read(req.headers.cookie));
    finishRemember(req,res,result,req.body?.rememberMe===true);
    csrf.consume(req);
    res.append(
      "Set-Cookie",
      cookies.serialize(result.token, result.session.expiresAt, now()),
    );
    sweepSockets();
    req.ignisLogUsername = result.session.user.login;
    return res.json({
      user: result.session.user,
      expiresAt: result.session.expiresAt,
    });

  };
}
module.exports = {createRoutes};
