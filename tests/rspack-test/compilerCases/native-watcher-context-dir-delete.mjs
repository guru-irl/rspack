import fs from "node:fs";
import path from "node:path";

const CASE_NAME = "native-watcher-context-dir-delete";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @type {import("@rspack/test-tools").TCompilerCaseConfig} */
export default {
	description: "should stop rebuilding a deleted context and watch its recreation",
	options(context) {
		const root = context.getDist(CASE_NAME);
		fs.rmSync(root, { recursive: true, force: true });
		const source = path.join(root, "src");
		const watched = path.join(source, "watched");
		fs.mkdirSync(watched, { recursive: true });
		const entry = path.join(source, "index.js");
		fs.writeFileSync(entry, "module.exports = 1;\n");
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(entry, past, past);
		fs.utimesSync(watched, past, past);
		context.setValue("watched", watched);
		return {
			context: source,
			mode: "development",
			devtool: false,
			target: "node",
			entry: "./index.js",
			output: { path: path.join(root, "dist") },
			experiments: { nativeWatcher: true },
			plugins: [
				compiler => {
					compiler.hooks.thisCompilation.tap(CASE_NAME, compilation => {
						compilation.contextDependencies.add(watched);
						const files = fs.existsSync(watched) ? fs.readdirSync(watched) : [];
						compilation.emitAsset(
							"files.json",
							new compiler.webpack.sources.RawSource(JSON.stringify(files))
						);
					});
				}
			]
		};
	},
	async build(context, compiler) {
		let builds = 0;
		let failure;
		let onBuild;
		let timer;
		const nextBuild = () =>
			new Promise((resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Timed out waiting for a rebuild")),
					5_000
				);
				onBuild = error => {
					clearTimeout(timer);
					onBuild = undefined;
					if (error) reject(error);
					else resolve();
				};
			});
		const firstBuild = nextBuild();
		const watching = compiler.watch({ aggregateTimeout: 100 }, (error, stats) => {
			failure = error || (stats.hasErrors() ? new Error(stats.toString()) : failure);
			builds++;
			onBuild?.(failure);
		});
		try {
			await firstBuild;
			await wait(300);
			if (failure) throw failure;
			const beforeDelete = builds;
			const removed = nextBuild();
			fs.rmSync(context.getValue("watched"), { recursive: true });
			await removed;
			await wait(2_200);
			if (failure) throw failure;
			const deletionBuilds = builds - beforeDelete;
			context.setValue("deletionBuilds", deletionBuilds);

			const beforeRecreate = builds;
			const recreated = nextBuild();
			fs.mkdirSync(context.getValue("watched"));
			fs.writeFileSync(
				path.join(context.getValue("watched"), "restored.txt"),
				"restored\n"
			);
			await recreated;
			await wait(1_000);
			if (failure) throw failure;
			context.setValue("recreationBuilds", builds - beforeRecreate);
		} finally {
			clearTimeout(timer);
			await new Promise((resolve, reject) =>
				watching.close(error => (error ? reject(error) : resolve()))
			);
		}
	},
	async check({ context, files }) {
		expect(context.getValue("deletionBuilds")).toBeLessThanOrEqual(2);
		expect(context.getValue("recreationBuilds")).toBe(1);
		const output = Object.entries(files).find(
			([file]) => path.basename(file) === "files.json"
		)[1];
		expect(JSON.parse(output)).toEqual(["restored.txt"]);
	}
};
