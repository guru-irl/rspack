const path = require('node:path');

module.exports = function (source) {
  const callback = this.async();
  const delayed = path.basename(this.resourcePath) === this.getOptions().delayed;
  setTimeout(() => callback(null, source), delayed ? 100 : 0);
};
