it("delivers dependencies added in done at step 1", async () => {
  expect(WATCH_STEP).toBe("1");
  // Watch delivery runs on nextTick after the build handler. Wait until its
  // assertions have executed before letting the final watch step finish.
  await new Promise(resolve => setImmediate(resolve));
});
