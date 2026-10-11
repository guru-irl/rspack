import { value } from "./barrel";
import { lookup } from "./wrapper";

it("should reuse bypassed barrels after a leaf edit and an unchanged resolver rebuild", async () => {
	expect(value()).toBe(WATCH_STEP === "1" ? "after" : "before");
	expect(await lookup()).toBe("public-handler");
});
