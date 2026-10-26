import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const CASE_NAME = 'native-watcher-blocked-js-batches';
const AGGREGATE_TIMEOUT = 100;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const block = (ms) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const require = createRequire(import.meta.url);

/** @type {import("@rspack/test-tools").TCompilerCaseConfig} */
export default {
	description:
		'should retain native watcher batches while JavaScript is blocked',
	options(context) {
		const directory = context.getDist(CASE_NAME);
		fs.rmSync(directory, { recursive: true, force: true });
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		const source = fs.realpathSync(path.join(directory, 'src'));
		for (const name of ['a', 'b', 'c']) {
			fs.writeFileSync(
				path.join(source, `${name}.js`),
				`module.exports = "${name}-old";`,
			);
		}
		fs.writeFileSync(
			path.join(source, 'index.js'),
			'module.exports = [require("./a"), require("./b"), require("./c")];',
		);
		// Avoid startup events from the file timestamp accuracy window.
		const past = new Date(Date.now() - 10_000);
		for (const name of ['index', 'a', 'b', 'c']) {
			fs.utimesSync(path.join(source, `${name}.js`), past, past);
		}
		context.setValue('source', source);
		return {
			context: source,
			mode: 'development',
			devtool: false,
			target: 'node',
			entry: './index.js',
			output: {
				path: path.join(directory, 'dist'),
				filename: 'bundle.cjs',
				library: { type: 'commonjs2' },
			},
			experiments: { nativeWatcher: true },
		};
	},
	compiler(_context, compiler) {
		compiler.outputFileSystem = fs;
	},
	async build(context, compiler) {
		let builds = 0;
		let failure;
		let values;
		const bundle = path.join(compiler.options.output.path, 'bundle.cjs');
		let watching;
		let recording = false;
		const modified = new Set();
		compiler.hooks.watchRun.tap(CASE_NAME, () => {
			if (recording) {
				for (const file of compiler.modifiedFiles || []) modified.add(file);
			}
		});
		const firstBuild = new Promise((resolve, reject) => {
			watching = compiler.watch(
				{ aggregateTimeout: AGGREGATE_TIMEOUT },
				(error, stats) => {
					if (error || stats.hasErrors()) {
						failure = error || new Error(stats.toString());
						reject(failure);
						return;
					}
					try {
						delete require.cache[require.resolve(bundle)];
						values = require(bundle);
					} catch (error) {
						failure = error;
						reject(error);
						return;
					}
					builds++;
					resolve();
				},
			);
		});
		try {
			await firstBuild;
			let before;
			const settleDeadline = Date.now() + 10_000;
			do {
				before = builds;
				await wait(450);
				if (failure) throw failure;
				if (Date.now() > settleDeadline)
					throw new Error('Initial watch did not settle');
			} while (builds !== before);
			recording = true;
			for (const name of ['a', 'b', 'c']) {
				fs.writeFileSync(
					path.join(context.getValue('source'), `${name}.js`),
					`module.exports = "${name}-new";`,
				);
				block(AGGREGATE_TIMEOUT * 4);
			}
			block(AGGREGATE_TIMEOUT * 8);

			const expectedFiles = ['a', 'b', 'c'].map((name) =>
				path.join(context.getValue('source'), `${name}.js`),
			);
			const deadline = Date.now() + 10_000;
			do {
				if (failure) throw failure;
				if (
					expectedFiles.every((file) => modified.has(file)) &&
					JSON.stringify(values) === '["a-new","b-new","c-new"]'
				)
					break;
				await wait(25);
			} while (Date.now() < deadline);
			context.setValue(
				'missing',
				expectedFiles
					.filter((file) => !modified.has(file))
					.map((file) => path.basename(file)),
			);
			context.setValue('values', values);
		} finally {
			await new Promise((resolve, reject) =>
				watching.close((error) => (error ? reject(error) : resolve())),
			);
		}
	},
	async check({ context }) {
		expect(context.getValue('missing')).toEqual([]);
		expect(context.getValue('values')).toEqual(['a-new', 'b-new', 'c-new']);
	},
};
