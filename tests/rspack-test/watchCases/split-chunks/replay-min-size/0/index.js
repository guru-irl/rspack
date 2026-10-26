const fs = require("fs");
const path = require("path");
it("splits a group that grows past minSize on a content edit", async () => {
  const [a, b] = await Promise.all([import("./a"), import("./b")]);
  expect(a.default).toHaveLength(Number(WATCH_STEP) === 0 ? 1 : 1200);
  expect(b.default).toBe(a.default);
  expect(fs.existsSync(path.join(__dirname, "shared.js"))).toBe(Number(WATCH_STEP) === 1);
});
