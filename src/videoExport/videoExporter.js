/**
 *
 *  Copyright 2016 Netflix, Inc.
 *
 *     Licensed under the Apache License, Version 2.0 (the "License");
 *     you may not use this file except in compliance with the License.
 *     You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 *
 */
import { cloneDeep } from 'lodash';

import RendererUtils from '../rendererUtils';
import VideoExportError from './videoExportError';

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const MAX_FPS = 60;
const MAX_DURATION_SECONDS = 600;
const MAX_DIMENSION = 7680;
const WARMUP_FRAMES = 3;
const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
];

const failSuffix = VideoExportError.NO_OUTPUT_SUFFIX;

function fail (code, message) {
  return new VideoExportError(code, `Video export failed: ${message}${failSuffix}`);
}

function isPositiveFiniteNumber (value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validate and normalize the options passed to {@link Vizceral#exportVideo}.
 * Throws {@link VideoExportError} with code `INVALID_OPTIONS` on any bad value.
 */
function resolveOptions (options) {
  const settings = options || {};
  const fps = settings.fps === undefined ? DEFAULT_FPS : settings.fps;
  if (!Number.isFinite(fps) || fps < 1 || fps > MAX_FPS) {
    throw fail('INVALID_OPTIONS', `fps must be a number between 1 and ${MAX_FPS}; got ${fps}.`);
  }

  const { duration } = settings;
  if (!isPositiveFiniteNumber(duration) || duration > MAX_DURATION_SECONDS) {
    throw fail('INVALID_OPTIONS',
      `duration must be a positive number of seconds (max ${MAX_DURATION_SECONDS}); got ${duration}.`);
  }

  const width = settings.width === undefined ? DEFAULT_WIDTH : settings.width;
  const height = settings.height === undefined ? DEFAULT_HEIGHT : settings.height;
  if (!Number.isInteger(width) || width < 2 || width > MAX_DIMENSION
      || !Number.isInteger(height) || height < 2 || height > MAX_DIMENSION) {
    throw fail('INVALID_OPTIONS',
      `width and height must be integers between 2 and ${MAX_DIMENSION}; got ${width} x ${height}.`);
  }

  if (settings.mimeType !== undefined && typeof settings.mimeType !== 'string') {
    throw fail('INVALID_OPTIONS', 'mimeType must be a string when provided.');
  }

  if (settings.videoBitsPerSecond !== undefined
      && (!isPositiveFiniteNumber(settings.videoBitsPerSecond))) {
    throw fail('INVALID_OPTIONS',
      `videoBitsPerSecond must be a positive number when provided; got ${settings.videoBitsPerSecond}.`);
  }

  return {
    fps,
    duration,
    width,
    height,
    mimeType: settings.mimeType,
    videoBitsPerSecond: settings.videoBitsPerSecond
  };
}

/**
 * Pick a usable MIME type. An explicit, unsupported type fails with
 * `ENCODER_UNAVAILABLE`; otherwise the preference list is tried in order.
 */
function resolveMimeType (settings, adapters) {
  const { MediaRecorder, isTypeSupported } = adapters;
  if (!MediaRecorder || typeof MediaRecorder !== 'function') {
    throw fail('ENCODER_UNAVAILABLE',
      'the MediaRecorder API is not available in this browser, so no video encoder could be used.');
  }

  if (settings.mimeType !== undefined) {
    if (!isTypeSupported(settings.mimeType)) {
      throw fail('ENCODER_UNAVAILABLE',
        `the requested MIME type is not supported by this browser: ${settings.mimeType}.`);
    }
    return settings.mimeType;
  }

  const supported = PREFERRED_MIME_TYPES.filter(type => isTypeSupported(type));
  if (supported.length === 0) {
    throw fail('ENCODER_UNAVAILABLE',
      `no usable video encoder found. Tried MIME types: ${PREFERRED_MIME_TYPES.join(', ')}.`);
  }
  return supported[0];
}

function defaultAdapters () {
  return {
    createCanvas: () => document.createElement('canvas'),
    createMediaRecorder: (stream, recorderOptions) => new MediaRecorder(stream, recorderOptions),
    MediaRecorder: typeof MediaRecorder === 'function' ? MediaRecorder : undefined,
    isTypeSupported: type => typeof MediaRecorder === 'function'
      && typeof MediaRecorder.isTypeSupported === 'function'
      && MediaRecorder.isTypeSupported(type),
    wait: delay => new Promise(resolve => setTimeout(resolve, delay)),
    requestFrameAck: (track, timeoutMs) => new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          track.removeEventListener('ended', onEnded);
          reject(fail('ENCODER_FAILED',
            `timed out after ${timeoutMs}ms waiting for the canvas frame to be captured.`));
        }
      }, timeoutMs);
      function onEnded () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(fail('ENCODER_FAILED', 'the canvas video track ended before all frames were recorded.'));
        }
      }
      track.addEventListener('ended', onEnded);
      // The queued requestFrame() is serviced before the next animation frame.
      requestAnimationFrame(() => {
        // A second animation frame guarantees the queued canvas frame has been
        // pushed into the capture stream even under scheduler contention.
        requestAnimationFrame(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            track.removeEventListener('ended', onEnded);
            resolve();
          }
        });
      });
    }),
    waitUntil: targetTime => new Promise((resolve) => {
      const delay = Math.max(0, targetTime - performance.now());
      setTimeout(resolve, delay);
    })
  };
}

