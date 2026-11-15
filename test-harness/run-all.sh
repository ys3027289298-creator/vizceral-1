#!/usr/bin/env bash
# Runs the complete zoom/pan verification suite.
set -euo pipefail
cd "$(dirname "$0")"

GC_FLAG=""
if node -e "process.exit(process.version.indexOf('v18') === 0 ? 0 : 1)"; then
  GC_FLAG="--expose-gc"
fi

echo "############################################################"
echo "# 1. Zoom / pan / hit-detection (incl. 0.5x / 1x / 4x picks)"
echo "############################################################"
node $GC_FLAG test-zoom-hit.js

echo
echo "############################################################"
echo "# 2. Failure paths"
echo "############################################################"
node $GC_FLAG test-failure-paths.js

echo
echo "############################################################"
echo "# 3. Resource / memory upper bounds"
echo "############################################################"
node $GC_FLAG test-resources.js

echo
echo "############################################################"
echo "# 4. Pre-existing interaction regression"
echo "############################################################"
node $GC_FLAG test-existing-interactions.js

echo
echo "############################################################"
echo "# 5. Before/after bit-level parity (same input)"
echo "############################################################"
BASELINE_DIR="$(mktemp -d)"
git -C .. archive HEAD src | tar -x -C "$BASELINE_DIR"
trap 'rm -rf "$BASELINE_DIR"' EXIT
NODE_PATH="$(cd .. && pwd)/node_modules" \
  VIZCERAL_SRC="$BASELINE_DIR/src" VIZCERAL_LABEL=before \
  node $GC_FLAG test-parity.js
VIZCERAL_LABEL=after node $GC_FLAG test-parity.js
