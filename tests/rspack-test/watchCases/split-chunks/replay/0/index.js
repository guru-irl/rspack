const fs = require("fs");
const path = require("path");
it("replays content edits and invalidates topology edits", async () => {
	const step = Number(WATCH_STEP);
	const [a, b] = await Promise.all([import("./a"), import("./b")]);
	const expected = [1, 22, 22, 333, 333, 333][step];
	expect(a.default).toBe(expected + (step >= 2 && step < 5 ? 10 : 0));
	expect(b.default).toBe(expected);
	const lines = JSON.parse(fs.readFileSync(path.join(__dirname, "replay-log.json"), "utf8"));
	expect(lines).toHaveLength(1);
	if (step === 1 || step === 3) expect(lines[0]).toMatch(/^replay: replayed [1-9]/);
	else expect(lines[0]).toContain(step === 0 ? "full run (no record" : "full run (inputs changed");
});
