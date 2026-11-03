function createRoutes({identity,config,csrf,limits,cookies,safe,originAllowed,initialized,sweepSockets}) {
  return async function handle(req,res,pathname,session) {
    const token=cookies.read(req.headers.cookie);
    const deletingUser = pathname.endsWith("/delete");
    const resettingPassword = pathname.endsWith("/reset-password");
    const settingPassword = pathname.endsWith("/set-password");
    const changingStatus = pathname.endsWith("/status");
    const unlinkingOidc = pathname.endsWith("/unlink-oidc");
    const revokingSessions = pathname.endsWith("/revoke-sessions");
    if (!["GET", "POST"].includes(req.method) || ((deletingUser || resettingPassword || settingPassword || changingStatus || revokingSessions || unlinkingOidc) && req.method !== "POST"))
      return safe(res, 404, "Not found");
    if (!session) return safe(res, 401, "Authentication required");
    req.ignisLogUsername = session.user.login;
    if (!initialized() || session.user.role !== "admin")
      return safe(res, 403, "Administrator access required");
    if (req.headers["x-ignis-context"] &&
        req.headers["x-ignis-context"] !== session.id)
      return safe(res, 409, "Session changed");
    if (req.method === "GET")
      return res.json({
        users: identity.listUsers(token,session.id),
        oidcAvailable: identity.oidcAvailable(),
        oidcButtonText: config.oidcButtonText,
        passwordPolicy: config.passwordPolicy,
      });
    if (!originAllowed(req, true) || !csrf.valid(req, session))
      return safe(res, 403, "Request rejected");
    const isCurrent = identity.guard(token,session.id,{admin:true,recent:true});
    if (!isCurrent()) return res.status(403).json({
      error: "Sign in again before managing users", code: "REAUTH_REQUIRED",
    });
    if (!limits.createUser(session.user.id))
      return safe(res, 429, "Too many requests");
    const body = req.body;
    // Capture before deletion/revocation, using the database, never a supplied login.
    if (typeof body?.userId === "string" && body.userId.length <= 64)
      req.ignisLogTargetUsername = identity.username(token,session.id,body.userId);
    if (deletingUser) {
      if (req.headers["x-ignis-context"] !== session.id) return safe(res,409,"Session changed");
      const preview = body?.operation === "preview";
      const keys = preview ? "operation,userId" : "confirmLogin,deleteVaults,operation,revision,userId";
      if (!body || Array.isArray(body) || Object.keys(body).sort().join(",") !== keys ||
          !["preview","delete"].includes(body.operation) || typeof body.userId !== "string" || !body.userId || body.userId.length > 64 ||
          (!preview && (typeof body.deleteVaults !== "boolean" || typeof body.confirmLogin !== "string" ||
            typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision))))
        return safe(res,400,"Invalid account deletion request");
      try {
        if (preview) return res.json(identity.deletePlan(token,session.id,body.userId));
        // A replay cannot start a second destructive operation with this CSRF token.
        csrf.consume(req);
        const result = await identity.deleteUser(token,session.id,body);
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        const messages = {
          SELF_DELETE:"You cannot delete your own account.",
          LAST_ADMIN:"The last active administrator cannot be deleted.",
          USER_NOT_FOUND:"This account no longer exists.",
          USER_STATE_CHANGED:"The account or its vaults changed. Reload the deletion preview before confirming.",
          OWNED_VAULTS:"Transfer or delete the owned vaults first, or explicitly select deletion of all owned vaults.",
          DELETE_BUSY:"Deletion is already running. Reload the preview to check its progress.",
          DELETE_UNAVAILABLE:"Vault deletion is unavailable.",
        };
        if (Object.hasOwn(messages,error.code)) return res.status(409).json({code:error.code,error:messages[error.code]});
        if (!isCurrent()) return safe(res,403,"Administrator session required");
        return safe(res,503,"Account deletion could not be confirmed. Reload the preview before trying again.");
      }
    }
    if (resettingPassword) {
      if (req.headers["x-ignis-context"] !== session.id) return safe(res, 409, "Session changed");
      if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== "userId") || typeof body.userId !== "string" || !body.userId || body.userId.length > 64)
        return safe(res, 400, "Expected userId only");
      try {
        const result = identity.issueReset(token,session.id,body.userId);
        csrf.consume(req);
        sweepSockets();
        const signedOut = body.userId === session.user.id;
        if (signedOut) res.append("Set-Cookie", cookies.clear());
        return res.json({ ...result, signedOut });
      } catch (error) {
        if (["SESSION_CHANGED", "RESET_UNAVAILABLE"].includes(error.code)) return safe(res, 400, "Password reset unavailable for this account");
        throw error;
      }
    }
    if (settingPassword) {
      if (req.headers["x-ignis-context"] !== session.id) return safe(res, 409, "Session changed");
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !["userId", "password"].includes(key)) ||
          typeof body.userId !== "string" || !body.userId || body.userId.length > 64 || typeof body.password !== "string")
        return safe(res, 400, "Expected userId and password");
      try {
        await identity.setUserPassword(token,session.id,body);
        csrf.consume(req);
        sweepSockets();
        const signedOut = body.userId === session.user.id;
        if (signedOut) res.append("Set-Cookie", cookies.clear());
        return res.json({ signedOut });
      } catch (error) {
        const known = ["PASSWORD_POLICY", "LOCAL_PASSWORD_EXISTS", "USER_NOT_FOUND", "USER_STATE_CHANGED", "OIDC_NOT_LINKED"];
        if (known.includes(error.code)) return res.status(400).json({ error: "Unable to set local password", code: error.code });
        if (error.code === "AUTH_BUSY") return safe(res, 429, "Too many requests");
        if (error.code === "SESSION_CHANGED") return safe(res, 403, "Administrator session changed; sign in again");
        throw error;
      }
    }
    if (revokingSessions || unlinkingOidc) {
      if (!body || Array.isArray(body) || Object.keys(body).some((key) => key !== "userId") ||
          typeof body.userId !== "string" || !body.userId || body.userId.length > 64)
        return safe(res, 400, "Expected userId only");
      try {
        if (unlinkingOidc && !identity.oidcAvailable()) return safe(res, 404, "OpenID Connect unavailable");
        const result = unlinkingOidc
          ? identity.unlinkUser(token,session.id,body.userId)
          : identity.revokeSessions(token,session.id,body.userId);
        const signedOut = body.userId === session.user.id;
        csrf.consume(req);
        if (signedOut) res.append("Set-Cookie", cookies.clear());
        sweepSockets();
        return res.json({ ...result, signedOut });
      } catch (error) {
        if (error.code === "USER_NOT_FOUND") return safe(res, 404, "User not found");
        if (error.code === "LOCAL_PASSWORD_REQUIRED")
          return res.status(400).json({ error: "A local password is required before unlinking.", code: error.code });
        if (error.code === "OIDC_NOT_LINKED")
          return res.status(409).json({ error: "Account is no longer linked. Reload the list.", code: error.code });
        throw error;
      }
    }
    if (changingStatus) {
      if (!body || Array.isArray(body) ||
          Object.keys(body).some((key) => !["userId", "status", "expectedStatus", "email", "emailVerified", "expectedEmail", "expectedEmailTrust", "role", "expectedRole", "confirmAdmin", "requirePasswordChange", "expectedPasswordChangeRequired"].includes(key)) ||
          typeof body.userId !== "string" || body.userId.length > 64 ||
          !["active", "disabled"].includes(body.status) ||
          !["active", "disabled"].includes(body.expectedStatus))
        return safe(res, 400, "Invalid user status request");
      const passwordKeys = ["requirePasswordChange", "expectedPasswordChangeRequired"];
      if (passwordKeys.some(key => Object.hasOwn(body, key)) &&
          (!passwordKeys.every(key => typeof body[key] === "boolean") || req.headers["x-ignis-context"] !== session.id))
        return safe(res, 400, "Invalid password change requirement");
      const roleKeys = ["role", "expectedRole", "confirmAdmin"];
      if (roleKeys.some(key => Object.hasOwn(body, key)) &&
          (!roleKeys.every(key => Object.hasOwn(body, key)) || !["admin", "user"].includes(body.role) ||
           !["admin", "user"].includes(body.expectedRole) || typeof body.confirmAdmin !== "boolean"))
        return safe(res, 400, "Invalid role update");
      if (roleKeys.some(key => Object.hasOwn(body, key)) && req.headers["x-ignis-context"] !== session.id)
        return safe(res, 409, "Session changed");
      const emailKeys = ["email", "emailVerified", "expectedEmail", "expectedEmailTrust"];
      if (emailKeys.some(key => Object.hasOwn(body, key)) &&
          (!emailKeys.every(key => Object.hasOwn(body, key)) ||
           !(body.email === null || typeof body.email === "string") ||
           typeof body.emailVerified !== "boolean" ||
           !(body.expectedEmail === null || typeof body.expectedEmail === "string") ||
           !["unverified", "admin_confirmed", "oidc_verified"].includes(body.expectedEmailTrust)))
        return safe(res, 400, "Invalid email update");
      try {
        const {user,signedOut,changes} = identity.changeUser(token,session.id,body);
        csrf.consume(req);sweepSockets();
        if(signedOut)res.append("Set-Cookie",cookies.clear());
        req.ignisLogTargetUsername=user.login;
        req.ignisLogChanges=changes;
        return res.json({ user, signedOut });
      } catch (error) {
        const messages = {
          LOCAL_PASSWORD_REQUIRED: [400, "Set a local password before requiring a password change."],
          INVALID_PASSWORD_REQUIREMENT: [400, "Invalid password change requirement."],
          INVALID_EMAIL: [400, "Invalid email or verification confirmation."],
          EMAIL_IN_USE: [400, "Email is already assigned to another account."],
          USER_NOT_FOUND: [404, "User not found"],
          USER_DELETION_IN_PROGRESS: [409, "Deletion is in progress. Open Delete account to review its progress."],
          USER_STATE_CHANGED: [409, "Account changed. Reload the list and try again."],
          LAST_ADMIN: [400, "The last active administrator cannot be disabled or demoted."],
          INVALID_ROLE: [400, "Invalid account role."],
          SELF_ROLE_CHANGE: [400, "You cannot change your own role."],
          ADMIN_CONFIRMATION_REQUIRED: [400, "Confirm granting administrator access."],
          SELF_DISABLE: [400, "You cannot disable your own account."],
        };
        if (Object.hasOwn(messages, error.code)) {
          const [status, message] = messages[error.code];
          return res.status(status).json({ error: message, code: error.code });
        }
        throw error;
      }
    }
    if (!body || Array.isArray(body) ||
        Object.keys(body).some((key) => !["login", "password", "email", "emailVerified", "requirePasswordChange"].includes(key)) ||
        typeof body.login !== "string" || typeof body.password !== "string" ||
        (Object.hasOwn(body, "requirePasswordChange") && typeof body.requirePasswordChange !== "boolean"))
      return safe(res, 400, "Expected login and password only");
    try {
      const user = await identity.createUser(token,session.id,body);
      csrf.consume(req);
      req.ignisLogTargetUsername = user.login;
      return res.status(201).json({ user });
    } catch (error) {
      if (!isCurrent()) return safe(res, 403, "Administrator session required");
      return safe(res, error.code === "AUTH_BUSY" ? 429 : 400,
        "User creation failed; check username/email availability, email confirmation and password policy");
    }

  };
}
module.exports = {createRoutes};
