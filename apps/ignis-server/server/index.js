const logging = require('@ignis/server-core/src/logger');
const {createApplication} = require('./app/create-application');

function logStartupFailure(error) {
  const event = error?.code === 'SCHEMA_INCOMPATIBLE'
    ? 'server.schema_incompatible'
    : require('./features/identity/adapters/oidc/startup-error.js').startupLogEvent(error);
  logging.emit('error',event);
}

async function main() {
  logging.configure({dataRoot:process.env.DATA_ROOT || require('node:path').join(__dirname,'../../..','data'),...logging.readLogConfig()});
  const application = createApplication();
  let stopping;
  const stop = () => stopping ||= (async () => {
    logging.emit('info','server.stopping');
    const timeout = setTimeout(() => {
      logging.emit('error','server.shutdown_timeout');logging.close();process.exit(1);
    },10000);
    try {await application.stop();logging.emit('info','server.stopped');}
    catch {logging.emit('error','server.fatal');process.exitCode=1;}
    finally {clearTimeout(timeout);logging.close();}
  })();
  const signal = () => {void stop();};
  process.on('SIGTERM',signal);process.on('SIGINT',signal);
  const fatal = () => {logging.emit('error','server.fatal');process.exitCode=1;void stop();};
  process.on('uncaughtException',fatal);process.on('unhandledRejection',fatal);
  try {
    const address = await application.start();
    if (!stopping) logging.emit('info','server.started',{version:require('./version').getSemver(),obsidianVersion:require('./config').obsidianVersion,port:address.port});
  } catch (error) {
    logStartupFailure(error);process.exitCode=1;await stop();
  }
}

main().catch(error => {
  const configured = (() => {try {logging.readLogConfig();return true;}catch {return false;}})();
  if (!configured) process.stderr.write(JSON.stringify({time:new Date().toISOString(),level:'error',event:'logging.invalid_config',message:'Invalid logging configuration; check IGNIS_LOG_FORMAT, IGNIS_LOG_LEVEL, IGNIS_LOG_FILE_ENABLED, IGNIS_LOG_MAX_SIZE_MIB and IGNIS_LOG_MAX_FILES.'})+'\n');
  else logStartupFailure(error);
  logging.close();process.exitCode=1;
});
