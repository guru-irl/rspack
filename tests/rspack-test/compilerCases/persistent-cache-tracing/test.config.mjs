import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNodeCase } from "@rspack/test-tools/helper/node-case";

const filter =
	"off,rspack_core::legacy_cache::persistent=info,rspack_storage=info";

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
	description:
		"should expose persistent cache storage writes and warm loads in logger traces",
	async run() {
		const out = fileURLToPath(new URL("../../js/compiler/", import.meta.url));
		fs.mkdirSync(out, { recursive: true });
		const root = fs.mkdtempSync(path.join(out, "persistent-cache-tracing-"));
		try {
			const scenario = new URL("./capture.mjs", import.meta.url);
			// Tracing registration is process-global, and warm load must read from disk.
			const cold = await runNodeCase(scenario, [root, filter, "cold"]);
			const warm = await runNodeCase(scenario, [root, filter, "warm"]);
			const requireSpan = (capture, name, target) => {
				assert(
					capture.closes.some(
						row => row.name === name && row.target === target
					),
					`missing trace span ${name} at target ${target}; observed: ${[
						...new Set(capture.closes.map(row => `${row.name}@${row.target}`))
					].join(", ")}`
				);
			};
			assert(cold.packFiles > 0, "persistent cache must actually write packs");
			assert(cold.coldPackFiles > 0, "fixture must write cold packs");
			assert(cold.builtModules > 0, "cold build must build modules");
			assert.equal(warm.builtModules, 0, "warm build must recover all modules");
			// Positive control: this INFO span exists before the new instrumentation.
			requireSpan(
				cold,
				"Cache::Context::save_occasion",
				"rspack_core::legacy_cache::persistent::context"
			);
			requireSpan(
				cold,
				"Storage::Pack::save",
				"rspack_storage::filesystem::db::bucket::pack"
			);
			requireSpan(
				cold,
				"Storage::Pack::flush",
				"rspack_storage::filesystem::db::bucket::pack"
			);
			requireSpan(cold, "Storage::DB::save", "rspack_storage::filesystem::db");
			requireSpan(
				cold,
				"Storage::Transaction::commit",
				"rspack_storage::filesystem::db::transaction"
			);
			for (const name of [
				"Storage::FileSystem::load",
				"Storage::FileSystem::save",
				"Storage::FileSystem::flush"
			]) {
				requireSpan(cold, name, "rspack_storage::filesystem");
			}
			requireSpan(
				cold,
				"Cache::Context::save_storage",
				"rspack_core::legacy_cache::persistent::context"
			);
			requireSpan(
				cold,
				"Cache::Context::flush_storage",
				"rspack_core::legacy_cache::persistent::context"
			);
			requireSpan(
				warm,
				"Storage::Pack::load",
				"rspack_storage::filesystem::db::bucket::pack"
			);
			requireSpan(warm, "Storage::DB::load", "rspack_storage::filesystem::db");
			// Hot-pack loads already have a DB parent. Require it on every load
			// so a spawned cold-pack load cannot hide behind that positive control.
			for (const [capture, name, parent] of [
				[warm, "Storage::Pack::load", "Storage::DB::load"],
				[cold, "Storage::Pack::save", "Storage::DB::save"]
			]) {
				const packs = capture.closes.filter(row => row.name === name);
				assert(packs.length > 0, `must observe ${name}`);
				assert(
					packs.every(row => row.parents.includes(parent)),
					`${name} must remain under ${parent}; parents: ${JSON.stringify(
						packs.map(row => row.parents)
					)}; cold built=${cold.builtModules}, warm built=${warm.builtModules}, cold packs=${cold.coldPackFiles}`
				);
			}
			for (const [name, target] of [
				[
					"Cache::Occasion::Make::ModuleGraph",
					"rspack_core::legacy_cache::persistent::occasion::make::module_graph"
				],
				[
					"Cache::Occasion::SourceMap",
					"rspack_core::legacy_cache::persistent::occasion::devtool"
				],
				[
					"Cache::Occasion::Minimize",
					"rspack_core::legacy_cache::persistent::occasion::minimize"
				]
			]) {
				requireSpan(cold, `${name}::serialize`, target);
				requireSpan(warm, `${name}::deserialize`, target);
			}
			for (const capture of [cold, warm]) {
				assert(
					capture.closes.every(
						row =>
							row.target.startsWith("rspack_core::legacy_cache::persistent") ||
							row.target.startsWith("rspack_storage")
					),
					"native close records must respect the cache/storage filter"
				);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		}
	}
};
