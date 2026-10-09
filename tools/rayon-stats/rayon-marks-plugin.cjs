'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const installed = Symbol.for('rspack.rayon-marks-plugin.installed');

class RayonMarksPlugin {
  constructor(options = {}) { this.options = options; }
  apply(compiler) {
    const file = process.env.RSPACK_RAYON_MARKS;
    if (!file || compiler[installed]) return;
    compiler[installed] = true;
    const id = this.options.compilerId || randomUUID();
    const getContext = this.options.getContext;
    let build = 0;
    const mark = hook => {
      const row = {
        ...(typeof getContext === 'function' ? getContext() : {}),
        timestamp_ns: process.hrtime.bigint().toString(),
        compiler: compiler.name || null,
        compiler_id: id,
        compilation_id: null,
        build,
        source: 'js',
        pass: null,
        event: 'hook',
        hook,
      };
      // One append syscall per complete JSON line. No shared buffered writer.
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    };
    compiler.hooks.compile.tap({ name: 'RayonMarksPlugin', stage: -100000 }, () => {
      build++;
      mark('compile');
    });
    for (const name of ['thisCompilation', 'make', 'finishMake', 'afterCompile', 'emit', 'afterEmit', 'done']) {
      compiler.hooks[name].tap({ name: 'RayonMarksPlugin', stage: -100000 }, () => mark(name));
    }
    // Native pass marks cover compilation windows. Do not tap collection-valued
    // JS hooks: ignoring their arguments still forces binding materialization.
    // processAssets is also omitted; its exact native pass is already marked.
  }
}
module.exports = RayonMarksPlugin;
