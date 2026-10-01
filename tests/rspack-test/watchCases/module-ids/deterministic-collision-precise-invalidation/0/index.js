import collision from "./trigger.js";
import targetModuleId from "./module7.js";
import stable from "./stable.js";

it("should reassign the collision as a fresh build does and update emitted references", () => {
	const module = __STATS__.modules.find(module => module.name === "./module7.js");
	expect(module.id).toBe(WATCH_STEP === "0" ? 764 : 383);
	expect(targetModuleId).toBe(module.id);
	expect(collision).toBe(WATCH_STEP === "0" ? "initial" : "collision");
	expect(stable).toBe("stable");
});

it("should not code generate the unrelated stable module after a collision", () => {
	if (WATCH_STEP === "1") {
		expect(__STATS__.modules.find(module => module.name === "./stable.js").codeGenerated).toBe(false);
	}
});
