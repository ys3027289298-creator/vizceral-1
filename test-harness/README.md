# Zoom/pan verification harness

Headless, dependency-isolated test harness for the wheel-zoom / drag-pan /
double-click-reset feature. It does not modify the parent project's
`package.json` or `node_modules`.

## Files

- `env.js` — jsdom + headless WebGL (`gl`) environment, webpack-loader stubs,
  Babel transpilation of the parent `src/`.
- `factory.js` — creates a fully rendered Vizceral instance from `sampleData.js`.
- `lib.js` — event dispatch and assertion helpers.
- `test-zoom-hit.js` — zoom bounds, cursor-anchored zoom, pan, and the required
  0.5× / 1× / 4× node-picking proofs.
- `test-failure-paths.js` — invalid inputs and disruptive event sequences.
- `test-resources.js` — scene-graph, listener and heap upper bounds.
- `test-existing-interactions.js` — regression coverage for clicks, hover,
  double-click drill-down, node dragging, search and highlight.
- `test-parity.js` — before/after snapshots with full-frame pixel hash and
  hit-test diffing.
- `run-all.sh` — runs every suite and regenerates the pristine baseline from
  `git archive HEAD`.

## Setup

```bash
cd test-harness
npm install --no-audit --no-fund --ignore-scripts jsdom@16 gl@6 three@0.106.2 \
  babel-register@6 babel-core@6 babel-preset-env@1 babel-plugin-lodash@3
```

`gl` is a native addon. On modern GCC its bundled ANGLE needs
`#include <cstdint>` in `angle/src/common/angleutils.h`, and it must compile
against the system Node ABI, e.g. on Ubuntu/Debian:

```bash
cd node_modules/gl
# 1) add `#include <cstdint>` to angle/src/common/angleutils.h
# 2) build against system headers (Ubuntu's node uses ABI 109)
mkdir -p /tmp/sysnode/include && ln -sfn /usr/include/node /tmp/sysnode/include/node
ln -sfn /usr/include/node/common.gypi /tmp/sysnode/common.gypi
ln -sfn /usr/include/node/config.gypi /tmp/sysnode/config.gypi
npx node-gyp rebuild --nodedir=/tmp/sysnode
```

## Run

```bash
bash run-all.sh
```

Snapshots are written to `../artifacts/snapshot-{before,after}.json`.
Set `VIZCERAL_SRC` to point any run at an alternative source tree (used by the
parity suite to load the pristine baseline).
