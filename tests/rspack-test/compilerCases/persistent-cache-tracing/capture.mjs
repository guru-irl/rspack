import fs from "node:fs";
import path from "node:path";
import { rspack } from "@rspack/core";

export default async function capture(root, filter, label) {
	const src = path.join(root, "src");
	fs.mkdirSync(src, { recursive: true });
	const sources = {
		"index.js":
			'import { a } from "./a.js";\nimport { b } from "./b.js";\nimport { large } from "./large.js";\nconsole.log(a + b, large);\n',
		"a.js":
			'import { shared } from "./shared.js";\nexport const a = shared + 1;\n',
		"b.js":
			'import { shared } from "./shared.js";\nexport const b = shared + 2;\n',
		"shared.js": "export const shared = 3;\n",
		// Exceed the storage pack limit so recovery must spawn cold-pack loads.
		"large.js": `export const large = "${"x".repeat(600 * 1024)}";\n`
	};
	// Preserve source mtimes so the second process exercises disk-cache recovery.
	for (const [name, content] of Object.entries(sources)) {
		const file = path.join(src, name);
		if (!fs.existsSync(file)) fs.writeFileSync(file, content);
	}

	const traceFile = path.join(root, `${label}.jsonl`);
	let builtModules;
	try {
		await rspack.experiments.globalTrace.register(filter, "logger", traceFile);
		const compiler = rspack({
			context: src,
			entry: "./index.js",
			mode: "development",
			devtool: "source-map",
			optimization: { minimize: true },
			experiments: { newCache: false },
			cache: {
				type: "persistent",
				storage: {
					type: "filesystem",
					directory: path.join(root, "cache")
				}
			},
			output: { path: path.join(root, "dist"), filename: "main.js" }
		});
		try {
			await new Promise((resolve, reject) => {
				compiler.run((error, stats) => {
					if (error) return reject(error);
					if (stats.hasErrors()) {
						return reject(
							new Error(stats.toString({ all: false, errors: true }))
						);
					}
					const { modules } = stats.toJson({ all: false, modules: true });
					builtModules = modules.filter(module => module.built).length;
					resolve();
				});
			});
		} finally {
			await new Promise((resolve, reject) => {
				compiler.close(error => (error ? reject(error) : resolve()));
			});
		}
	} finally {
		await rspack.experiments.globalTrace.cleanup();
	}

	const closes = fs
		.readFileSync(traceFile, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => JSON.parse(line))
		.filter(
			record =>
				record.fields?.message === "close" && record.target !== "javascript"
		)
		.map(record => ({
			name: record.span.name,
			target: record.target,
			parents: (record.spans ?? []).map(span => span.name)
		}));
	const packs = fs
		.readdirSync(path.join(root, "cache"), { recursive: true })
		.filter(file => file.endsWith(".pack"));
	const coldPackFiles = packs.filter(
		file => path.basename(file) !== "0.pack"
	).length;
	return { closes, packFiles: packs.length, coldPackFiles, builtModules };
}
