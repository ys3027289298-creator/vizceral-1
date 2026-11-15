/**
 * Deterministic traffic-data fixture used by every export verification run.
 *
 * The same fixture is fed to the baseline (pre-change) and current builds so
 * the before/after comparison uses identical inputs.
 */
(function attach(factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    window.FixtureData = factory();
  }
}(() => {
  const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1'];

  /**
   * Build one snapshot of the global traffic graph.
   *
   * @param {number} tick Monotonic simulation tick; drives deterministic volume waves.
   */
  function buildSnapshot(tick) {
    const nodes = REGIONS.map((region, index) => {
      const base = 1200 + index * 350;
      const wave = Math.round(450 * Math.sin((tick + index * 2) * 0.55));
      const normal = Math.max(120, base + wave);
      const danger = Math.max(0, Math.round(60 * Math.sin(tick * 0.31 + index)));
      const warning = Math.max(0, Math.round(40 * Math.cos(tick * 0.27 + index)));
      return {
        name: region,
        renderer: 'region',
        nodes: [],
        connections: [],
        maxVolume: 2600,
        updated: 1479010800000 + tick * 1000,
        volume: { normal: normal, warning: warning, danger: danger }
      };
    });

    const connections = [
      { source: 'us-east-1', target: 'us-west-2', metrics: { normal: 260, warning: 12 }, },
      { source: 'eu-west-1', target: 'us-east-1', metrics: { normal: 180, danger: 6 } },
      { source: 'ap-south-1', target: 'eu-west-1', metrics: { normal: 140 } }
    ].map((connection, index) => Object.assign({}, connection, {
      name: `${connection.source}--${connection.target}`,
      updated: 1479010800000 + tick * 1000,
      metrics: {
        normal: Math.max(40, connection.metrics.normal + Math.round(50 * Math.sin(tick * 0.4 + index))),
        warning: connection.metrics.warning || 0,
        danger: connection.metrics.danger || 0
      }
    }));

    return {
      name: 'traffic',
      renderer: 'global',
      maxVolume: 3200,
      updated: 1479010800000 + tick * 1000,
      nodes: nodes,
      connections: connections
    };
  }

  return {
    REGIONS: REGIONS,
    buildSnapshot: buildSnapshot
  };
}));
