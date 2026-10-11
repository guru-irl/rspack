import { value } from "./barrel";

it("should update the leaf through a bypassed barrel without rebuilding the chunk graph", () => {
	expect(value()).toBe(WATCH_STEP === "0" ? "before" : "after");
});
