export default {
	checkStats(step, stats, text) {
		if (step !== "1") return true;
		const hashes = /LOG from rspack\.incremental\.modulesHashes[\s\S]*?(?=\nLOG from |$)/.exec(text);
		expect(hashes).not.toBeNull();
		expect(hashes[0]).toContain("2 modules are affected, 3 in total");
		const codegen = /LOG from rspack\.incremental\.modulesCodegen[\s\S]*?(?=\nLOG from |$)/.exec(text);
		expect(codegen).not.toBeNull();
		expect(codegen[0]).toContain("1 modules are affected, 3 in total");
		expect(stats.modules.find(module => module.name === "./stable.js").codeGenerated).toBe(false);
		expect(stats.warnings.some(warning => /NotFriendlyForIncremental|not friendly for incremental/.test(warning.message) && /modulesHashes/.test(warning.message))).toBe(false);
		return true;
	}
};
