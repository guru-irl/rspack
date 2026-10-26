const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve("bench-data/fold-smoke");
const mode = process.argv[2];
const sourceTypes = ["javascript", "css", "asset-url", "wasm", "asset", "expose", "remote", "share-init", "consume-shared", "share-container-shared", "unknown", "css-import", "runtime"];
function fold(chunks, hotIndex) {
	const hash = crypto.createHash("sha256").update("fold-smoke-salt");
	for (const [, , , chunkHash, content] of chunks) {
		if (chunkHash !== null) hash.update(chunkHash);
		for (const key of Object.keys(content).sort((a, b) => sourceTypes.indexOf(a) - sourceTypes.indexOf(b))) {
			assert(sourceTypes.includes(key), `Unexpected source type ${key}`);
			hash.update(key).update(content[key]);
		}
	}
	return hash.update(String(hotIndex)).digest("hex");
}
function compareIds(a, b) {
	if (a[1] === null && b[1] === null) return String(a[3]).localeCompare(String(b[3]), "en");
	if (a[1] === null) return 1;
	if (b[1] === null) return -1;
	const x = String(a[1]), y = String(b[1]);
	return x < y ? -1 : x > y ? 1 : 0;
}
async function child() {
	const { rspack } = require(path.resolve("bench-data/runtime/node_modules/@rspack/core"));
	const dir = path.join(root, mode);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "index.js"), 'console.log(__webpack_hash__); import("./z.js"); import("./a.js");\n');
	fs.writeFileSync(path.join(dir, "z.js"), 'export default "z";\n');
	fs.writeFileSync(path.join(dir, "a.js"), 'export default "a";\n');
	const config = {
		mode: "development",
		context: dir,
		entry: "./index.js",
		devtool: false,
		output: { path: path.join(dir, "out"), filename: "[name].[fullhash].js", hashFunction: "sha256", hashDigestLength: 20, hashSalt: "fold-smoke-salt" },
		optimization: { chunkIds: "named", moduleIds: "named", runtimeChunk: "single" }
	};
	if (mode !== "unnamed") config.name = "fold-smoke";
	const compiler = rspack(config);
	const hashes = [];
	try {
		for (let step = 0; step < 2; step++) {
			fs.writeFileSync(path.join(dir, "z.js"), `export default ${step};\n`);
			const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
			assert(!stats.hasErrors(), stats.toString({ all: false, errors: true }));
			hashes.push(stats.hash);
			if (mode === "named" || mode === "unnamed" || mode === "baseline") {
				const file = process.env.RSPACK_FULL_HASH_FOLD_DUMP;
				assert(fs.existsSync(file), "FOLD_DUMP_MISSING");
				const text = fs.readFileSync(file, "utf8");
				assert(text.endsWith("\n"));
				const records = text.trimEnd().split("\n").map(line => JSON.parse(line));
				assert.equal(records.length, step + 1);
				const record = records[step];
				assert.equal(record.compiler, mode === "unnamed" ? null : "fold-smoke");
				assert(Number.isInteger(record.hot_index));
				assert(record.chunks.length >= 3);
				for (const [index, [rank, id, name, hash, content]] of record.chunks.entries()) {
					assert.equal(rank, index);
					assert(id === null || typeof id === "string" || typeof id === "number");
					assert(name === null || typeof name === "string");
					assert(hash === null || typeof hash === "string");
					assert(content && typeof content === "object" && !Array.isArray(content));
				}
				assert.equal(record.full_hash.slice(0, 20), stats.hash);
				assert.equal(fold(record.chunks, record.hot_index), record.full_hash);
				assert.equal(fold([...record.chunks].sort(compareIds), record.hot_index), record.id_order_hash);
				console.log(`PASS ${mode} compilation=${step} chunks=${record.chunks.length} stats.hash=${stats.hash} full_hash=${record.full_hash} id_order_hash=${record.id_order_hash}`);
			}
		}
	} finally {
		await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
	}
	const mapped = fs.readFileSync("/proc/self/maps", "utf8").split("\n").filter(line => line.includes(".node"));
	const native = fs.realpathSync(process.env.RSPACK_BINDING);
	assert(mapped.some(line => line.endsWith(native)), "Expected binding absent from process maps");
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(native)).digest("hex"), process.env.EXPECTED_NATIVE_SHA);
	console.log(`PASS ${mode} native=${process.env.EXPECTED_NATIVE_SHA} hashes=${hashes.join(",")}`);
}
if (mode) {
	child().catch(error => { console.error(error); process.exitCode = 1; });
} else {
	fs.mkdirSync(root, { recursive: true });
	const modes = process.env.FOLD_SMOKE_BASELINE === "1" ? ["baseline"] : ["named", "unnamed", "unset", "badpath"];
	for (const item of modes) {
		const dump = path.join(root, `${item}.jsonl`);
		assert(!fs.existsSync(dump), "Use a fresh smoke directory");
		const env = { ...process.env };
		delete env.NODE_OPTIONS;
		delete env.RSPACK_FULL_HASH_FOLD_DUMP;
		if (item !== "unset") env.RSPACK_FULL_HASH_FOLD_DUMP = item === "badpath" ? path.join(root, "missing", "dump.jsonl") : dump;
		const result = spawnSync(process.execPath, [__filename, item], { env, encoding: "utf8" });
		process.stdout.write(result.stdout || "");
		process.stderr.write(result.stderr || "");
		if (item === "baseline") {
			assert.equal(result.status, 1);
			assert(result.stderr.includes("FOLD_DUMP_MISSING"));
			console.log("PASS negative control: csabsent does not emit a fold dump");
		} else {
			assert.equal(result.status, 0);
			if (item === "unset" || item === "badpath") assert(!fs.existsSync(dump));
		}
	}
}
