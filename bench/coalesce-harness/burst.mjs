import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const [arm, scenario, runText] = process.argv.slice(2);
assert(["main", "pr"].includes(arm));
assert(["single", "multi"].includes(scenario));
const base = path.resolve(".bench-coalesce");
const platform = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform];
const artifact = path.join(base, "bindings", `coalesce-binding-${platform}-${arm}`);
const nodeFile = path.join(artifact, "binding.node");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const manifest = JSON.parse(fs.readFileSync(path.join(artifact, "identity.json"), "utf8"));
const expected = manifest.sha256;
const sourceSha = { main: "e04e75e8a56d1a1d0a920e34e166dd91617b118f", pr: "48af3db18a9aafd3077cf963fd7647e68e078b65" }[arm];
assert.equal(manifest.source, sourceSha);
assert.equal(manifest.profile, "release");
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.platform === "darwin" ? "arm64" : "x64");
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = nodeFile;
const require = createRequire(path.resolve("source/package.json"));
const binding = require(path.resolve("source/crates/node_binding/binding.js"));
const identity = require(path.join(import.meta.dirname, "loaded-binding-identity.cjs")).read(nodeFile, expected);
const mapped = identity.mapped;
const coreIndex = path.join(artifact, "core/dist/index.js");
assert.equal(digest(coreIndex), manifest.coreIndexHash);
const { rspack } = await import(pathToFileURL(coreIndex).href);
const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "fixtures", `${scenario}-${arm}-${runText}-`)));
const targetNames = scenario === "multi" ? ["blocker", "target"] : ["target"];
const source = Object.fromEntries(targetNames.map(name => [name, `${root}/${name}/src`]));
for (const name of targetNames) {
 fs.mkdirSync(source[name], { recursive: true });
 for (const file of ["a", "b", "c"]) fs.writeFileSync(`${source[name]}/${file}.js`, `module.exports = "${file}-old";`);
 fs.writeFileSync(`${source[name]}/index.js`, "module.exports = [require(\"./a\"), require(\"./b\"), require(\"./c\")];");
 const past = new Date(Date.now() - 10_000);
 for (const file of ["index", "a", "b", "c"]) fs.utimesSync(`${source[name]}/${file}.js`, past, past);
}
const counters = Object.fromEntries(targetNames.map(name => [name, { deliveries: 0, raw: 0, invalid: 0, compilations: 0, done: 0, watchRun: 0, watchCallbacks: 0 }]));
let recording = false, unblock = Infinity, blockStarted = 0, lastActivity = Date.now(), failure, waiting, readyBlock = false;
const events = [], instanceLabels = new WeakMap(), watches = Object.fromEntries(targetNames.map(name => [name, 0]));
const activity = (kind, name, extra = {}) => {
 lastActivity = Date.now();
 if (!recording) return;
 events.push({ t: lastActivity, kind, name, ...extra });
 if (kind === "compilations" && lastActivity < unblock) throw new Error("Compilation counted before unblock");
 if (kind in counters[name]) counters[name][kind]++;
};
const original = binding.NativeWatcher.prototype.watch;
Object.defineProperty(binding.NativeWatcher.prototype, "watch", { ...Object.getOwnPropertyDescriptor(binding.NativeWatcher.prototype, "watch"), value: function(...args) {
 let name = instanceLabels.get(this);
 if (!name) {
  const paths = args.slice(0, 3).flat(2);
  name = targetNames.find(label => paths.some(p => typeof p === "string" && path.resolve(p).startsWith(path.join(root, label) + path.sep)));
  assert(name, `Unidentified watcher paths ${JSON.stringify(paths)}`);
  instanceLabels.set(this, name);
 }
 watches[name]++;
 const aggregate = args[4], raw = args[5];
 args[4] = function(error, result) {
  activity("deliveries", name, { changed: result?.changedFiles, removed: result?.removedFiles, error: error?.message });
  if (error) failure = error;
  return aggregate.apply(this, arguments);
 };
 args[5] = function(event) { activity("raw", name, { event }); return raw.apply(this, arguments); };
 return original.apply(this, args);
} });
const configs = targetNames.map(name => ({
 name, context: source[name], mode: "development", devtool: false, target: "node", entry: "./index.js",
 output: { path: `${root}/${name}/dist`, filename: "bundle.cjs", library: { type: "commonjs2" } },
 experiments: { nativeWatcher: true },
}));
const compiler = rspack(scenario === "multi" ? configs : configs[0]);
const compilers = compiler.compilers || [compiler];
const block = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const burst = () => {
 assert(!recording);
 recording = true; blockStarted = Date.now(); lastActivity = blockStarted;
 events.push({ t: blockStarted, kind: "block-start", name: "target" });
 for (const [index, name] of ["a", "b", "c"].entries()) {
  fs.writeFileSync(`${source.target}/${name}.js`, `module.exports = "${name}-new";`);
  events.push({ t: Date.now(), kind: "write", name: "target", file: `${name}.js` });
  block(index === 2 ? 1000 : 500);
 }
 unblock = Date.now(); lastActivity = unblock;
 events.push({ t: unblock, kind: "unblock", name: "target" });
};
let result;
const initial = Object.fromEntries(targetNames.map(name => [name, 0]));
for (const child of compilers) {
 const name = child.name;
 child.hooks.invalid.tap("BurstCount", file => activity("invalid", name, { file }));
 child.hooks.watchRun.tap("BurstCount", () => {
  if (name === "blocker" && readyBlock) { readyBlock = false; burst(); }
  activity("watchRun", name, { modified: [...(child.modifiedFiles || [])] });
 });
 child.hooks.afterCompile.tap("BurstCount", compilation => {
  if (compilation.errors.length) failure = new Error(compilation.errors.map(e => e.message).join("\n"));
  activity("compilations", name);
 });
 child.hooks.done.tap("BurstCount", stats => {
  if (stats.hasErrors()) failure = new Error(stats.toString());
  initial[name]++; activity("done", name);
 });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label, timeout = 20_000) => {
 const end = Date.now() + timeout;
 while (!predicate()) {
  if (failure) throw failure;
  if (Date.now() > end) throw new Error(`Timeout: ${label}`);
  await delay(25);
 }
 if (failure) throw failure;
};
try {
 waiting = compiler.watch(scenario === "multi" ? configs.map(() => ({ aggregateTimeout: 200 })) : { aggregateTimeout: 200 }, (error, stats) => {
  if (error || stats?.hasErrors()) { failure = error || new Error(stats.toString()); return; }
  lastActivity = Date.now();
  if (recording) {
   const names = stats.stats ? stats.stats.map(s => s.compilation.name) : ["target"];
   events.push({ t: lastActivity, kind: "watch-callback", names });
   for (const name of names) if (name in counters) counters[name].watchCallbacks++;
  }
 });
 await until(() => targetNames.every(name => initial[name] >= 1 && watches[name] >= 1) && Date.now() - lastActivity >= 3000 && compilers.every(c => !c.watching.running), "initial watcher quiet");
 if (scenario === "single") burst();
 else {
  readyBlock = true;
  fs.writeFileSync(`${source.blocker}/a.js`, "module.exports = \"blocker-new\";");
  await until(() => Number.isFinite(unblock), "blocker rebuild and target burst");
 }
 await until(() => Date.now() - lastActivity >= 3000 && compilers.every(c => !c.watching.running), "3 seconds of quiet", 30_000);
 const quietStart = lastActivity;
 const rssSamples = [];
 for (let sample = 0; sample < 5; sample++) {
  await delay(1000);
  assert.equal(lastActivity, quietStart, "activity resumed during steady RSS samples");
  assert(compilers.every(c => !c.watching.running), "compiler running during steady RSS samples");
  if (failure) throw failure;
  rssSamples.push({ t: Date.now(), quietMs: Date.now() - lastActivity, bytes: process.memoryUsage.rss() });
 }
 assert(counters.target.deliveries > 0, "native watcher instrumentation did not observe delivery");
 const bundle = `${root}/target/dist/bundle.cjs`;
 delete require.cache[bundle];
 const values = require(bundle);
 assert.deepEqual(values, ["a-new", "b-new", "c-new"], "final target bundle lost changes");
 if (scenario === "multi") {
  const other = `${root}/blocker/dist/bundle.cjs`; delete require.cache[other];
  assert.deepEqual(require(other), ["blocker-new", "b-old", "c-old"]);
 }
 const totals = Object.fromEntries(Object.keys(counters.target).map(key => [key, Object.values(counters).reduce((sum, item) => sum + item[key], 0)]));
 recording = false;
 let peakBytes = process.resourceUsage().maxRSS * 1024;
 let peakSource = "process.resourceUsage.maxRSS";
 if (process.platform === "win32") {
  const peak = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).PeakWorkingSet64`], { encoding: "utf8" });
  assert.equal(peak.status, 0, peak.stderr);
  peakBytes = Number(peak.stdout.trim());
  peakSource = "Get-Process.PeakWorkingSet64";
 }
 assert(Number.isFinite(peakBytes) && peakBytes > 0, "missing process peak RSS");
 const osPeakBytes = peakBytes;
 peakBytes = Math.max(peakBytes, ...rssSamples.map(sample => sample.bytes));
 const steadyBytes = rssSamples.map(sample => sample.bytes).sort((a, b) => a - b)[2];
 result = { arm, scenario, run: Number(runText), sourceSha, platform, arch: process.arch, nodeVersion: process.version, profile: manifest.profile, nodeHash: expected, mapped, identityReport: identity.report, coreIndexHash: digest(coreIndex), aggregateTimeout: 200, blockMs: unblock - blockStarted, quietMs: Date.now() - lastActivity, counters, totals, values, correct: true, correctBundles: targetNames.length, root, events, peakBytes, osPeakBytes, peakSource, steadyBytes, rssSamples }; 
} finally {
 if (waiting) await new Promise((resolve, reject) => waiting.close(error => error ? reject(error) : resolve()));
 await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
 Object.defineProperty(binding.NativeWatcher.prototype, "watch", { ...Object.getOwnPropertyDescriptor(binding.NativeWatcher.prototype, "watch"), value: original });
}

fs.writeFileSync(path.join(base, "results", `${scenario}-${arm}-${runText}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, events: undefined }));
