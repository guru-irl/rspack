import path from "node:path";
import { defineConfig } from "@rspack/cli";
import type { Configuration } from "@rspack/core";

// Identical builds in one MultiCompiler. They share one process, so each gets
// different chunk ukeys, and maxSize creates its split chunks in a different order.
function config(index: number): Configuration {
	return {
		mode: "development",
		devtool: false,
		entry: "./index.js",
		output: {
			path: path.resolve(import.meta.dirname, `dist/${index}`)
		},
		optimization: {
			chunkIds: "named",
			splitChunks: {
				chunks: "all",
				minSize: 0,
				maxSize: 100,
				cacheGroups: { default: false, defaultVendors: false }
			}
		}
	};
}

export default defineConfig([config(0), config(1), config(2)]);
