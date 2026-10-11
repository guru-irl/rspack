import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRsbuild, rspack } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';
const out = process.env.RESULT_DIR;
fs.mkdirSync(out, { recursive: true });
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const target = (id) =>
  /getServerFnById|tanstack-start-server-fn-resolver|start-server.*resolver/.test(
    id,
  );
const records = [];
let waiting;
let editStart;
let edited = 0;
let finished = 0;

const log = (item) => {
  fs.appendFileSync(
    path.join(out, 'events.jsonl'),
    JSON.stringify(item) + '\n',
  );
};
const dependencies = (block, compilation) => ({
  dependencies: Array.from(block.dependencies ?? [], (d) => {
    const c = compilation.moduleGraph.getConnection(d);
    return {
      type: d.type,
      category: d.category,
      request: d.request,
      loc: d.loc,
      module: c?.module?.identifier(),
      active: c?.getActiveState(undefined),
    };
  }),
  blocks: Array.from(block.blocks ?? [], (b) => dependencies(b, compilation)),
});
const probe = {
  name: 'public-topology-probe',
  setup(api) {
    api.modifyRspackConfig((config, { environment }) => {
      config.stats = {
        all: false,
        errors: true,
        warnings: true,
        timings: true,
        logging: 'verbose',
        loggingDebug: [/rspack\./],
      };
      config.plugins.push({
        apply(compiler) {
          const name = environment.name;
          let index = 0;
          compiler.hooks.watchRun.tap('PublicTopologyProbe', (c) =>
            log({
              kind: 'watchRun',
              name,
              modified: [...(c.modifiedFiles ?? [])],
              removed: [...(c.removedFiles ?? [])],
            }),
          );
          compiler.hooks.thisCompilation.tap(
            'PublicTopologyProbe',
            (compilation) => {
              const rebuilt = [];
              const rebuild = compilation.rebuildModule.bind(compilation);
              compilation.rebuildModule = (module, callback) => {
                const id = module.identifier();
                log({
                  kind: 'rebuildModule',
                  name,
                  index,
                  id,
                  stack: new Error().stack,
                });
                return rebuild(module, callback);
              };
              compilation.hooks.buildModule.tap(
                'PublicTopologyProbe',
                (module) => {
                  if (target(module.identifier()))
                    rebuilt.push(module.identifier());
                },
              );
              rspack.NormalModule.getCompilationHooks(compilation).loader.tap(
                'PublicTopologyProbe',
                (ctx, module) => {
                  if (!target(module.identifier())) return;
                  log({
                    kind: 'loader',
                    name,
                    index,
                    id: module.identifier(),
                    loaders: ctx.loaders.map((l) => l.path),
                  });
                },
              );
              compilation.hooks.optimizeModules.tap({ name: 'PublicTopologyProbe', stage: 10000 }, () => {
                const snapshot = [...compilation.modules].filter(m => target(m.identifier())).map(m => ({
                  id: m.identifier(), ...dependencies(m, compilation),
                  incoming: compilation.moduleGraph.getIncomingConnections(m).map(c => ({ origin: c.originModule?.identifier(), active: c.getActiveState(undefined) })),
                  outgoing: compilation.moduleGraph.getOutgoingConnectionsInOrder(m).map(c => ({ module: c.module?.identifier(), active: c.getActiveState(undefined), type: c.dependency?.type })),
                }));
                fs.writeFileSync(path.join(out, `${name}-${index}-optimized.json`), JSON.stringify(snapshot, null, 2));
              });
              compilation.hooks.afterSeal.tapPromise('PublicTopologyProbe', async () => {
                const snapshot = [...compilation.modules].filter(m => target(m.identifier())).map(m => ({
                  id: m.identifier(),
                  chunks: [...compilation.chunkGraph.getModuleChunksIterable(m)].map(c => c.name ?? c.id),
                  ...dependencies(m, compilation),
                  incoming: compilation.moduleGraph.getIncomingConnections(m).map(c => ({ origin: c.originModule?.identifier(), active: c.getActiveState(undefined) })),
                  outgoing: compilation.moduleGraph.getOutgoingConnectionsInOrder(m).map(c => ({ module: c.module?.identifier(), active: c.getActiveState(undefined), type: c.dependency?.type })),
                }));
                fs.writeFileSync(path.join(out, `${name}-${index}-sealed.json`), JSON.stringify(snapshot, null, 2));
              });
              compilation.hooks.finishModules.tap(
                { name: 'PublicTopologyProbe', stage: 10000 },
                (modules) => {
                  const snapshot = Array.from(modules)
                    .filter((m) => target(m.identifier()))
                    .map((m) => {
                      const source =
                        m.originalSource()?.source().toString() ?? '';
                      return {
                        id: m.identifier(),
                        source,
                        hash: hash(source),
                        ...dependencies(m, compilation),
                      };
                    });
                  fs.writeFileSync(
                    path.join(out, `${name}-${index}-modules.json`),
                    JSON.stringify({ rebuilt, snapshot }, null, 2),
                  );
                },
              );
            },
          );
          compiler.hooks.done.tap('PublicTopologyProbe', (stats) => {
            const data = stats.toJson({
              all: false,
              errors: true,
              warnings: true,
              timings: true,
              logging: 'verbose',
              loggingDebug: [/rspack\./],
            });
            const record = {
              name,
              index: index++,
              edited,
              ms: stats.endTime - stats.startTime,
              editWallMs: editStart ? performance.now() - editStart : null,
              memory: process.memoryUsage(),
              logging: data.logging,
              errors: data.errors,
              warnings: data.warnings,
            };
            records.push(record);
            fs.writeFileSync(
              path.join(out, 'builds.json'),
              JSON.stringify(records, null, 2),
            );
            console.log(
              'BUILD',
              name,
              record.index,
              record.ms,
              JSON.stringify(data.logging),
            );
            if (stats.hasErrors()) {
              console.error(JSON.stringify(data.errors));
              process.exitCode = 1;
            }
            if (/server|ssr/.test(name)) {
              finished++;
              waiting?.resolve(record);
              waiting = undefined;
            }
          });
        },
      });
    });
  },
};
const rsbuild = await createRsbuild({
  config: {
    plugins: [pluginReact(), tanstackStart(), probe],
    performance: { buildCache: false },
    server: { port: 3100, strictPort: true, open: false },
  },
});
let server;
const waitBuild = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting = undefined;
      reject(new Error('SSR compilation timeout'));
    }, 90000);
    waiting = {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
    };
  });
