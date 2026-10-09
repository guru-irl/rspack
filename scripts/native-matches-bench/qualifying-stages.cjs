const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const functionSource = source.slice(source.indexOf('function groupsFor('), source.indexOf('async function runOnce('));
const results = {};
for (const arm of ['native', 'callback']) {
  const groups = new Function('options', functionSource + '; return groupsFor({test:0,chunks:0,name:0});')({arm});
  const stages = new Map();
  for (const group of Object.values(groups)) {
    if (group === false) continue;
    const rows = stages.get(group.priority) || [];
    rows.push(group); stages.set(group.priority, rows);
  }
  const qualified = [...stages].filter(([, groups]) => groups.every(group =>
    !['test','chunks','name','layer','type'].some(key => typeof group[key] === 'function') &&
    group.type === undefined && !(group.test === undefined && group.layer === undefined)));
  results[arm] = {totalStages:stages.size, qualifyingStages:qualified.length, qualifyingGroups:qualified.reduce((n,[, groups])=>n+groups.length,0), priorities:qualified.map(([priority])=>priority).sort((a,b)=>b-a)};
}
console.log(JSON.stringify(results, null, 2));
