import fs from "node:fs";
import path from "node:path";

const CASE_NAME = "native-watcher-recreated-file-parent";
const wait = () => new Promise(resolve => setTimeout(resolve, 10));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Linux removes a deleted directory's inotify watch even if it is recreated
// with the same inode. Wait for coverage, not an assumed registration delay.
function hasDirectoryWatch(inode) {
	for (const fd of fs.readdirSync("/proc/self/fdinfo")) {
		let info;
		try {
			info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		for (const line of info.split("\n")) {
			const match = /^inotify wd:.* ino:([a-f0-9]+)/.exec(line);
			if (match && BigInt(`0x${match[1]}`) === inode) return true;
		}
	}
	return false;
}

/** @type {import("@rspack/test-tools").TCompilerCaseConfig} */
export default {
	description: "should watch later file edits after its parent is recreated before rewatch",
	options(context) {
		const root = context.getDist(CASE_NAME);
		fs.rmSync(root, { recursive: true, force: true });
		const source = path.join(root, "entry");
		const file = path.join(root, "watched", "value.txt");
		fs.mkdirSync(source, { recursive: true });
		fs.mkdirSync(path.dirname(file));
		fs.writeFileSync(path.join(source, "index.js"), "module.exports = 1;\n");
		fs.writeFileSync(file, "initial");
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(file, past, past);
		fs.utimesSync(path.join(source, "index.js"), past, past);
		context.setValue("file", file);
		return {
			context: source,
			mode: "development",
			devtool: false,
			entry: "./index.js",
			output: { path: path.join(root, "output") },
			experiments: { nativeWatcher: true },
			plugins: [compiler => {
				compiler.hooks.thisCompilation.tap(CASE_NAME, compilation => {
					compilation.hooks.processAssets.tap(CASE_NAME, () => {
						const value = fs.readFileSync(file, "utf8");
						compilation.emitAsset("observed.txt", new compiler.webpack.sources.RawSource(value));
					});
				});
				compiler.hooks.afterCompile.tap(CASE_NAME, compilation => {
					// An ancestor context watch would hide the lost file-parent watch.
					compilation.fileDependencies.clear();
					compilation.fileDependencies.add(file);
					// Keep the common root alive on platforms with one recursive root watch.
					compilation.fileDependencies.add(path.join(source, "index.js"));
					compilation.contextDependencies.clear();
					compilation.missingDependencies.clear();
					compilation.buildDependencies.clear();
				});
			}]
		};
	},
	async build(context, compiler) {
		const file = context.getValue("file");
		const parent = path.dirname(file);
		const held = deferred();
		const release = deferred();
		let pending = deferred();
		let runs = 0;
		let failure;
		let watching;
		const until = async condition => {
			while (!condition()) {
				if (failure) throw failure;
				await wait();
			}
		};
		compiler.hooks.watchRun.tapPromise(CASE_NAME, async () => {
			if (++runs === 2) {
				held.resolve();
				await release.promise;
			}
		});
		const first = pending.promise;
		watching = compiler.watch({ aggregateTimeout: 30 }, (error, stats) => {
			if (error || stats.hasErrors()) {
				failure = error || new Error(stats.toString());
				pending.reject(failure);
				return;
			}
			pending.resolve(stats.compilation.getAsset("observed.txt").source.source().toString());
		});
		try {
			expect(await first).toBe("initial");
			await until(() => watching.watcher && !watching.running);
			const inode = fs.statSync(parent, { bigint: true }).ino;
			if (process.platform === "linux") {
				await until(() => hasDirectoryWatch(inode));
			}
			pending = deferred();
			fs.rmSync(parent, { recursive: true });
			await held.promise;
			if (process.platform === "linux") {
				await until(() => !hasDirectoryWatch(inode));
			}
			fs.mkdirSync(parent);
			fs.writeFileSync(file, "returned");
			release.resolve();
			expect(await pending.promise).toBe("returned");
			await until(() => watching.watcher && !watching.running);
			if (process.platform === "linux") {
				const recreatedInode = fs.statSync(parent, { bigint: true }).ino;
				await until(() => hasDirectoryWatch(recreatedInode));
			}
			pending = deferred();
			fs.writeFileSync(file, "later-edit");
			expect(await pending.promise).toBe("later-edit");
		} finally {
			release.resolve();
			await new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));
		}
	},
	async check({ files }) {
		const asset = Object.entries(files).find(([file]) => path.basename(file) === "observed.txt");
		expect(asset?.[1]).toBe("later-edit");
	}
};
