const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const tree = process.argv[2];
const variant = process.argv[3];
const fixture = process.env.FILENAME_FIXTURE;
const footprint = require(process.env.FILENAME_FOOTPRINT);
const v8 = require('node:v8');
const memorySnapshot = () => ({...footprint.snapshot(), usage:process.memoryUsage(), heap:v8.getHeapStatistics(), spaces:v8.getHeapSpaceStatistics()});
const rspack = require(path.join(tree, 'packages/rspack/dist')).rspack;
const clocks = new Float64Array(250000);
const fields = new Uint8Array(250000);
const stages = new Uint8Array(250000);
let used = 0;
const traces = [];
const rawTurns = [];
// Non-shipping adapter instrumentation may use this recorder for exact batch crossings.
globalThis[Symbol.for('filename-fn-bench')] = (field, count, stage) => rawTurns.push([performance.timeOrigin + performance.now(), field, count, stage]);
const keys = ['filename', 'chunkFilename', 'cssFilename', 'cssChunkFilename'];
function filename(field, ext) {
 if (variant === 'string') return `[name].${ext}`;
 return function(data, info) {
  if (used === clocks.length) throw new Error('filename timestamp buffer overflow');
  clocks[used] = performance.timeOrigin + performance.now(); fields[used] = field; stages[used++] = Number(data.runtime !== undefined);
  if (process.env.FILENAME_TRACE === '1') traces.push({field: keys[field], receiver: this === undefined ? 'undefined' : this === globalThis ? 'global' : typeof this, argumentCount: arguments.length, path: {filename: data.filename, hash: data.hash, contentHash: data.contentHash, runtime: data.runtime, url: data.url, id: data.id, chunk: data.chunk && {id: data.chunk.id, name: data.chunk.name, hash: data.chunk.hash}}, info: info && {...info}});
  if (variant === 'prod') return `${String(data.chunk?.name ?? data.chunk?.id).toLowerCase()}.[contenthash:8].${ext}`;
  return `[name].${ext}`;
 };
}
(async () => {
 const usage0 = process.resourceUsage();
 const start = performance.now();
 let compiler = rspack({context: fixture, mode: 'development', devtool: false, cache: false,
  entry: Object.fromEntries(Array.from({length: 10}, (_, i) => [`Entry-${i}`, `./entry-${i}.js`])),
  experiments: {css: true, outputModule: true},
  module: {parser: {javascript: {url: 'new-url-relative'}}, rules: [{test: /\.css$/, type: 'css'}, {test: /\.svg$/, type: 'asset/resource'}]},
  output: {module: true, path: path.join(fixture, 'dist'), clean: true, filename: filename(0,'js'), chunkFilename: filename(1,'js'), cssFilename: filename(2,'css'), cssChunkFilename: filename(3,'css'), publicPath: ''},
  optimization: {minimize: false, splitChunks: false, runtimeChunk: {name: e => `runtime-${e.name}`}},
  stats: {all: false, logging: 'verbose', loggingDebug: ['rspack.Compilation']}
 });
 let stats = await new Promise((resolve,reject) => compiler.run((err,stats) => err ? reject(err) : resolve(stats)));
 const wallMs = performance.now() - start;
 const usage = process.resourceUsage();
 const endMemory = memorySnapshot();
 
 if (global.gc) { global.gc(); global.gc(); }
 const postGcMemory = memorySnapshot();
 if (stats.hasErrors()) throw new Error(stats.toString({all:false,errors:true,errorDetails:true}));
 const logging = stats.toJson({all:false,logging:'verbose',loggingDebug:['rspack.Compilation']}).logging;
 const topology = {chunks: stats.compilation.chunks.size, runtimes: Array.from(stats.compilation.chunks).filter(c=>c.hasRuntime()).length};
 await new Promise((resolve,reject) => compiler.close(e => e ? reject(e) : resolve()));
 compiler = null; stats = null;
 if (global.gc) global.gc();
 const closedMemory = memorySnapshot();
 console.log(JSON.stringify({type:'metrics',variant,wallMs,userCpuMs:(usage.userCPUTime-usage0.userCPUTime)/1000,systemCpuMs:(usage.systemCPUTime-usage0.systemCPUTime)/1000,voluntarySwitches:usage.voluntaryContextSwitches-usage0.voluntaryContextSwitches,involuntarySwitches:usage.involuntaryContextSwitches-usage0.involuntaryContextSwitches,endMemory,postGcMemory,closedMemory,topology,logging,calls:Array.from({length:used},(_,i)=>[clocks[i],fields[i],stages[i]]),rawTurns,traces}));
 // Output scanning is excluded from build wall/CPU/end memory. The process peak below is sampled only until metrics line.
 const files = fs.readdirSync(path.join(fixture,'dist')).sort();
 const manifest = files.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture,'dist',name),'utf8').replace(/(__webpack_require__\.h = \(\) => \(")[^"]*("\))/g,'$1<fullhash>$2')).digest('hex')]);
 console.log(JSON.stringify({type:'manifest',manifest}));
})().catch(err => {console.error(err.stack);process.exitCode=1;});
