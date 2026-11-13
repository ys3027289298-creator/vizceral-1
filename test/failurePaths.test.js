// Failure-path tests: every invalid input must fail fast with a TypeError
// whose message identifies the problem, and must leave the graph untouched.
// Run: node test/failurePaths.test.js
const assert = require('assert');
const { loadGraphFilter } = require('./loadGraphFilter');

const gf = loadGraphFilter();

const graph = {
  nodes: [{ name: 'a', metrics: { rps: 1 } }, { name: 'b', metrics: { rps: 2 } }],
  connections: [{ source: 'a', target: 'b' }]
};

const cases = [
  { name: 'criteria is not an object', criteria: 'api', expect: /criteria must be a plain object/ },
  { name: 'nameQuery is not a string', criteria: { nameQuery: 42 }, expect: /nameQuery must be a string, got number/ },
  { name: 'unknown edgePolicy', criteria: { nameQuery: 'a', edgePolicy: 'grey' }, expect: /edgePolicy must be 'hide' or 'dim', got 'grey'/ },
  { name: 'min greater than max', criteria: { metricKey: 'rps', min: 100, max: 10 }, expect: /min \(100\) must not be greater than max \(10\)/ },
  { name: 'range without metricKey', criteria: { min: 1 }, expect: /metricKey must be a non-empty string when min or max is set/ },
  { name: 'min is not a finite number', criteria: { metricKey: 'rps', min: NaN }, expect: /min must be a finite number/ },
  { name: 'min is not a number at all', criteria: { metricKey: 'rps', min: '10' }, expect: /min must be a finite number, got 10/ },
  { name: 'empty metricKey', criteria: { metricKey: '', min: 1 }, expect: /metricKey must be a non-empty string/ }
];

let passed = 0;
for (const c of cases) {
  assert.throws(
    () => gf.applyGraphFilter(graph, c.criteria),
    (err) => {
      assert.ok(err instanceof TypeError, `expected TypeError, got ${err.constructor.name}`);
      assert.ok(err.message.startsWith('Invalid graph filter criteria: '), `bad prefix: ${err.message}`);
      assert.ok(c.expect.test(err.message), `message "${err.message}" must match ${c.expect}`);
      return true;
    },
    `case "${c.name}" did not throw`
  );
  passed += 1;
  console.log(`ok - throws on ${c.name}`);
}

const frozen = { nodes: [{ name: 'a' }], connections: [] };
const snapshot = JSON.stringify(frozen);
try { gf.applyGraphFilter(frozen, { min: 1 }); } catch (e) { /* expected */ }
assert.strictEqual(JSON.stringify(frozen), snapshot, 'input graph mutated by failed validation');
passed += 1;
console.log('ok - failed validation leaves input graph untouched');

assert.deepStrictEqual(gf.validateCriteria({ nameQuery: 'x' }), []);
assert.strictEqual(gf.validateCriteria(null).length, 1);
passed += 1;
console.log('ok - validateCriteria exposes the same rules without throwing');

console.log(`\n${passed} failure-path checks passed`);
