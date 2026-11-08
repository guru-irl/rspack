it("loads the edited modules after the shared split chunk disappears", async () => {
  const [a, b] = await Promise.all([import("./a"), import("./b")]);
  const shared = WATCH_STEP === "0" ? "first".repeat(30) : "short";
  expect([a.default, b.default]).toEqual([`${shared}a`, `${shared}b`]);
});
