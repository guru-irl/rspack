// Both module7.js and module101.js have the one-character compact prefix "e".
import newId from './module101.js';
import './edited.js';
import targetId from './module7.js';

it('should reserve existing compact-hashed ids before an earlier colliding import', () => {
  const modules = __STATS__.modules.filter((module) => module.moduleType !== 'runtime');
  const ids = Object.fromEntries(modules.map((module) => [module.name, module.id]));
  for (const [name, id] of Object.entries(STATE.ids)) {
    expect(ids[name]).toBe(id);
  }
  expect(new Set(Object.values(ids)).size).toBe(modules.length);
  expect(newId).toBe(ids['./module101.js']);
  expect(targetId).toBe(ids['./module7.js']);
  expect(newId.startsWith(targetId)).toBe(true);
});
