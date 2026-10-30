/** @type {import('@rspack/test-tools').THashCaseConfig} */
export default {
	validate(stats) {
		const [first, ...rest] = stats.stats.map(s =>
			s.toJson({ all: false, hash: true, assets: true })
		);
		// maxSize split every leaf chunk in two: main + 6 leaves + 6 parts.
		expect(first.assets.filter(a => a.name.endsWith(".js"))).toHaveLength(13);
		for (const other of rest) {
			expect(other.assets.map(a => a.name)).toEqual(
				first.assets.map(a => a.name)
			);
			expect(other.hash).toBe(first.hash);
		}
	}
};
