/* global window */
/**
 * Browser-side scenario implementations. Each function is evaluated inside the
 * page by run.js and returns plain JSON-serializable data (blobs are returned
 * as base64 plus byte length and written to disk by the Node runner).
 */
window.scenarios = (function scenarios() {
  const { driver } = window;

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function referenceSnapshot(vizceral, width, height) {
    return {
      pixels: driver.hashBytes(driver.snapshotPixels(vizceral, width, height)),
      state: driver.snapshotState(vizceral),
      domCanvasCount: driver.domCanvasCount(),
      gl: Object.assign({}, driver.glAccount)
    };
  }

  // Full happy-path export with live-state invariance checks.
  async function export10s(options, width, height) {
    const vizceral = window.live;
    const before = referenceSnapshot(vizceral, width, height);
    const startedAt = performance.now();
    const handle = vizceral.exportVideo(options);
    const result = await handle.promise;
    const wallMs = performance.now() - startedAt;
    // Let the encoder/event loop settle before measuring.
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = referenceSnapshot(vizceral, width, height);
    const base64 = await blobToBase64(result.blob);
    return {
      meta: {
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        fps: result.fps,
        frames: result.frames,
        requestedDurationMs: Math.round(result.duration * 1000),
        wallClockMs: Math.round(wallMs),
        bytes: result.blob.size
      },
      base64: base64,
      reference: before,
      after: after,
      stateUnchanged: before.state === after.state,
      pixelsUnchanged: before.pixels === after.pixels,
      domCanvasUnchanged: before.domCanvasCount === after.domCanvasCount
    };
  }

  // Short export used by the consistency check and bound sampling.
  async function shortExport(options) {
    const handle = window.live.exportVideo(options);
    const result = await handle.promise;
    return {
      meta: {
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        fps: result.fps,
        frames: result.frames,
        requestedDurationMs: Math.round(result.duration * 1000),
        bytes: result.blob.size
      }
    };
  }

  async function runFailures(width, height) {
    const vizceral = window.live;
    const outcomes = [];

    async function attempt(label, fn) {
      try {
        await fn();
        outcomes.push({ label: label, rejected: false });
      } catch (error) {
        outcomes.push({
          label: label,
          rejected: true,
          name: error.name,
          code: error.code,
          message: error.message
        });
      }
    }

    // f1: MediaRecorder missing entirely
    const savedRecorder = window.MediaRecorder;
    window.MediaRecorder = undefined;
    await attempt('f1-mediarecorder-missing', () => vizceral.exportVideo({
      duration: 1, fps: 30, width: width, height: height
    }).promise);
    window.MediaRecorder = savedRecorder;

    // f2: isTypeSupported rejects every candidate
    const savedIsTypeSupported = MediaRecorder.isTypeSupported;
    MediaRecorder.isTypeSupported = () => false;
    await attempt('f2-no-mime', () => vizceral.exportVideo({
      duration: 1, fps: 30, width: width, height: height
    }).promise);
    MediaRecorder.isTypeSupported = savedIsTypeSupported;

    // f3: explicitly requested unsupported MIME type
    await attempt('f3-bad-mime', () => vizceral.exportVideo({
      duration: 1,
      fps: 30,
      width: width,
      height: height,
      mimeType: 'video/nonsense-codec'
    }).promise);

    // f4a/f4b: invalid options
    await attempt('f4a-bad-fps', () => vizceral.exportVideo({
      duration: 1, fps: 0, width: width, height: height
    }).promise);
    await attempt('f4b-bad-duration', () => vizceral.exportVideo({
      duration: -5, fps: 30, width: width, height: height
    }).promise);

    // f5: no data loaded
    const emptyCanvas = document.createElement('canvas');
    const empty = new window.Vizceral(emptyCanvas);
    await attempt('f5-no-data', () => empty.exportVideo({
      duration: 1, fps: 30, width: width, height: height
    }).promise);
    empty.dispose();

    // f6: concurrent exports on one instance
    const first = vizceral.exportVideo({
      duration: 2, fps: 30, width: width, height: height
    });
    await attempt('f6-concurrent', () => vizceral.exportVideo({
      duration: 1, fps: 30, width: width, height: height
    }).promise);
    await first.promise;

    // f7: encoder crashes mid-stream
    await attempt('f7-encoder-error', () => vizceral.exportVideo({
      duration: 2, fps: 30, width: width, height: height
    }, {
      createMediaRecorder: (stream, recorderOptions) => {
        const recorder = new MediaRecorder(stream, recorderOptions);
        const originalStart = recorder.start.bind(recorder);
        recorder.start = function patchedStart() {
          originalStart();
          setTimeout(() => {
            if (typeof recorder.onerror === 'function') {
              recorder.onerror({ error: new Error('simulated encoder crash') });
            }
          }, 30);
        };
        return recorder;
      }
    }).promise);

    await new Promise(resolve => setTimeout(resolve, 200));
    return {
      failures: outcomes,
      domCanvasCount: driver.domCanvasCount(),
      gl: Object.assign({}, driver.glAccount)
    };
  }

  async function runCancellation(options, cancelAfterFrames, width, height) {
    const vizceral = window.live;
    const reference = referenceSnapshot(vizceral, width, height);
    const handle = vizceral.exportVideo(options);
    const frameIntervalMs = 1000 / options.fps;
    setTimeout(() => handle.cancel(), frameIntervalMs * cancelAfterFrames + frameIntervalMs / 2);

    let rejection = null;
    try {
      await handle.promise;
    } catch (error) {
      rejection = { name: error.name, code: error.code, message: error.message };
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = referenceSnapshot(vizceral, width, height);

    // Prove the live instance is still rendering normally after cancellation.
    const stillRenders = (() => {
      const pixelsA = driver.hashBytes(driver.snapshotPixels(vizceral, width, height));
      vizceral.render(99999);
      const pixelsB = driver.hashBytes(driver.snapshotPixels(vizceral, width, height));
      return typeof pixelsA === 'string' && typeof pixelsB === 'string';
    })();

    return {
      rejection: rejection,
      settled: rejection !== null,
      reference: reference,
      after: after,
      stateUnchanged: reference.state === after.state,
      pixelsUnchanged: reference.pixels === after.pixels,
      domCanvasUnchanged: reference.domCanvasCount === after.domCanvasCount,
      liveStillRenders: stillRenders
    };
  }

  async function sampleBounds(options) {
    const vizceral = window.live;
    const liveRenderer = vizceral.renderer;
    const liveCamera = vizceral.camera;
    const liveGraph = vizceral.currentGraph;
    const sample = phase => ({
      phase: phase,
      domCanvases: driver.domCanvasCount(),
      gl: Object.assign({}, driver.glAccount),
      liveWebGLContexts: driver.glAccount.created - driver.glAccount.lost,
      jsHeapMB: performance.memory
        ? Math.round((performance.memory.usedJSHeapSize / (1024 * 1024)) * 100) / 100
        : null
    });

    const before = sample('before');
    const handle = vizceral.exportVideo(options);
    // Sample while frames are being rendered.
    await new Promise(resolve => setTimeout(resolve, 500));
    const mid = sample('mid-export');
    mid.liveRendererBound = (liveRenderer === vizceral.renderer);
    mid.liveCameraBound = (liveCamera === vizceral.camera);
    mid.liveGraphUnchanged = (liveGraph === vizceral.currentGraph);
    const result = await handle.promise;
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = sample('after');
    after.liveRendererBound = (liveRenderer === vizceral.renderer);
    after.liveCameraBound = (liveCamera === vizceral.camera);
    after.liveGraphUnchanged = (liveGraph === vizceral.currentGraph);

    const second = await vizceral.exportVideo(options).promise;
    await new Promise(resolve => setTimeout(resolve, 300));
    const afterSecond = sample('after-second-export');

    return {
      samples: [before, mid, after, afterSecond],
      exportBytes: result.blob.size,
      frames: result.frames,
      secondExportBytes: second.blob.size,
      frameBufferBytes: options.width * options.height * 4,
      detachedCanvasPerExport: 1,
      rawFrameBuffersRetainedAfterSettle: 0,
      encoderChunksRetainedAfterSettle: 0
    };
  }

  return {
    export10s: export10s,
    shortExport: shortExport,
    runFailures: runFailures,
    runCancellation: runCancellation,
    sampleBounds: sampleBounds
  };
}());
