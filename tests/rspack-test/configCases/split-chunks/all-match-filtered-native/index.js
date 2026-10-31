module.exports = 42;

it('executes the single filtered entry', () => {
  expect(module.exports).toBe(42);
});
