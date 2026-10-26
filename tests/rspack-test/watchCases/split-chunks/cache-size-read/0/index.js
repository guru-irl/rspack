const fs = require("fs");
const path = require("path");
import other from "./other";
it("refreshes grouping after a callback-observed size changes", async () => {
  const [a, b] = await Promise.all([import(/* webpackChunkName: "a" */ "./a"), import(/* webpackChunkName: "b" */ "./b")]);
  expect(a.default.length).toBe(Number(WATCH_STEP) === 0 ? 1 : 1200);
  expect(b.default.length).toBe(a.default.length);
  expect(other).toBe(Number(WATCH_STEP) === 2 ? 2 : 1);
  expect(fs.existsSync(path.join(__dirname, "size-dependent.js"))).toBe(Number(WATCH_STEP) !== 0);
});
