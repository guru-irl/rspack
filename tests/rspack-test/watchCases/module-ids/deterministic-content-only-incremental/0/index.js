import changed from "./changed.js";
import stable from "./stable.js";

it("should execute the current edit and retain the stable module ID", () => {
	expect(changed).toBe(WATCH_STEP);
	expect(stable).toBe("stable");
	const module = __STATS__.modules.find(module => module.name === "./stable.js");
	if (WATCH_STEP === "0") STATE.stableId = module.id;
	else expect(module.id).toBe(STATE.stableId);
});
