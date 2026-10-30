it("should change the full hash when only a child compilation changes", () => {
	if (WATCH_STEP === "0") {
		STATE.hash = __STATS__.hash;
	} else {
		expect(__STATS__.hash).not.toBe(STATE.hash);
	}
});
