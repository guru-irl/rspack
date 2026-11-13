import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const NAME = "native-watcher-context-nested-dirs";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(file, content, initial = false) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	if (initial) {
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(file, past, past);
	}
}
function exportsOf(bundle) {
	const module = { exports: {} };
	vm.runInNewContext(bundle.toString(), { module });
	return module.exports;
}

/** @type {import("@rspack/test-tools").TCompilerCaseConfig} */
export default {
	name: "nested-directories",
	description: "should watch ordinary nested contexts independently of file dependencies",
	options(context) {
		const source = context.getDist(NAME);
		for (const [file, content] of Object.entries({
			"index.js": 'const c = require.context("./ctx", true, /\\.js$/); module.exports = c.keys().sort().map(k => [k, c(k)]);',
			"ctx/existing/seed.txt": "seed",
			"plugin/nested/seed.txt": "before",
			"plugin/kept/deep/file.txt": "kept"
		})) write(path.join(source, file), content, true);
		const realSource = fs.realpathSync(source);
		context.setValue("source", realSource);
		context.setValue("outer", true);
		context.setValue("nested", false);
		return {
			context: realSource, mode: "development", devtool: false, target: "node",
			entry: "./index.js",
			output: { path: path.join(realSource, "dist"), filename: "bundle.js", library: { type: "commonjs2" } },
			experiments: { nativeWatcher: true },
			plugins: [compiler => compiler.hooks.thisCompilation.tap(NAME, compilation => {
				if (context.getValue("outer")) {
					compilation.contextDependencies.add(path.join(realSource, "plugin"));
					compilation.missingDependencies.add(path.join(realSource, "plugin/missing/deep/file.txt"));
				}
				if (context.getValue("nested")) {
					compilation.contextDependencies.add(path.join(realSource, "plugin/nested"));
					compilation.fileDependencies.add(path.join(realSource, "plugin/nested/seed.txt"));
				}
				compilation.contextDependencies.add(path.join(realSource, "plugin/kept"));
				compilation.fileDependencies.add(path.join(realSource, "plugin/kept/deep/file.txt"));
			})]
		};
	},
	async build(context, compiler) {
		let pending, timer, failure, builds = 0;
		const next = () => new Promise((resolve, reject) => {
			pending = (error, stats) => {
				clearTimeout(timer);
				pending = undefined;
				error ? reject(error) : resolve(stats);
			};
			timer = setTimeout(() => reject(new Error("Nested context did not rebuild")), 4_000);
		});
		const first = next();
		const watching = compiler.watch({ aggregateTimeout: 50, followSymlinks: true }, (error, stats) => {
			builds++;
			failure = error || (stats.hasErrors() ? new Error(stats.toString()) : undefined);
			pending?.(failure, stats);
		});
		const step = async change => {
			let before;
			do { before = builds; await wait(300); } while (builds !== before);
			if (failure) throw failure;
			const done = next();
			change();
			return done;
		};
		const source = context.getValue("source");
		try {
			await first;
			const existing = await step(() => write(path.join(source, "ctx/existing/new.js"), "module.exports = 1;"));
			expect(exportsOf(existing.compilation.assets["bundle.js"].source())).toEqual([["./existing/new.js", 1]]);
			const created = await step(() => write(path.join(source, "ctx/a/b/c/race.js"), "module.exports = 2;"));
			expect(exportsOf(created.compilation.assets["bundle.js"].source())).toEqual([
				["./a/b/c/race.js", 2], ["./existing/new.js", 1]
			]);
			await step(() => write(path.join(source, "plugin/nested/new.txt"), "new"));
			await step(() => write(path.join(source, "plugin/nested/seed.txt"), "after"));
			context.setValue("nested", true);
			await step(() => watching.invalidate());
			await step(() => write(path.join(source, "plugin/nested/later/deep/file.txt"), "later"));
			await step(() => write(path.join(source, "plugin/nested/later/deep/file.txt"), "later edit"));
			context.setValue("nested", false);
			context.setValue("outer", false);
			await step(() => watching.invalidate());
			await wait(300);
			const before = builds;
			write(path.join(source, "plugin/nested/unused.txt"), "unused");
			await wait(700);
			expect(builds).toEqual(before);
			await step(() => write(path.join(source, "plugin/kept/deep/file.txt"), "changed"));
		} finally {
			clearTimeout(timer);
			await new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));
		}
	},
	async check({ files }) {
		const bundle = Object.entries(files).find(([file]) => path.basename(file) === "bundle.js")[1];
		expect(exportsOf(bundle)).toEqual([
			["./a/b/c/race.js", 2], ["./existing/new.js", 1]
		]);
	}
};