try {
  const initial = waitBuild();
  server = await rsbuild.startDevServer();
  await initial;
  if (process.exitCode) throw new Error('Initial compilation failed');
  // Server response checks force the client and SSR graph to be exercised.
  const response = await fetch('http://localhost:3100/');
  const html = await response.text();
  fs.writeFileSync(
    path.join(out, 'initial-response.json'),
    JSON.stringify({
      status: response.status,
      leaf: html.includes('Public leaf baseline'),
      alpha: html.includes('alpha-public'),
      beta: html.includes('beta-public'),
    }),
  );
  const leaf = path.resolve('src/Leaf.tsx');
  const original = fs.readFileSync(leaf, 'utf8');
  for (let i = 1; i <= 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const next = waitBuild();
    edited = i;
    editStart = performance.now();
    fs.writeFileSync(
      leaf,
      i % 2
        ? original.replace('Public leaf baseline', 'Public leaf changed')
        : original,
    );
    const r = await next;
    if (r.errors?.length) throw new Error('Rebuild failed');
    const response = await fetch('http://localhost:3100/');
    const html = await response.text();
    log({
      kind: 'response',
      edit: i,
      status: response.status,
      expectedLeaf: html.includes(
        i % 2 ? 'Public leaf changed' : 'Public leaf baseline',
      ),
      alpha: html.includes('alpha-public'),
      beta: html.includes('beta-public'),
    });
  }
} finally {
  if (server?.close) await server.close();
  else if (server?.server?.close) await server.server.close();
  fs.writeFileSync(
    path.join(out, 'summary.json'),
    JSON.stringify({
      finished,
      edited,
      versions: { rspack: rspack.rspackVersion },
      variant: process.env.VARIANT,
    }),
  );
}
process.exit(process.exitCode ?? 0);
