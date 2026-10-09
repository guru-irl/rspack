export function wrap(kind) {
  return function (...args) {
    const state = globalThis.syntheticLoaderState;
    const original = state.originals[kind];
    const identity = state.identities[kind];
    const plugin = this.query.plugin;
    if (!identity.plugins.has(plugin)) { identity.plugins.add(plugin); identity.plugin_count++; }
    if (!identity.hooks.has(plugin[kind])) { identity.hooks.add(plugin[kind]); identity.hook_count++; }
    if (!identity.queries.has(this.query)) { identity.queries.add(this.query); identity.query_count++; }
    state.active++;
    state.started[kind]++;
    state.max = Math.max(state.max, state.active);
    const done = this.async();
    let finished = false;
    let callbackMode = false;
    const finish = (...values) => {
      if (finished) throw new Error('Loader completed twice');
      finished = true;
      state.active--;
      state.completed[kind]++;
      done(...values);
    };
    this.async = () => { callbackMode = true; return finish; };
    this.callback = finish;
    try {
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        result.then(value => { if (!callbackMode && !finished) finish(null, value); }, error => { if (!finished) finish(error); });
      } else if (!callbackMode && !finished) {
        finish(null, result);
      }
    } catch (error) {
      if (!finished) finish(error);
      else throw error;
    }
  };
}
