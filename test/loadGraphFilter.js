// Loads src/base/graphFilter.js (an ES module with no imports) into a
// CommonJS context so it can be exercised in plain Node without a build
// step. The module is dependency-free by design; we only rewrite the
// final `export { ... }` statement.
const fs = require('fs');
const path = require('path');

function loadGraphFilter (srcDir) {
  const file = path.join(srcDir || path.join(__dirname, '..', 'src'), 'base', 'graphFilter.js');
  const source = fs.readFileSync(file, 'utf8');
  if (/^import\s/m.test(source)) {
    throw new Error('graphFilter.js must stay import-free for the zero-dependency test loader');
  }
  const transformed = source.replace(/export\s*\{/, 'module.exports = {');
  if (transformed === source) {
    throw new Error('could not find export statement in graphFilter.js');
  }
  const mod = { exports: {} };
  const factory = new Function('module', 'exports', 'require', transformed);
  factory(mod, mod.exports, require);
  return mod.exports;
}

module.exports = { loadGraphFilter };
