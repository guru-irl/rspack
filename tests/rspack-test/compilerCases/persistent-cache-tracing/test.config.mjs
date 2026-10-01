import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNodeCase } from "@rspack/test-tools/helper/node-case";

const cache = "rspack_core::legacy_cache::persistent";
const storage = "rspack_storage::filesystem";
const db = `${storage}::db`;
const pack = `${db}::bucket::pack`;
const context = `${cache}::context`;
const moduleGraph = `${cache}::occasion::make::module_graph`;
const sourceMap = `${cache}::occasion::devtool`;

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
	description: "should trace persistent cache writes and warm recovery",
	async run() {
		const out = fileURLToPath(new URL("../../js/compiler/", import.meta.url));
		fs.mkdirSync(out, { recursive: true });
		const root = fs.mkdtempSync(path.join(out, "persistent-cache-tracing-"));
		try {
			const scenario = new URL("./capture.mjs", import.meta.url);
			const filter = `off,${cache}=info,rspack_storage=info`;
			// Separate processes ensure warm recovery reads the disk cache.
			const cold = await runNodeCase(scenario, [root, filter, "cold"]);
			const warm = await runNodeCase(scenario, [root, filter, "warm"]);
			assert.equal(warm.builtModules, 0, "warm build must recover all modules");
			for (const [capture, name, target] of [
				[cold, "Storage::Pack::save", pack],
				[cold, "Storage::Pack::flush", pack],
				[cold, "Storage::DB::save", db],
				[cold, "Storage::Transaction::commit", `${db}::transaction`],
				[cold, "Storage::FileSystem::load", storage],
				[cold, "Storage::FileSystem::save", storage],
				[cold, "Storage::FileSystem::flush", storage],
				[cold, "Cache::Context::save_storage", context],
				[cold, "Cache::Context::flush_storage", context],
				[warm, "Storage::Pack::load", pack],
				[warm, "Storage::DB::load", db],
				[cold, "Cache::Occasion::Make::ModuleGraph::serialize", moduleGraph],
				[warm, "Cache::Occasion::Make::ModuleGraph::deserialize", moduleGraph],
				[cold, "Cache::Occasion::SourceMap::serialize", sourceMap],
				[warm, "Cache::Occasion::SourceMap::deserialize", sourceMap]
			]) {
				assert(
					capture.closes.some(
						row => row.span.name === name && row.target === target
					),
					`missing ${name}@${target}; observed: ${[...new Set(capture.closes.map(row => `${row.span.name}@${row.target}`))].join(", ")}`
				);
			}
			assert(
				cold.closes
					.filter(row => row.span.name === "Storage::Pack::save")
					.every(row =>
						row.spans?.some(span => span.name === "Storage::DB::save")
					),
				"Storage::Pack::save must remain under Storage::DB::save"
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		}
	}
};
