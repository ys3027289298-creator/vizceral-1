// Builds artifacts/comparison.json: before/after comparison on the SAME
// input, distilled from the verification run.
// Run: node test/comparison.js
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(REPO, 'artifacts', 'verify-legacy.json'), 'utf8'));

const visibleOf = s => ({
  nodesVisible: s.nodes.filter(n => n.visible).length,
  nodesTotal: s.nodes.length,
  connectionsVisible: s.connections.filter(c => c.visible).length,
  connectionsTotal: s.connections.length
});

const statuses = {};
for (const [label, status] of report.filterStatuses) {
  statuses[label] = status;
}

const comparison = {
  input: 'deterministic datasets D1 (6 nodes/6 connections) + D2 update, see test/verifyLegacy.js',
  before: {
    description: 'baseline commit 85af133, no filter feature',
    snapshotSha256: report.legacyBitwise.baselineSha256,
    visible: visibleOf(report.snapshots.baselineLegacy)
  },
  after: {
    filterOff: {
      description: 'current code, graph filter not used',
      snapshotSha256: report.legacyBitwise.currentSha256,
      bitwiseIdenticalToBaseline: report.legacyBitwise.identical
    },
    filterOn: {
      hide: statuses.hide,
      dim: statuses.dim,
      rangeDim: statuses.range,
      noMatch: statuses.empty,
      cleared: statuses.cleared,
      invalidCriteria: statuses.invalidThrows,
      layoutInputsIdenticalToFilterOff: report.layoutZeroChange.layoutInputsIdentical,
      nodePositionsIdenticalToFilterOff: report.layoutZeroChange.nodePositionsIdentical
    }
  }
};

const out = path.join(REPO, 'artifacts', 'comparison.json');
fs.writeFileSync(out, JSON.stringify(comparison, null, 2));
console.log(JSON.stringify(comparison, null, 2));
