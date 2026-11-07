export async function load(): Promise<string> {
	const { default: value } = await import(
		/* webpackChunkName: "line-after-loader" */
		// eslint-disable-next-line no-restricted-imports
		"./from-loader"
	);
	return value;
}
