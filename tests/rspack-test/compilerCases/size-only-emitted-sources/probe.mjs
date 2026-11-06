import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFsFromVolume, Volume } from "memfs";
import { Compilation, rspack, sources } from "@rspack/core";

const context = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(context, "dist");
const sizeOnly = process.env.RSPACK_EMITTED_SOURCES === "size-only";
const text = "emitted text: é 😀\n";
const emittedHookCalls = new Map();
let probeWrites = 0;
let probeHookSeen = false;
let releaseMainWrite;
let savedMainInfo;

const compiler = rspack({
  mode: "development",
  context,
  entry: "./entry.js",
  devtool: "source-map",
  output: { path: output, filename: "main.js", compareBeforeEmit: true },
  optimization: { minimize: false },
  plugins: [
    {
      apply(compiler) {
        compiler.hooks.thisCompilation.tap("probe", (compilation) => {
          compilation.hooks.processAssets.tap(
            { name: "probe", stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
            () => compilation.emitAsset("probe.txt", new sources.RawSource(text)),
          );
        });
        compiler.hooks.assetEmitted.tap("probe", (filename, info) => {
          emittedHookCalls.set(filename, (emittedHookCalls.get(filename) || 0) + 1);
          if (filename === "main.js") savedMainInfo = info;
          if (filename === "main.js.map") assert.ok(info.source.size() > 0);
          if (filename !== "probe.txt") return;
          assert.equal(info.content.toString(), text);
          assert.equal(info.source.source(), text);
          assert.equal(info.compilation.getAsset(filename).source.source(), text);
          probeHookSeen = true;
          releaseMainWrite?.();
        });
        compiler.hooks.afterEmit.tap("probe", (compilation) => {
          assert.ok(savedMainInfo, "assetEmitted must provide info for main.js");
          assert.deepEqual(savedMainInfo.source.buffer(), outputFs.readFileSync(path.join(output, "main.js")));
          assert.deepEqual(savedMainInfo.content, outputFs.readFileSync(path.join(output, "main.js")));
          const source = compilation.getAsset("probe.txt").source;
          if (sizeOnly) {
            assert.ok(source instanceof sources.SizeOnlySource, "afterEmit must see a size-only asset");
          } else {
            assert.equal(source.source(), text);
          }
        });
      },
    },
  ],
});
const outputFs = createFsFromVolume(new Volume());
const writeFile = outputFs.writeFile.bind(outputFs);
outputFs.writeFile = (file, ...args) => {
  const name = String(file);
  if (name === path.join(output, "probe.txt")) probeWrites++;
  if (name !== path.join(output, "main.js") || emittedHookCalls.has("main.js")) {
    return writeFile(file, ...args);
  }
  const callback = args.pop();
  return writeFile(file, ...args, (error) => {
    if (error || probeHookSeen) return callback(error);
    const timer = setTimeout(() => callback(new Error("assetEmitted waited for all asset writes")), 5000);
    releaseMainWrite = () => {
      clearTimeout(timer);
      releaseMainWrite = undefined;
      callback(null);
    };
  });
};
compiler.outputFileSystem = outputFs;

function run() {
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) return reject(error);
      if (!stats || stats.hasErrors()) return reject(new Error(stats?.toString() || "missing stats"));
      resolve(stats);
    });
  });
}

function check(stats) {
  const compilation = stats.compilation;
  const asset = compilation.getAsset("probe.txt").source;
  const diskBytes = outputFs.readFileSync(path.join(output, "probe.txt"));
  assert.equal(diskBytes.toString(), text);
  assert.equal(asset.size(), Buffer.byteLength(text));
  if (sizeOnly) {
    const sourcesToCheck = [
      { name: "probe.txt", source: asset },
      { name: "probe.txt", source: compilation.assets["probe.txt"] },
      ...compilation.getAssets(),
    ];
    for (const { name, source } of sourcesToCheck) {
      const bytes = outputFs.readFileSync(path.join(output, name));
      assert.ok(source instanceof sources.SizeOnlySource, `${name} must be SizeOnlySource`);
      assert.equal(source.size(), bytes.length);
      assert.throws(() => source.source());
      assert.throws(() => source.buffer());
      assert.throws(() => source.map());
    }
  } else {
    assert.equal(asset.source(), text);
  }
  const json = stats.toJson({ assets: true });
  assert.equal(json.assets.find((item) => item.name === "probe.txt").size, diskBytes.length);
  return compilation.getAssets().map(({ name }) => [
    name,
    createHash("sha256").update(outputFs.readFileSync(path.join(output, name))).digest("hex"),
  ]).sort(([a], [b]) => a.localeCompare(b));
}

try {
  const first = check(await run());
  assert.equal(emittedHookCalls.get("main.js"), 1, "the first build emits main.js");
  const second = check(await run());
  assert.deepEqual(second, first, "unchanged re-emission must preserve files");
  assert.equal(emittedHookCalls.get("main.js"), 1, "the unchanged versioned asset must be skipped");
  assert.equal(probeWrites, 1, "compareBeforeEmit must skip the unchanged non-versioned asset");
  assert.ok(emittedHookCalls.get("probe.txt") > 0, "assetEmitted must receive the original content");
  console.log(`FILES=${JSON.stringify(first)}`);
} finally {
  await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
}
