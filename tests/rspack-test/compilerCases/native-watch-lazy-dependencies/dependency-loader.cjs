const path = require('node:path');

module.exports = function (source) {
  const phase = source.includes('"new"') ? 'new' : 'old';
  const context = path.dirname(this.resourcePath);
  this.addDependency(path.join(context, `${phase}.txt`));
  this.addContextDependency(path.join(context, `${phase}-context`));
  this.addMissingDependency(path.join(context, `${phase}-missing`));
  return source;
};
