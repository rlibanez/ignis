const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const requestContext = new AsyncLocalStorage();
const events = require("./log-events.json");
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"]);
const components = new Set(["auth", "oidc", "users", "shares", "vault", "files", "bootstrap", "plugins", "proxy", "websocket", "page", "other"]);
const errorCodes = new Set(["EACCES", "EPERM", "ENOSPC", "ENOENT", "EIO", "EMFILE", "ENFILE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SQLITE_BUSY", "SQLITE_FULL"]);
const operations = new Map([
  ...["login", "logout", "reauth", "setup", "password", "reset-password", "session", "csrf", "status"].map(name => [`/api/auth/${name}`, `auth.${name}`]),
  ...["start", "link", "reauth", "callback"].map(name => [`/api/auth/oidc/${name}`, `oidc.${name}`]),
  ...["status", "revoke-sessions", "unlink-oidc", "set-password", "reset-password", "delete"].map(name => [`/api/auth/users/${name}`, `users.${name}`]),
  ["/api/auth/users", "users.list"], ["/api/shares", "shares.manage"], ["/api/shares/content", "shares.content"],
  ...["create", "rename", "remove", "members", "transfer-ownership", "list", "info"].map(name => [`/api/vault/${name}`, `vault.${name}`]),
]);
const shareOperations = new Set(["copy", "previewRemoval", "removeConfirmed", "mounts", "destination", "rename", "create", "grant", "revoke", "browse", "read", "write", "mkdir", "remove"].map(name => `shares.${name}`));
const operationNames = new Set([...operations.values(), ...shareOperations, "users.create"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function readLogConfig(env = process.env) {
  const integer = (name, fallback, max) => {
    const value = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
      throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  const level = env.IGNIS_LOG_LEVEL ?? "info";
  if (!Object.hasOwn(levels, level)) throw new Error("Invalid IGNIS_LOG_LEVEL");
  const format = env.IGNIS_LOG_FORMAT ?? "json";
  if (!["json", "text"].includes(format)) throw new Error("Invalid IGNIS_LOG_FORMAT");
  const file = env.IGNIS_LOG_FILE_ENABLED ?? "true";
  if (!["true", "false"].includes(file)) throw new Error("Invalid IGNIS_LOG_FILE_ENABLED");
  return { level, format, fileEnabled: file === "true", maxBytes: integer("IGNIS_LOG_MAX_SIZE_MIB", 10, 100) * 1048576,
    maxFiles: integer("IGNIS_LOG_MAX_FILES", 10, 100) };
}
// Only typed metadata is accepted. Never serialize Error objects or arbitrary strings.
function metadata(input = {}) {
  const out = {};
  if (operationNames.has(input.operation)) out.operation = input.operation;
  if (errorCodes.has(input.errorCode)) out.errorCode = input.errorCode;
  for (const key of ["requestId", "vaultId"]) if (typeof input[key] === "string" && uuid.test(input[key])) out[key] = input[key];
  if ((out.operation?.startsWith("users.") || ["vault.members", "vault.transfer-ownership", "shares.create", "shares.grant"].includes(out.operation)) && typeof input.targetUsername === "string" && input.targetUsername.length > 0 && input.targetUsername.length <= 128)
    out.targetUsername = input.targetUsername;
  if (out.operation === "users.status") {
    for (const [key, values] of Object.entries({previousAccountStatus:["active","disabled"],accountStatus:["active","disabled"],previousRole:["admin","user"],role:["admin","user"],previousEmailVerification:["unverified","admin_confirmed","oidc_verified"],emailVerification:["unverified","admin_confirmed","oidc_verified"]})) {
      if (values.includes(input[key])) out[key] = input[key];
    }
    for (const key of ["changed", "emailChanged", "previousPasswordChangeRequired", "passwordChangeRequired"]) if (typeof input[key] === "boolean") out[key] = input[key];
  }
  if (out.operation === "auth.login" && input.status === 401 && typeof input.attemptedUsername === "string" &&
      input.attemptedUsername.length > 0 && input.attemptedUsername.length <= 128) out.attemptedUsername = input.attemptedUsername;
  // Callers supply names only from server-verified accounts.
  if (typeof input.username === "string" && input.username.length > 0 && input.username.length <= 128)
    out.username = input.username;
  if (out.operation?.startsWith("vault.") || input.component === "websocket") {
    for (const key of ["vaultName", "previousVaultName"]) {
      if (key === "previousVaultName" && out.operation !== "vault.rename") continue;
      if (typeof input[key] === "string" && input[key].length > 0 && input[key].length <= 255) out[key] = input[key];
    }
  }
  if (methods.has(input.method)) out.method = input.method;
  if (components.has(input.component)) out.component = input.component;
  for (const key of ["status", "durationMs", "count", "port"]) if (Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] <= 2147483647) out[key] = input[key];
  return out;
}
function createLogger({ dataRoot, level = "info", format = "json", fileEnabled = true, maxBytes = 10485760, maxFiles = 10,
  stdout = process.stdout, stderr = process.stderr, maxQueue = 1024 } = {}) {
  if (!["json", "text"].includes(format) || !Object.hasOwn(levels, level) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 104857600 ||
      !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100 || !Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 4096)
    throw new Error("Invalid logging policy");
  const directory = path.join(dataRoot, "logs");
  const extension = format === "json" ? "jsonl" : "log";
  const filename = index => path.join(directory, index ? `ignis.${index}.${extension}` : `ignis.${extension}`);
  let fd = null, bytes = 0, broken = !fileEnabled, closed = false, scheduled = null, dropped = 0;
  const queue = [], blocked = new Set();
  const streamFailures = new Map();
  for (const stream of new Set([stdout, stderr])) {
    const onError = () => blocked.add(stream);
    stream.on("error", onError);
    streamFailures.set(stream, onError);
  }
  function output(stream, line) {
    if (blocked.has(stream)) return;
    try {
      if (!stream.write(line)) { blocked.add(stream); stream.once("drain", () => blocked.delete(stream)); }
    } catch { /* A broken collector must not take down the application. */ }
  }
  function lineFor(severity, event, fields = {}) {
    const record = { time: new Date().toISOString(), level: severity, event, message: events[event], ...metadata(fields), ...metadata(requestContext.getStore()) };
    if (format === "json") return JSON.stringify(record) + "\n";
    const { time, level, message, ...details } = record;
    delete details.event;
    const suffix = Object.entries(details).map(([key, value]) => `${key}=${["username", "attemptedUsername", "targetUsername", "vaultName", "previousVaultName"].includes(key) ? JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") : value}`).join(" ");
    return `${time} ${level.toUpperCase()} [${event}] ${message}${suffix ? ` ${suffix}` : ""}\n`;
  }
  function failFile() {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* Already closed. */ } fd = null; }
    if (!broken) output(stderr, lineFor("error", "logging.file_unavailable"));
    broken = true;
  }
  function verifyFile(file) {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid())) throw new Error("Unsafe log file");
      return st;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function openFile() {
    verifyFile(filename(0));
    fd = fs.openSync(filename(0), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid())) throw new Error("Unsafe log file");
    fs.fchmodSync(fd, 0o600);
    if (st.size > maxBytes) fs.ftruncateSync(fd, 0);
    bytes = st.size > maxBytes ? 0 : st.size;
  }
  function rotate() {
    for (let i = 0; i < maxFiles; i++) verifyFile(filename(i));
    fs.closeSync(fd); fd = null;
    if (fs.existsSync(filename(maxFiles - 1))) fs.unlinkSync(filename(maxFiles - 1));
    for (let i = maxFiles - 2; i >= 0; i--) if (fs.existsSync(filename(i))) fs.renameSync(filename(i), filename(i + 1));
    openFile();
  }
  if (fileEnabled) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error("Unsafe log directory");
      fs.chmodSync(directory, 0o700);
      // Remove only owned regular archives outside the newly configured retention.
      for (const name of fs.readdirSync(directory)) {
        const match = /^ignis\.([1-9][0-9]*)\.(jsonl|log)$/.exec(name);
        if (!match || match[2] !== extension) continue;
        const archive = verifyFile(path.join(directory, name));
        if (Number(match[1]) >= maxFiles || archive.size > maxBytes) fs.unlinkSync(path.join(directory, name));
        else fs.chmodSync(path.join(directory, name), 0o600);
      }
      openFile();
    } catch { failFile(); }
  }
  function persist(line) {
    if (broken) return;
    try {
      if (bytes + Buffer.byteLength(line) > maxBytes) rotate();
      const buffer = Buffer.from(line);
      let offset = 0;
      while (offset < buffer.length) {
        const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
        if (!written) throw new Error("Log write failed");
        offset += written; bytes += written;
      }
    } catch { failFile(); }
  }
  function drain(all = false) {
    scheduled = null;
    let count = all ? queue.length : Math.min(queue.length, 64);
    while (count-- > 0) { const { line, severity } = queue.shift(); output(severity === "error" ? stderr : stdout, line); persist(line); }
    if (dropped) { const line = lineFor("warn", "logging.dropped", { count: dropped }); dropped = 0; output(stderr, line); persist(line); }
    if (queue.length) scheduled = setImmediate(drain);
  }
  function emit(severity, event, fields) {
    if (closed || !Object.hasOwn(levels, severity) || levels[severity] < levels[level] || !Object.hasOwn(events, event)) return;
    if (queue.length >= maxQueue) { dropped = Math.min(2147483647, dropped + 1); return; }
    queue.push({ severity, line: lineFor(severity, event, fields) });
    if (scheduled === null) scheduled = setImmediate(drain);
  }
  function flush() { if (scheduled !== null) clearImmediate(scheduled); drain(true); }
  function close() { if (closed) return; flush(); closed = true; for (const [stream, handler] of streamFailures) stream.removeListener("error", handler); if (fd !== null) { try { fs.closeSync(fd); } catch { /* No secrets in errors. */ } fd = null; } }
  return { emit, flush, close };
}
let active = null;
function configure(options) { active?.close(); active = createLogger(options); return active; }
function emit(level, event, fields) { active?.emit(level, event, fields); }
function close() { active?.close(); active = null; }
function requestComponent(url = "") {
  const pathname = url.split("?")[0];
  for (const [prefix, name] of [["/api/auth/oidc/", "oidc"], ["/api/auth/users", "users"], ["/api/auth/", "auth"], ["/api/admin/", "users"], ["/api/shares", "shares"], ["/api/vault", "vault"], ["/api/fs", "files"], ["/api/bootstrap", "bootstrap"], ["/api/plugins", "plugins"], ["/api/proxy", "proxy"]])
    if (pathname.startsWith(prefix)) return name;
  return "other";
}
function httpMiddleware(req, res, next) {
  const requestId = randomUUID(), start = performance.now(), component = requestComponent(req.url);
  const pathname = (req.url || "").split("?")[0];
  const routeOperation = pathname === "/api/auth/users" && req.method === "POST" ? "users.create" : operations.get(pathname);
  req.ignisRequestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  let finished = false;
  const complete = () => {
    if (finished) return; finished = true;
    const status = res.writableFinished ? res.statusCode : 499;
    const operation = routeOperation === "shares.manage" && shareOperations.has(req.ignisLogOperation) ? req.ignisLogOperation : routeOperation;
    const expectedProbe = req.method === "GET" && (
      (operation === "auth.session" && status === 401 && req.ignisExpectedLogOutcome === "no-session") ||
      (operation === "vault.info" && status === 404 && req.ignisExpectedLogOutcome === "no-initial-vault")
    );
    const severity = expectedProbe || (operation === "shares.mounts" && status >= 200 && status < 300) ? "debug" : status >= 500 ? "error" : status >= 400 ? "warn" :
      operation === "oidc.callback" && req.ignisLogUsername ? "info" :
      ["auth", "oidc", "users", "shares", "vault"].includes(component) && req.method !== "GET" ? "info" : "debug";
    emit(severity, "http.request", { ...req.ignisLogChanges, requestId, component, operation, username: req.ignisLogUsername ?? req.auth?.user?.login, attemptedUsername: req.ignisLogAttemptedUsername, targetUsername: req.ignisLogTargetUsername, vaultName: req.ignisLogVaultName, previousVaultName: req.ignisLogPreviousVaultName, method: methods.has(req.method) ? req.method : "OTHER", status, durationMs: Math.round(performance.now() - start) });
  };
  res.once("finish", complete); res.once("close", complete); requestContext.run({ requestId }, next);
}
module.exports = { createLogger, readLogConfig, configure, emit, close, httpMiddleware };
