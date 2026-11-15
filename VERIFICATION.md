# Video export — verification report

Feature: `Vizceral#exportVideo(options)` renders the current traffic graph to an
encoded video Blob on a detached, offscreen canvas, without touching the live
page. Cancellation, explicit encoder errors and deterministic resource cleanup
are covered. All numbers below are produced by the headless-Chromium harness in
`test/`; the machine-readable sources are in `artifacts/`.

## 1. Ten-second clip metrics

Source: `artifacts/video-export-verification.json` (`checks.export10s`) and
`ffprobe`/file-system measurements of `artifacts/export-10s.webm`.

| Metric | Value |
| --- | --- |
| Container / codec | WebM / VP9 (`video/webm;codecs=vp9`) |
| Resolution | 1280 x 720 |
| Configured frame rate | 30 fps |
| Requested duration | 10000 ms (10 s) |
| Frames rendered | 300 (`fps * duration`) |
| Frames in container (`ffprobe -count_frames`) | 300 |
| Measured media duration | 9.965 s (last packet PTS 9.932 s + one frame) |
| Wall-clock export time | 10071 ms (real-time paced) |
| File size | 376977 bytes (~368 KiB) |
| SHA-256 | `19628363c25f1c2b0dfd55f80ef13fb38bdb8baf04ab56efa3ad0a67d9eab6e4` |

A decoded still is stored at `artifacts/export-10s-frame.png`. Chrome's
MediaRecorder does not write a container-level Duration element; duration is
therefore reported from packet timestamps. The same run also produced a 2 s,
640 x 360 clip: 60 frames, 63874 bytes (`checks.shortExport`).

## 2. Before/after comparison on identical input

Source: `artifacts/baseline-comparison.json`. Both bundles are built from the
same fixture (`test/fixture-data.js`), the same mulberry32 PRNG seed and the
same 120-frame warm-up. Because Vizceral particles advance per `render()` call
rather than wall-clock time, probes are frame counts (240, 300, 420, 660, 838)
with monotonically increasing synthetic timestamps.

| Probe frame | Baseline hash == current hash | Simulation state identical | Different channels |
| --- | --- | --- | --- |
| 240 | yes | yes | 0 / 921600 |
| 300 | yes | yes | 0 / 921600 |
| 420 | yes | yes | 0 / 921600 |
| 660 | yes | yes | 0 / 921600 |
| 838 | yes | yes | 0 / 921600 |

`allFramesBitwiseIdentical: true`, `allSimulationStateBitwiseIdentical: true`,
maximum channel difference 0. The feature adds new modules only; the render
path is byte-for-byte unchanged when no export is running.

## 3. Failure paths — reproduction and expected errors

Source: `artifacts/video-export-verification.json` (`checks.failures`). Every
case rejects with a `VideoExportError` carrying a stable `code`; no output file
is ever created on a failure. Reproduce with `npm run test:verify` (scenario
`runFailures` in `test/run-scenarios.js`).

| Label | Reproduction | Expected `code` |
| --- | --- | --- |
| f1-mediarecorder-missing | delete `window.MediaRecorder`, then `exportVideo({duration:1})` | `ENCODER_UNAVAILABLE` |
| f2-no-mime | stub `MediaRecorder.isTypeSupported` to always return false | `ENCODER_UNAVAILABLE` |
| f3-bad-mime | pass `mimeType: 'video/nonsense-codec'` | `ENCODER_UNAVAILABLE` |
| f4a-bad-fps | pass `fps: 0` | `INVALID_OPTIONS` |
| f4b-bad-duration | pass `duration: -5` | `INVALID_OPTIONS` |
| f5-no-data | call export on an instance with no `updateData()` | `NO_DATA` |
| f6-concurrent | start an export, then start a second one on the same instance | `EXPORT_IN_PROGRESS` |
| f7-encoder-error | inject a recorder whose `onerror` fires 30 ms after start | `ENCODER_FAILED` |

Every message ends with "No output file was produced." An encoder that returns
zero bytes is additionally rejected as `ENCODER_FAILED` ("the encoder produced
an empty output"), so an unavailable encoder can never surface as an empty
file. After all eight failures the page still has exactly one DOM canvas and
the transient WebGL contexts were lost again (`created: 5, lost: 4` relative to
the live context).

## 4. Resource / memory upper bounds

Source: `artifacts/resource-bounds.json`, sampled before, mid-export, after and
after a second consecutive export of a 640 x 360, 5 s (150-frame) clip.

- Detached export canvas: exactly **1** per export; the live DOM canvas count
  stays at 1 throughout (`maxSimultaneousCanvases: 1`).
- Live WebGL contexts: at most **2** (the live context plus one offscreen
  context); each export's context is released via
  `WEBGL_lose_context.loseContext()` and returns to 1 after settling.
- Single-frame RGBA buffer bound: `width * height * 4` — 921600 bytes
  (0.88 MiB) at 640 x 360; 3686400 bytes (3.52 MiB) at 1280 x 720. Frames are
  streamed to the recorder, never buffered: `retainedRawFrameBuffers: 0`.
- Encoder chunks are held only until the Blob is assembled
  (`encoderChunksRetainedAfterSettle: 0`); peak observed JS heap was 27.02 MiB.
- All temporary resources (recorder, media tracks, offscreen renderer and
  context) are released in a single `finally` cleanup on success, failure and
  cancellation.

## 5. Mid-export cancellation

Source: `checks.cancellation`. A 5 s export is cancelled ~128 frames in.

- The promise rejects with `VideoExportError` code `CANCELLED`
  ("cancelled by caller after 128 frame(s). No output file was produced.") and
  settles exactly once.
- Live pixel hash and serialized simulation state are identical before and
  after (`pixelsUnchanged`, `stateUnchanged`, `domCanvasUnchanged` all true);
  the live instance still renders afterwards (`liveStillRenders: true`).
- GL accounting returns to the single live context (`created`/`lost` differ by
  one), proving the offscreen context was released.

## Reproduce

```sh
npm run test:baseline && npm run test:build && npm run test:verify
node test/stability-check.js   # 4/4 runs mux exactly 60/60 frames
```

The final `allOk` gate in `artifacts/video-export-verification.json` is `true`
only when consistency, live-state invariance, every failure code, cancellation
settlement and pixel/state preservation all pass together.
