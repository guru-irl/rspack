// module146.js also has the one-character compact prefix "e".
import replacementId from './module146.js';
import collisionId from './module101.js';
import './edited.js';

it('should reserve removed compact-hashed ids for the removing rebuild', () => {
  const modules = __STATS__.modules.filter((module) => module.moduleType !== 'runtime');
  const ids = Object.fromEntries(modules.map((module) => [module.name, module.id]));
  expect(ids['./module7.js']).toBeUndefined();
  expect(replacementId).toBe(ids['./module146.js']);
  expect(collisionId).toBe(ids['./module101.js']);
  expect(replacementId.startsWith(STATE.ids['./module7.js'])).toBe(true);
  expect(replacementId).not.toBe(STATE.ids['./module7.js']);
});
