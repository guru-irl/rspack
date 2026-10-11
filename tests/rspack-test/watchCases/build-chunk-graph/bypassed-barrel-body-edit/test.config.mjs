import assert from "node:assert/strict";

export default {
	checkStats(stepName, _, stats) {
		if (stepName === "0") {
			assert(stats.includes("<t> rebuild chunk graph"));
		} else {
			assert(
				!stats.includes("<t> rebuild chunk graph"),
				"a leaf body edit must reuse the chunk graph through a bypassed barrel"
			);
		}
		return true;
	}
};
