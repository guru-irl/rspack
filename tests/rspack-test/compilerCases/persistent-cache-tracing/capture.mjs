import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { rspack } from "@rspack/core";

export default async function capture(root, filter, label) {
	const entry = path.join(root, "index.js");
	// Preserve the source mtime for disk-cache recovery in the warm process.
	if (!fs.existsSync(entry)) fs.writeFileSync(entry, "console.log(42);\n");
	const traceFile = path.join(root, `${label}.jsonl`);
	let builtModules;
	try {
		await rspack.experiments.globalTrace.register(filter, "logger", traceFile);
		const compiler = rspack({
			context: root,
			entry: "./index.js",
			mode: "development",
			devtool: "source-map",
			experiments: { newCache: false },
			cache: {
				type: "persistent",
				storage: { type: "filesystem", directory: path.join(root, "cache") }
			},
			output: { path: path.join(root, "dist"), filename: "main.js" }
		});
		try {
			const stats = await promisify(compiler.run.bind(compiler))();
			if (stats.hasErrors())
				throw new Error(stats.toString({ all: false, errors: true }));
			const { modules } = stats.toJson({ all: false, modules: true });
			builtModules = modules.filter(module => module.built).length;
		} finally {
			await promisify(compiler.close.bind(compiler))();
		}
	} finally {
		await rspack.experiments.globalTrace.cleanup();
	}
	const closes = fs
		.readFileSync(traceFile, "utf8")
		.trim()
		.split(/\r?\n/)
		.map(line => JSON.parse(line))
		.filter(row => row.fields?.message === "close");
	return { closes, builtModules };
}
