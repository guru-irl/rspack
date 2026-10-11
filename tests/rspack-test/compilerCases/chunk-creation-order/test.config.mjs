/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
	description: "should iterate chunks and chunk groups in creation order",
	options(context) {
		return {
			context: context.getSource(),
			entry: { main: "./index.js" },
			optimization: { splitChunks: false },
			plugins: [
				{
					apply(compiler) {
						compiler.hooks.afterCompile.tap("ChunkCreationOrder", compilation => {
							const expected = [
								"main",
								"async-00",
								"async-01",
								"async-02",
								"async-03",
								"async-04",
								"async-05",
								"async-06",
								"async-07",
								"async-08",
								"async-09",
								"async-10",
								"async-11"
							];
							expect({
								chunks: Array.from(compilation.chunks, chunk => chunk.name),
								chunkGroups: compilation.chunkGroups.map(group => group.name)
							}).toEqual({ chunks: expected, chunkGroups: expected });
						});
					}
				}
			]
		};
	}
};