/**
 * Render a traffic-graph animation to an encoded video Blob without touching the
 * live Vizceral instance.
*
 * Rendering happens on a detached, offscreen canvas backed by a separate
 * WebGL context. The live renderer, camera, scene and current graph are never
 * mutated; only the shared {@link RendererUtils} singleton is temporarily
 * rebound around offscreen renders and restored immediately afterwards.
 *
 * @param {Vizceral} liveInstance The component whose data/view is exported.
 * @param {object} options See {@link Vizceral#exportVideo}.
 * @param {object} [adapters] Injectable browser primitives (used by tests).
 * @returns {{ promise: Promise, cancel: Function }}
 */
function createVideoExport (liveInstance, options, adapters) {
  const settings = resolveOptions(options);
  const env = Object.assign(defaultAdapters(), adapters || {});
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
  };

  const promise = (async () => {
    if (liveInstance.videoExportInProgress) {
      throw fail('EXPORT_IN_PROGRESS',
        'another export is already in progress for this Vizceral instance. '
        + 'Wait for it to settle or cancel it first.');
    }
    if (!liveInstance.trafficData || !liveInstance.trafficData.nodes) {
      throw fail('NO_DATA',
        'no traffic data has been loaded (updateData() has not been called).');
    }

    const mimeType = resolveMimeType(settings, env);
    liveInstance.videoExportInProgress = true;

    // Resources that need deterministic cleanup on every exit path.
    let exportCanvas;
    let exportInstance;
    let stream;
    let recorder;
    let recorderStopped = false;
    let offscreenContext;
    const chunks = [];
    const frameIntervalMs = 1000 / settings.fps;
    const totalFrames = Math.round(settings.fps * settings.duration);

    // Remember the live RendererUtils bindings so they can be restored.
    const savedRenderer = RendererUtils.renderer;
    const savedCamera = RendererUtils.camera;
    const savedScale = RendererUtils.scale;

    const restoreRendererUtils = () => {
      RendererUtils.setRenderer(savedRenderer);
      RendererUtils.setCamera(savedCamera);
      RendererUtils.setScale(savedScale);
    };

    const cleanup = () => {
      liveInstance.videoExportInProgress = false;
      restoreRendererUtils();
      if (recorder && recorder.state !== 'inactive' && !recorderStopped) {
        try { recorder.stop(); } catch (e) { /* already stopping */ }
      }
      if (stream) {
        stream.getTracks().forEach((track) => { try { track.stop(); } catch (e) { /* noop */ } });
      }
      if (exportInstance) {
        try {
          offscreenContext = exportInstance.renderer
            ? exportInstance.renderer.getContext() : offscreenContext;
          exportInstance.dispose();
        } catch (e) { /* noop */ }
      }
      if (offscreenContext && typeof offscreenContext.getExtension === 'function') {
        const loseExt = offscreenContext.getExtension('WEBGL_lose_context');
        if (loseExt) {
          try { loseExt.loseContext(); } catch (e) { /* noop */ }
        }
      }
    };

    try {
      // --- Build an isolated renderer on a detached canvas -----------------
      exportCanvas = env.createCanvas(settings.width, settings.height);
      exportCanvas.width = settings.width;
      exportCanvas.height = settings.height;

      // eslint-disable-next-line no-use-before-define
      exportInstance = new liveInstance.constructor(exportCanvas);
      offscreenContext = exportInstance.renderer.getContext();
      exportInstance.setSize(settings.width, settings.height);
      exportInstance.updateData(cloneDeep(liveInstance.trafficData));
      if (liveInstance.currentGraph && liveInstance.currentGraph.graphIndex) {
        exportInstance.setView(liveInstance.currentGraph.graphIndex.slice());
      }

      // Warm up the offscreen graph so textures/geometry are allocated before
      // the recorder starts; these frames are not part of the video.
      for (let warmFrame = 0; warmFrame < WARMUP_FRAMES; warmFrame += 1) {
        RendererUtils.setRenderer(exportInstance.renderer);
        RendererUtils.setCamera(exportInstance.camera);
        exportInstance.render(warmFrame);
      }
      restoreRendererUtils();

      if (cancelled) {
        throw fail('CANCELLED', `cancelled by caller before encoding started (0 of ${totalFrames} frames).`);
      }

      // --- Start the encoder on the offscreen canvas stream ----------------
      if (typeof exportCanvas.captureStream !== 'function') {
        throw fail('ENCODER_UNAVAILABLE',
          'the HTMLCanvasElement.captureStream API is not available in this browser.');
      }
      stream = exportCanvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      if (!track || typeof track.requestFrame !== 'function') {
        throw fail('ENCODER_UNAVAILABLE',
          'canvas.captureStream(0) did not provide a requestable video track in this browser.');
      }

      const recorderOptions = { mimeType };
      if (settings.videoBitsPerSecond) {
        recorderOptions.videoBitsPerSecond = settings.videoBitsPerSecond;
      }
      recorder = env.createMediaRecorder(stream, recorderOptions);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) { chunks.push(event.data); }
      };

      const encoderFailure = new Promise((resolve, reject) => {
        recorder.onerror = (event) => {
          const detail = event && event.error && event.error.message
            ? event.error.message : 'unknown encoder error';
          reject(fail('ENCODER_FAILED', `the encoder reported an error: ${detail}.`));
        };
        recorder.onstop = () => resolve();
      });
      encoderFailure.catch(() => undefined); // rejection is also consumed via Promise.race
      const throwIfEncoderFailed = async () => {
        try {
          await encoderFailure;
        } catch (error) {
          throw error;
        }
        throw fail('ENCODER_FAILED', 'the encoder stopped before all frames were recorded.');
      };

      recorder.start();

      // --- Render one frame at a time on the export timeline ---------------
      let framesRendered = 0;
      const frameAckTimeoutMs = Math.max(1000, frameIntervalMs * 10);
      const startWallTime = performance.now();
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
        if (cancelled) {
          recorderStopped = true;
          try { recorder.stop(); } catch (e) { /* noop */ }
          // Sequential frame pipeline: waiting for the recorder is intentional.
          // eslint-disable-next-line no-await-in-loop
          await Promise.race([
            encoderFailure.catch(() => undefined),
            env.wait(frameIntervalMs)
          ]);
          throw fail('CANCELLED',
            `cancelled by caller after ${framesRendered} frame(s).`);
        }

        const exportTime = frameIndex * frameIntervalMs;
        RendererUtils.setRenderer(exportInstance.renderer);
        RendererUtils.setCamera(exportInstance.camera);
        exportInstance.render(exportTime, { suppressTweenUpdate: true });
        restoreRendererUtils();
        track.requestFrame();
        framesRendered += 1;

        // Confirm the current frame was pushed into the capture stream before
        // rendering the next one, then wait out the remainder of the frame
        // interval. Awaiting the acknowledgement first prevents frame loss
        // under scheduler contention; the deadline keeps the encoded timeline
        // aligned with the requested frame rate.
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([
          env.requestFrameAck(track, frameAckTimeoutMs),
          throwIfEncoderFailed()
        ]);
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([
          env.waitUntil(startWallTime + ((frameIndex + 1) * frameIntervalMs)),
          throwIfEncoderFailed()
        ]);
      }

      // --- Flush the encoder and collect the blob --------------------------
      const blob = await new Promise((resolve, reject) => {
        recorder.onstop = () => {
          const output = new Blob(chunks, { type: mimeType.split(';')[0] });
          if (!output || output.size === 0) {
            reject(fail('ENCODER_FAILED', 'the encoder produced an empty output.'));
            return;
          }
          resolve(output);
        };
        recorder.onerror = (event) => {
          const detail = event && event.error && event.error.message
            ? event.error.message : 'unknown encoder error';
          reject(fail('ENCODER_FAILED', `the encoder reported an error: ${detail}.`));
        };
        recorderStopped = true;
        recorder.stop();
      });

      return {
        blob,
        mimeType,
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        duration: settings.duration,
        frames: totalFrames,
        framesRendered
      };
    } catch (error) {
      // Never leak a partial/empty output: callers only get the rejection.
      if (error instanceof VideoExportError) {
        throw error;
      }
      throw fail('ENCODER_FAILED',
        `the export pipeline failed: ${error && error.message ? error.message : error}.`);
    } finally {
      // Success, failure and cancellation all run the same deterministic
      // cleanup so no temporary resource can outlive the export.
      cleanup();
    }
  })();

  return { promise, cancel };
}

export default createVideoExport;
