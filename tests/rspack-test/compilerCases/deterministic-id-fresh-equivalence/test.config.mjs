import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { rspack } from "@rspack/core";
import { runCompiler, closeCompiler } from "@rspack/test-tools/helper/lifecycle";

function writeInputs(source, count, reverse = false, custom = false) {
	fs.mkdirSync(source, { recursive: true });
	const names = Array.from({ length: count - 1 }, (_, i) => `module${i}.js`);
	if (custom) names[0] = "custom.js";
	if (reverse) names.reverse();
	for (const name of names) {
		const file = path.join(source, name);
		if (!fs.existsSync(file)) fs.writeFileSync(file, `export default ${JSON.stringify(name)};\n`);
	}
	fs.writeFileSync(
		path.join(source, "index.js"),
		names.map((name, i) => `import value${i} from "./${name}";`).join("\n") +
			`\nexport default [${names.map((_, i) => `value${i}`).join(",")}];\n`
	);
	return names;
}

function options(source, output, incremental) {
	return {
		context: source,
		mode: "development",
		target: "node",
		entry: "./index.js",
		cache: false,
		incremental,
		devtool: false,
		experiments: { nativeWatcher: false },
		output: { path: output, filename: "main.js", library: { type: "commonjs2" } },
		optimization: {
			moduleIds: "deterministic",
			chunkIds: "named",
			concatenateModules: false,
			inlineExports: false,
			mangleExports: false,
			usedExports: false,
			splitChunks: false,
			minimize: false
		},
		plugins: [{
			apply(compiler) {
				compiler.hooks.compilation.tap("CustomId", compilation => {
					compilation.hooks.beforeModuleIds.tap("CustomId", modules => {
						for (const module of modules) {
							if (module.resource?.endsWith("custom.js")) {
								module.id = "custom-id";
							}
						}
					});
				});
			}
		}]
	};
}

function ids(stats) {
	expect(stats.hasErrors()).toBe(false);
	return Object.fromEntries(
		[...stats.compilation.modules]
			.map(module => [path.basename(module.resource), stats.compilation.chunkGraph.getModuleId(module)])
			.sort(([a], [b]) => a.localeCompare(b))
	);
}

function execute(output) {
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(path.join(output, "main.js"), "utf8"), { module, exports: module.exports });
	return Array.from(module.exports.default);
}

export default {
	description: "should match fresh deterministic IDs and runnable output after add/remove, range growth, ordering and custom ID edits",
	options(context) {
		const source = context.getDist("src");
		context.setValue("source", source);
		context.setValue("expected", writeInputs(source, 3));
		return options(source, context.getDist("watch"), { silent: false });
	},
	compiler(_context, compiler) {
		compiler.outputFileSystem = fs;
	},
	async build(context, compiler) {
		const source = context.getValue("source");
		// Counts include the entry: defaults cross range 1000 -> 10000 at 51.
		const steps = [[4], [3], [50], [51], [50], [50, true], [4, false, true]];
		let step = 0;
		let expected = context.getValue("expected");
		await new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => finish(new Error("Timed out comparing watch IDs")), 25000);
			const finish = error => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				watching.close(closeError => error || closeError ? reject(error || closeError) : resolve());
			};
			const watching = compiler.watch({ poll: 50, aggregateTimeout: 10 }, async (error, stats) => {
				if (settled) return;
				try {
					if (error) throw error;
					// Freeze the current inputs while the independent fresh compiler runs.
					watching.suspend();
					const watchIds = ids(stats);
					const freshOutput = context.getDist("fresh");
					const fresh = rspack(options(source, freshOutput, false));
					try {
						const freshStats = await runCompiler(fresh);
						expect(watchIds).toEqual(ids(freshStats));
						expect(execute(compiler.options.output.path)).toEqual(expected);
						expect(execute(freshOutput)).toEqual(expected);
						if (expected.includes("custom.js")) expect(watchIds["custom.js"]).toBe("custom-id");
					} finally {
						await closeCompiler(fresh);
					}
					if (step === steps.length) return finish();
					expected = writeInputs(source, ...steps[step++]);
					compiler.inputFileSystem.purge();
					watching.invalidateWithChangesAndRemovals(new Set([path.join(source, "index.js")]));
					watching.resume();
				} catch (error) {
					finish(error);
				}
			});
		});
	}
};
