import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { rspack } from '@rspack/core';

const CASE_NAME = 'native-watcher-paused-event-burst';
const require = createRequire(import.meta.url);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {import("@rspack/test-tools").TCompilerCaseConfig} */
export default {
	description:
		'should compile a paused save once and report invalid before rebuilding',
	async run() {
		const directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), CASE_NAME)),
		);
		const bundle = path.join(directory, 'dist/client/bundle.cjs');
		for (const [file, text] of Object.entries({
			'client.js':
				'module.exports = [require("./a"), require("./b"), require("./c")];',
			'ssr.js': 'module.exports = "ssr";',
			'a.js': 'module.exports = "a-old";',
			'b.js': 'module.exports = "b-old";',
			'c.js': 'module.exports = "c-old";',
		})) {
			const filePath = path.join(directory, file);
			fs.writeFileSync(filePath, text);
			const past = new Date(Date.now() - 10_000);
			fs.utimesSync(filePath, past, past);
		}
		let recording = false;
		let failure;
		let lastDone = Date.now();
		let callbacks = 0;
		const runs = [];
		const values = [];
		const writes = [];
		const configs = ['client', 'ssr'].map((name) => ({
			name,
			...(name === 'ssr' ? { dependencies: ['client'] } : {}),
			context: directory,
			mode: 'development',
			devtool: false,
			target: 'node',
			entry: `./${name}.js`,
			output: {
				path: path.join(directory, 'dist', name),
				filename: 'bundle.cjs',
				library: { type: 'commonjs2' },
			},
			experiments: { nativeWatcher: true },
			watchOptions: { aggregateTimeout: 200, ignored: /node_modules/ },
			plugins: [
				{
					apply(child) {
						child.hooks.watchRun.tap(CASE_NAME, () => {
							if (recording && name === 'client')
								runs.push({
									modified: [...(child.modifiedFiles || [])]
										.map((file) => path.basename(file))
										.sort(),
									removed: [...(child.removedFiles || [])],
								});
						});
						child.hooks.done.tap(CASE_NAME, (stats) => {
							lastDone = Date.now();
							if (stats.hasErrors()) failure = new Error(stats.toString());
							if (recording && name === 'client' && !failure) {
								delete require.cache[require.resolve(bundle)];
								values.push(require(bundle));
							}
						});
					},
				},
			],
		}));
		let compiler = rspack(configs);
		const writer = spawn(
			process.execPath,
			[
				'-e',
				`
   const fs = require('node:fs');
   const path = require('node:path');
   process.once('message', () => {
    for (const [index, ms] of [[0, 200], [1, 700], [2, 1200]]) {
     setTimeout(() => {
      const name = ['a', 'b', 'c'][index];
      fs.writeFileSync(path.join(process.argv[1], name + '.js'), 'module.exports = "' + name + '-new";');
      process.send({ index, at: Date.now() });
     }, ms);
    }
   });
   process.send('ready');
  `,
				directory,
			],
			{ stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
		);
		let ready = false;
		writer.on('message', (message) => {
			if (message === 'ready') ready = true;
			else writes.push(message);
		});
		writer.on('error', (error) => {
			failure = error;
		});
		let watching;
		const until = async (condition) => {
			const deadline = Date.now() + 10_000;
			while (!condition()) {
				if (failure) throw failure;
				if (Date.now() > deadline) throw new Error('Watch did not settle');
				await wait(25);
			}
			if (failure) throw failure;
		};
		try {
			watching = compiler.watch(
				compiler.compilers.map((child) => child.options.watchOptions),
				(error, stats) => {
					if (error || stats.hasErrors())
						failure = error || new Error(stats.toString());
					callbacks++;
				},
			);
			await until(() => ready && callbacks > 0 && Date.now() - lastDone > 750);
			recording = true;
			const start = Date.now();
			writer.send('start');
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
			const end = Date.now();
			await until(
				() =>
					writes.length === 3 &&
					values.length > 0 &&
					Date.now() - lastDone > 750,
			);
			expect(writes.every(({ at }) => at > start && at < end)).toBe(true);
			expect(values).toEqual([['a-new', 'b-new', 'c-new']]);
			expect(runs).toEqual([
				{ modified: ['a.js', 'b.js', 'c.js'], removed: [] },
			]);

			await new Promise((resolve) => watching.close(resolve));
			watching = undefined;
			await new Promise((resolve, reject) =>
				compiler.close((error) => (error ? reject(error) : resolve())),
			);

			const events = [];
			let singleRecording = false;
			callbacks = 0;
			compiler = rspack({
				...configs[0],
				plugins: [
					{
						apply(single) {
							single.hooks.invalid.tap(CASE_NAME, (file) => {
								if (singleRecording)
									events.push(`invalid:${path.basename(file)}`);
							});
							single.hooks.watchRun.tapPromise(CASE_NAME, async () => {
								if (!singleRecording) return;
								const modified = [...single.modifiedFiles].map((file) =>
									path.basename(file),
								);
								events.push(`build:${modified.join(',')}`);
								if (modified.includes('a.js')) {
									fs.writeFileSync(
										path.join(directory, 'b.js'),
										'module.exports = "b-during-build";',
									);
									await wait(600);
								}
							});
						},
					},
				],
			});
			watching = compiler.watch(
				compiler.options.watchOptions,
				(error, stats) => {
					if (error || stats.hasErrors())
						failure = error || new Error(stats.toString());
					callbacks++;
					lastDone = Date.now();
				},
			);
			await until(() => callbacks > 0 && Date.now() - lastDone > 750);
			singleRecording = true;
			fs.writeFileSync(
				path.join(directory, 'a.js'),
				'module.exports = "a-trigger";',
			);
			await until(() => callbacks >= 3 && Date.now() - lastDone > 750);
			expect(events).toEqual([
				'invalid:a.js',
				'build:a.js',
				'invalid:b.js',
				'build:b.js',
			]);
		} finally {
			writer.kill();
			if (watching)
				await new Promise((resolve, reject) =>
					watching.close((error) => (error ? reject(error) : resolve())),
				);
			await new Promise((resolve, reject) =>
				compiler.close((error) => (error ? reject(error) : resolve())),
			);
			fs.rmSync(directory, { recursive: true, force: true });
		}
	},
};
