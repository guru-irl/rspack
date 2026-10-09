"""Generate a standalone CommonJS module tree and a custom-buildInfo loader."""
import json,os,sys
from pathlib import Path
root=Path(os.environ.get('BUILDINFO_BENCH_DIR','.bench/buildinfo-access')).resolve()
count=int(sys.argv[1]) if len(sys.argv)>1 else 60000
assert count>0 and count%100==0,'Leaf count must be a positive multiple of 100'
groups=count//100
fixture=root/'fixture';src=fixture/'src';src.mkdir(parents=True,exist_ok=True)
for g in range(groups):
    d=src/f'g{g:03d}';d.mkdir(exist_ok=True)
    for n in range(100):
        i=g*100+n;(d/f'm{i:05d}.js').write_text(f'module.exports = {i};\n')
    (d/'index.js').write_text('module.exports = '+' + '.join(f"require('./m{g*100+n:05d}.js')" for n in range(100))+';\n')
(src/'index.js').write_text('module.exports = '+' + '.join(f"require('./g{g:03d}/index.js')" for g in range(groups))+';\n')
(fixture/'loader.cjs').write_text("""module.exports = function(source) {
  global.__fixtureLoaderCalls = (global.__fixtureLoaderCalls || 0) + 1;
  const id = Number(/m(\\d+)\\.js$/.exec(this.resourcePath)[1]);
  if (id % 5 < 2) this._module.buildInfo['x.custom.key'] = { id, value: 'small', enabled: true };
  return source;
};
""")
(root/'fixture.json').write_text(json.dumps({'leaves':count,'groups':groups,'modules':count+groups+1,'customCount':count*2//5,'expectedValue':count*(count-1)//2},indent=2)+'\n')
print(f'Generated {count+groups+1} modules; {count*2//5} custom entries')
