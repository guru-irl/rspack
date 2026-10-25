const config = require("../replay/rspack.config");
module.exports = {
	...config,
	optimization: {
		...config.optimization,
		splitChunks: { ...config.optimization.splitChunks, experimentalReplay: false }
	},
	plugins: [
		...config.plugins,
		{
			apply(compiler) {
				new compiler.rspack.DefinePlugin({
					REPLAY_OVERRIDE: JSON.stringify(["1", "strict", "force"].includes(process.env.RSPACK_SPLIT_CHUNKS_REPLAY || ""))
				}).apply(compiler);
			}
		}
	]
};
