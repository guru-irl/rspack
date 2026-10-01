import fs from "node:fs";
import path from "node:path";
import { rspack } from "@rspack/core";

export default async function capture(root, filter, label) {
	const src = path.join(root, "src");
	fs.mkdirSync(src, { recursive: true });
	const sources = {
		"index.js":
			'import { a } from "./a.js";\nimport { b } from "./b.js";\nconsole.log(a + b);\n',
		"a.js":
			'import { shared } from "./shared.js";\nexport const a = shared + 1;\n',
		"b.js":
			'import { shared } from "./shared.js";\nexport const b = shared + 2;\n',
		"shared.js": "export const shared = 3;\n"
	};
	// Preserve source mtimes so the second process exercises disk-cache recovery.
	for (const [name, content] of Object.entries(sources)) {
		const file = path.join(src, name);
		if (!fs.existsSync(file)) fs.writeFileSync(file, content);
	}

	const traceFile = path.join(root, `${label}.jsonl`);
	try {
		await rspack.experiments.globalTrace.register(filter, "logger", traceFile);
		const compiler = rspack({
			context: src,
			entry: "./index.js",
			mode: "development",
			devtool: "source-map",
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
		.map(record => ({ name: record.span.name, target: record.target }));
	const packFiles = fs
		.readdirSync(path.join(root, "cache"), { recursive: true })
		.filter(file => file.endsWith(".pack")).length;
	return { closes, packFiles };
}
