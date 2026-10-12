import assert from 'node:assert/strict';
export function instrumentRestart(source) {
  const prefix = `import { Server as DiagnosticServer } from 'node:net';
import diagnosticHttp from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
`;
  const observer = `
Error.stackTraceLimit = 50;
const restartTrace = [];
const diagnosticServerIds = new WeakMap();
let diagnosticNextId = 0;
const diagnosticRecord = (kind, extra = {}) => {
  restartTrace.push({kind, step, pid: process.pid, t: performance.now(), wallMs: Date.now(), ...extra});
  fs.writeFileSync(path.join(out, 'restart-trace.json'), JSON.stringify(restartTrace, null, 2));
};
const diagnosticId = server => {
  if (!diagnosticServerIds.has(server)) {
    diagnosticServerIds.set(server, ++diagnosticNextId);
    server.on('listening', () => diagnosticRecord('server-listening', {id: diagnosticServerIds.get(server), address: server.address()}));
    server.on('close', () => diagnosticRecord('server-close-event', {id: diagnosticServerIds.get(server), listening: server.listening}));
  }
  return diagnosticServerIds.get(server);
};
const diagnosticCreate = diagnosticHttp.createServer;
diagnosticHttp.createServer = function (...args) {
  const server = diagnosticCreate.apply(this, args);
  diagnosticRecord('server-create', {id: diagnosticId(server), stack: new Error('create caller').stack});
  return server;
};
syncBuiltinESMExports();
const diagnosticListen = DiagnosticServer.prototype.listen;
DiagnosticServer.prototype.listen = function (...args) {
  diagnosticRecord('server-listen-call', {id: diagnosticId(this), listening: this.listening, stack: new Error('listen caller').stack});
  return diagnosticListen.apply(this, args);
};
const diagnosticClose = DiagnosticServer.prototype.close;
DiagnosticServer.prototype.close = function (...args) {
  const id = diagnosticId(this);
  diagnosticRecord('server-close-call', {id, listening: this.listening, stack: new Error('close caller').stack});
  const i = args.findIndex(value => typeof value === 'function');
  if (i >= 0) {
    const callback = args[i];
    args[i] = function (error, ...rest) {
      diagnosticRecord('server-close-callback', {id, listening: this?.listening, error: error?.code, stack: error?.stack});
      return callback.call(this, error, ...rest);
    };
  }
  return diagnosticClose.apply(this, args);
};
`;
  source = source.replace("const startPlugin=tanstackStart();", observer + "\nconst startPlugin=tanstackStart();");
  const registration = '      compilers.set(environment.name,compiler);';
  assert.ok(source.includes(registration));
  source = source.replace(registration, registration + `
      diagnosticRecord('compiler-create', {name: environment.name});
      compiler.hooks.watchClose.tap('RestartLifecycleObserver', () => diagnosticRecord('watcher-close-hook', {name: environment.name}));
      compiler.hooks.shutdown.tap('RestartLifecycleObserver', () => diagnosticRecord('compiler-shutdown-hook', {name: environment.name}));
      const closeCompiler = compiler.close;
      compiler.close = function (...args) {
        diagnosticRecord('compiler-close-call', {name: environment.name, stack: new Error('compiler close caller').stack});
        return closeCompiler.apply(this, args);
      };
      const startWatch = compiler.watch;
      compiler.watch = function (...args) {
        const watcher = startWatch.apply(this, args);
        if (watcher) {
          const closeWatcher = watcher.close;
          watcher.close = function (...closeArgs) {
            diagnosticRecord('watcher-close-call', {name: environment.name, stack: new Error('watcher close caller').stack});
            return closeWatcher.apply(this, closeArgs);
          };
        }
        return watcher;
      };
`);
  source = source.replace('    closeRequested=true;\n    await Promise.race', "    diagnosticRecord('harness-restart-close-begin', {trigger: coldCloseTrigger});\n    closeRequested=true;\n    await Promise.race");
  source = source.replace('    server=undefined;\n    if(scenario', "    diagnosticRecord('harness-restart-close-resolved');\n    server=undefined;\n    if(scenario");
  source = source.replace('      server=await rsbuild.startDevServer();await waitIdle(2);', "      diagnosticRecord('harness-restart-create-begin');\n      server=await rsbuild.startDevServer();diagnosticRecord('harness-restart-create-resolved');await waitIdle(2);");
  source = source.replace("await sample(base,'Public leaf baseline');await restartShutdown.final(()=>server.close ? server.close() : server.server.close());server=undefined;", "await sample(base,'Public leaf baseline');diagnosticRecord('harness-final-restart-shutdown-begin');await restartShutdown.final(()=>server.close ? server.close() : server.server.close());diagnosticRecord('harness-final-restart-shutdown-resolved');server=undefined;");
  source = source.replace('   console.error(error); process.exitCode=1;', "   diagnosticRecord('harness-catch', {error: error.code, stack: error.stack});console.error(error); process.exitCode=1;");
  source = source.replace('   clearInterval(timer);\n   if(pageServer)', "   diagnosticRecord('harness-finally-begin');\n   clearInterval(timer);\n   if(pageServer)");
  source = source.replace("process.exit(process.exitCode || 0);", "diagnosticRecord('harness-process-exit', {exitCode: process.exitCode || 0});\nprocess.exit(process.exitCode || 0);");
  return prefix + source;
}
