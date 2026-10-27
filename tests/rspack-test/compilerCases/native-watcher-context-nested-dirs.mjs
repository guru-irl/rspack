import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const CASE_NAME = "native-watcher-context-nested-dirs";
const DEADLINE = 4_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeBeforeStart(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	const past = new Date(Date.now() - 10_000);
	fs.utimesSync(file, past, past);
}

/** @type {import("@rspack/test-tools").TCompilerCaseConfig} */
export default {
	name: "nested-directories",
	description: "should watch nested context directories recursively",
	options(context) {
		const root = context.getDist(CASE_NAME);
		fs.rmSync(root, { recursive: true, force: true });
		const source = path.join(root, "src");
		const pluginDirectory = path.join(source, "plugin");
		writeBeforeStart(
			path.join(source, "index.js"),
			'module.exports = require.context("./ctx", true, /\\.js$/).keys().sort();\n'
		);
		writeBeforeStart(
			path.join(source, "ctx", "existing", "seed.txt"),
			"seed\n"
		);
		writeBeforeStart(
			path.join(pluginDirectory, "nested", "seed.txt"),
			"before\n"
		);
		writeBeforeStart(
			path.join(pluginDirectory, "kept", "deep", "file.txt"),
			"kept\n"
		);
		writeBeforeStart(path.join(source, "other", "file.txt"), "watched\n");
		fs.mkdirSync(path.join(source, "ctx", "real", "sub"), { recursive: true });
		fs.symlinkSync(
			process.platform === "win32" ? path.join(source, "ctx", "real") : "real",
			path.join(source, "ctx", "link"),
			"junction"
		);
		context.setValue("keepOuterContext", true);
		context.setValue("source", source);
		context.setValue("output", path.join(root, "dist"));
		return {
			context: source,
			mode: "development",
			devtool: false,
			target: "node",
			resolve: { symlinks: false },
			entry: "./index.js",
			output: {
				path: path.join(root, "dist"),
				filename: "bundle.js",
				library: { type: "commonjs2" }
			},
			experiments: { nativeWatcher: true },
			plugins: [
				(compiler) => {
					compiler.hooks.thisCompilation.tap(CASE_NAME, (compilation) => {
						if (context.getValue("keepOuterContext")) {
							compilation.contextDependencies.add(pluginDirectory);
						}
						compilation.contextDependencies.add(
							path.join(pluginDirectory, "kept")
						);
						compilation.fileDependencies.add(
							path.join(pluginDirectory, "kept", "deep", "file.txt")
						);
						compilation.fileDependencies.add(path.join(source, "other", "file.txt"));
					});
				}
			]
		};
	},
	async build(context, compiler) {
		let watching;
		let pending;
		let failure;
		let timer;
		let builds = 0;
		let doneAt;
		compiler.hooks.done.tap(CASE_NAME, () => {
			doneAt = Date.now();
		});
		const results = [];
		const source = context.getValue("source");
		const nextBuild = () =>
			new Promise((resolve, reject) => {
				pending = { resolve, reject, since: Date.now() };
				timer = setTimeout(() => {
					pending = undefined;
					reject(new Error("Timed out waiting for a context rebuild"));
				}, DEADLINE);
			});
		const step = async (name, change) => {
			let previous;
			do {
				previous = builds;
				await wait(500);
			} while (builds !== previous);
			if (failure) throw failure;
			const build = nextBuild();
			const start = Date.now();
			change();
			try {
				const completedAt = await build;
				results.push({ name, ok: true, elapsed: completedAt - start });
			} catch (error) {
				if (failure) throw failure;
				results.push({ name, ok: false, elapsed: Date.now() - start });
				// Continue after a missed event so the case reports every missing rebuild.
				const recovery = nextBuild();
				watching.invalidate();
				await recovery;
			}
		};
		const firstBuild = nextBuild();
		watching = compiler.watch(
			{ aggregateTimeout: 50, followSymlinks: true },
			(error, stats) => {
				builds++;
				if (error || stats.hasErrors()) {
					clearTimeout(timer);
					failure = error || new Error(stats.toString());
					pending?.reject(failure);
					pending = undefined;
				} else if (pending && doneAt >= pending.since) {
					clearTimeout(timer);
					pending.resolve(doneAt);
					pending = undefined;
				}
			}
		);
		try {
			await firstBuild;
			await step("existing context subdirectory", () => {
				fs.writeFileSync(
					path.join(source, "ctx", "existing", "new.js"),
					"module.exports = 1;\n"
				);
			});
			await step("empty directory creation", () => {
				fs.mkdirSync(path.join(source, "ctx", "created"));
			});
			await step("file in directory created after start", () => {
				fs.writeFileSync(
					path.join(source, "ctx", "created", "later.js"),
					"module.exports = 2;\n"
				);
			});
			await step("new file in plugin-only context subdirectory", () => {
				fs.writeFileSync(
					path.join(source, "plugin", "nested", "new.txt"),
					"new\n"
				);
			});
			await step("edit in plugin-only context subdirectory", () => {
				fs.writeFileSync(
					path.join(source, "plugin", "nested", "seed.txt"),
					"after\n"
				);
			});
			// Report missed nested events before testing removal behavior.
			expect(results.filter((result) => !result.ok)).toEqual([]);
			// Dropping an outer plugin context must keep the inner context and file.
			context.setValue("keepOuterContext", false);
			await step("remove outer plugin context", () => watching.invalidate());
			await wait(500);
			const before = builds;
			fs.writeFileSync(
				path.join(source, "plugin", "nested", "unused.txt"),
				"unused\n"
			);
			await wait(700);
			results.push({
				name: "removed context stays quiet",
				ok: builds === before
			});
			await step("retained file dependency", () => {
				fs.writeFileSync(
					path.join(source, "plugin", "kept", "deep", "file.txt"),
					"changed\n"
				);
			});
			await step("write real nested file before alias removal", () => {
				fs.writeFileSync(
					path.join(source, "ctx", "real", "sub", "a.js"),
					"module.exports = 3;\n"
				);
			});
			await wait(500);
			const recreated = nextBuild();
			fs.rmSync(path.join(source, "ctx", "real", "sub"), { recursive: true });
			fs.mkdirSync(path.join(source, "ctx", "real", "sub"));
			fs.writeFileSync(
				path.join(source, "ctx", "real", "sub", "a.js"),
				"module.exports = 3;\n"
			);
			await recreated;
			await step("recreated directory while alias remains", () => {
				fs.writeFileSync(
					path.join(source, "ctx", "real", "sub", "recreated.js"),
					"module.exports = 6;\n"
				);
			});
			await step("remove symlink alias", () =>
				fs.unlinkSync(path.join(source, "ctx", "link"))
			);
			await step("real directory after alias removal", () => {
				fs.writeFileSync(
					path.join(source, "ctx", "real", "sub", "b.js"),
					"module.exports = 3;\n"
				);
			});
			await step("real root after alias removal", () => {
				fs.writeFileSync(
					path.join(source, "ctx", "real", "c.js"),
					"module.exports = 4;\n"
				);
			});
			await step("move watched directory into context and recreate old path", () => {
				fs.renameSync(path.join(source, "other"), path.join(source, "ctx", "moved"));
				fs.mkdirSync(path.join(source, "other"));
				fs.writeFileSync(path.join(source, "other", "file.txt"), "recreated\n");
			});
			await step("write in moved directory after old path recreation", () => {
				fs.writeFileSync(
					path.join(source, "ctx", "moved", "new.js"),
					"module.exports = 5;\n"
				);
			});
			context.setValue("results", results);
		} finally {
			clearTimeout(timer);
			await new Promise((resolve, reject) =>
				watching.close((error) => (error ? reject(error) : resolve()))
			);
		}
	},
	async check({ context, files }) {
		expect(
			context.getValue("results").filter((result) => !result.ok)
		).toEqual([]);
		const module = { exports: {} };
		const bundle = Object.entries(files).find(
			([file]) => path.basename(file) === "bundle.js"
		)?.[1];
		vm.runInNewContext(bundle, { module });
		expect(module.exports).toEqual([
			"./created/later.js",
			"./existing/new.js",
			"./moved/new.js",
			"./real/c.js",
			"./real/sub/a.js",
			"./real/sub/b.js",
			"./real/sub/recreated.js"
		]);
	}
};
