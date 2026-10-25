import { value, helper } from "./local";
const fs = require("fs");
const path = require("path");
console.log(value);
it("reuses an unchanged unreachable barrel chain", () => {
	const step = Number(WATCH_STEP);
	expect(value).toBe(["cold", "edited", "edited", "final"][step]);
	expect(helper()).toBe("helper");
	if (step === 1) {
		const lines = JSON.parse(fs.readFileSync(path.join(__dirname, "cache-log.json"), "utf8"));
		expect(lines.join("\n")).not.toContain("module topology change detected");
	}
});
