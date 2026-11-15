# Video export verification

This directory contains the headless-Chromium (puppeteer) harness that verifies
the `Vizceral#exportVideo` feature. Everything is driven against two webpack
bundles built from the same source tree:

- `vizceral-baseline.js` — the pre-change sources, extracted from `git HEAD:src`
  by `snapshot-baseline.js` (so the comparison can never include the feature).
- `vizceral-current.js` — the working-tree sources with the export feature.

## Running

```sh
npm install
npm install --no-save puppeteer@21.11.0   # downloads a pinned Chromium
npm run test:baseline   # git archive HEAD:src -> test/baseline-src
npm run test:build      # webpack (Node API) -> test/build/vizceral-{baseline,current}.js
npm run test:verify     # headless run, writes JSON + media into ./artifacts
node test/stability-check.js              # repeated-export frame-loss check
```

## Files

- `fixture-data.js` — deterministic global traffic graph (four regions, volume
  waves); identical input for baseline and current runs.
- `browser-driver.js` — seeded PRNG (mulberry32) replacing `Math.random`,
  WebGL-context create/lose accounting, pixel and state hashing, live setup.
- `run-scenarios.js` — in-page scenarios: 10 s export, eight failure paths,
  mid-export cancellation, resource/memory sampling.
- `run-verification.js` — baseline-vs-current pixel/state consistency.
- `run.js` — orchestrates the suite, ffprobe media probing, artifact writing.
- `stability-check.js` — repeats exports and counts the frames muxed per file.

Artifacts land in `../artifacts/`: `baseline-comparison.json`,
`video-export-verification.json`, `resource-bounds.json`, `export-10s.webm`,
`export-10s-frame.png`, `live-page.png`.
