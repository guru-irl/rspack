const fs = require("fs");
const path = require("path");
import value from "./value";
it("does not replay without an opt-in", () => {
	expect(value).toBe(Number(WATCH_STEP) + 1);
	const lines = JSON.parse(fs.readFileSync(path.join(__dirname, "replay-log.json"), "utf8"));
	if (REPLAY_OVERRIDE) expect(lines).toHaveLength(1);
	else expect(lines).toEqual([]);
});
