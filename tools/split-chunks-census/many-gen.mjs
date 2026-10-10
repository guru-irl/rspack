import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.env.SC_FIXTURE_ROOT);
const arm = process.env.SC_ARM || 'mixed-selective';
if (!['mixed-selective', 'mixed-saturated', 'every-priority-winner'].includes(arm)) throw Error('invalid arm');
const src = path.join(root, 'src');
fs.mkdirSync(src, { recursive: true });
const routeImports = Array.from({length:5000},()=>[]);
const tiers = arm === 'every-priority-winner' ? 10 : 5;
const leaves = 55000;
for (let i=0;i<leaves;i++) {
  const tier=i%tiers;
  const slot=Math.floor(i/tiers)%500;
  const rel=`tier${tier}/${i<tiers?"named":"leaf"}${String(i).padStart(5,'0')}.js`;
  fs.mkdirSync(path.dirname(path.join(src,rel)),{recursive:true});
  fs.writeFileSync(path.join(src,rel),`export const value=${i};\n`);
  // Independent sharing opportunities in each tier. Extra repeated selectors
  // compete for the same leaves without consuming other tiers' opportunities.
  const a=tier*500+slot;
  const b=(a+2500)%5000;
  const routes=new Set([a,b]);
  if (arm === 'mixed-saturated') {
    // Bounded (64) fan-out makes conservative masks dense. This is a
    // qualification hypothesis, not a claim until measured by the baseline.
    for(let j=0;j<62;j++) routes.add((a+j*73+slot*17)%5000);
  }
  for(const r of routes) routeImports[r].push(`import {value as v${i}} from './${rel}';`);
}
for(let r=0;r<5000;r++) {
  fs.writeFileSync(path.join(src,`route${r}.js`),`${routeImports[r].join('\n')}\nglobalThis.route=${r};\n`);
}
fs.writeFileSync(path.join(src,'entry.js'),Array.from({length:5000},(_,r)=>`import(/* webpackChunkName: "route-${r}" */ './route${r}.js');`).join('\n'));
fs.writeFileSync(path.join(root,'topology.json'),JSON.stringify({arm,seed:0,leaves,routes:5000,modules:60001,tiers,maxFanout:arm==='mixed-saturated'?64:2}));
console.log('generated',arm);
