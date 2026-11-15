// Deterministic traffic data used for every test run (before/after comparison).
function service (name, x, y) {
  return {
    name,
    renderer: 'region',
    position: { x, y },
    maxVolume: 1000,
    nodes: [
      { name: `${name}-svc-a`, renderer: 'focusedChild' },
      { name: `${name}-svc-b`, renderer: 'focusedChild' }
    ],
    connections: {
      [`${name}-svc-a:${name}-svc-b`]: { status: 1, metrics: { normal: 120, danger: 0, warning: 0 } }
    },
    class: 'normal',
    nodes_volume: []
  };
}

const trafficData = {
  renderer: 'global',
  name: 'world',
  maxVolume: 1500,
  entryNode: 'INTERNET',
  nodes: [
    { name: 'INTERNET' },
    service('us-east-1', -250, 0),
    service('us-west-2', 250, 0),
    service('eu-west-1', 0, 260),
    service('ap-south-1', 0, -260)
  ],
  connections: [
    { source: 'INTERNET', target: 'us-east-1', metrics: { normal: 600, danger: 20, warning: 10 } },
    { source: 'INTERNET', target: 'us-west-2', metrics: { normal: 450, danger: 0, warning: 5 } },
    { source: 'INTERNET', target: 'eu-west-1', metrics: { normal: 300, danger: 0, warning: 0 } },
    { source: 'INTERNET', target: 'ap-south-1', metrics: { normal: 180, danger: 0, warning: 0 } },
    { source: 'us-east-1', target: 'us-west-2', metrics: { normal: 90, danger: 0, warning: 0 } }
  ]
};

module.exports = trafficData;
