const fs = require("fs");
const path = require("path");
it("reuses group structure on content edits and invalidates topology edits", async () => {
	const step = Number(WATCH_STEP);
	const [a, b] = await Promise.all([
		import(/* webpackChunkName: "a" */ "./a"),
		import(/* webpackChunkName: "b" */ "./b")
	]);
	const expected = [1, 22, 22, 333, 333, 333][step];
	expect(a.default).toBe(expected + (step >= 2 && step < 5 ? 10 : 0));
	expect(b.default).toBe(expected);
	if (step >= 4) expect(await b.lazy).toBe(42);
	const placement = JSON.parse(fs.readFileSync(path.join(__dirname, "cache-map.json"), "utf8"));
	expect(placement).toEqual({
		main: ["index.js"],
		a: step >= 2 && step < 5 ? ["a.js", "extra.js"] : ["a.js"],
		b: ["b.js"],
		shared: ["shared.js"],
		...(step >= 4 ? { lazy: ["lazy.js"] } : {})
	});
	const { lines, calls, phases, verification } = JSON.parse(fs.readFileSync(path.join(__dirname, "cache-log.json"), "utf8"));
	expect(lines).toHaveLength(1);
	if (step === 1 || step === 3) {
		expect(lines[0]).toContain("cache: unchanged graph");
		expect(phases.some(line => line.includes("outcome=hit"))).toBe(true);
		if (verification) { for (const count of Object.values(calls)) expect(count).toBeGreaterThan(0); }
		else expect(calls).toEqual({ test: 0, name: 0, chunks: 0 });
	} else {
		expect(lines[0]).toContain(step === 0 ? "full run (no record" : "full run (structure changed");
		for (const count of Object.values(calls)) expect(count).toBeGreaterThan(0);
	}
});
