import newId from './module83.js';
import value from './edited.js';
import targetId from './module7.js';

it('should reserve existing compact-hashed ids before an earlier colliding import', () => {
  const modules = __STATS__.modules.filter((module) => module.moduleType !== 'runtime');
  const ids = Object.fromEntries(modules.map((module) => [module.name, module.id]));
  for (const [name, id] of Object.entries(STATE.ids)) {
    expect(ids[name]).toBe(id);
  }
  expect(new Set(Object.values(ids)).size).toBe(modules.length);
  expect(newId).toBe(ids['./module83.js']);
  expect(targetId).toBe(ids['./module7.js']);
  expect(newId.startsWith(targetId)).toBe(true);
  expect(newId).not.toBe(targetId);
  expect(value).toBe('updated');
});
