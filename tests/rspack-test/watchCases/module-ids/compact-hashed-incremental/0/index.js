import value from './edited.js';
import targetId from './module7.js';

it('should retain compact-hashed ids and process only affected modules', () => {
  const modules = __STATS__.modules.filter((module) => module.moduleType !== 'runtime');
  const ids = Object.fromEntries(modules.map((module) => [module.name, module.id]));
  expect(targetId).toBe(ids['./module7.js']);
  expect(value).toBe(WATCH_STEP === '0' ? 'initial' : 'updated');

  if (WATCH_STEP === '0') {
    expect(targetId).toHaveLength(1);
    STATE.ids = ids;
  } else {
    expect(ids).toEqual(STATE.ids);
    expect(modules.filter((module) => module.codeGenerated).map((module) => module.name)).toEqual(['./edited.js']);
  }
});
