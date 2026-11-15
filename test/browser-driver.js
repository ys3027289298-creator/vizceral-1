/* global window, document, Vizceral, FixtureData */
/**
 * In-browser verification driver. Exposes window.driver with deterministic
 * primitives (seeded PRNG, GL-context accounting, pixel/state hashing) and the
 * scenarios exercised by run-verification.js.
 */
(function () {
  // UMD bundle exposes the ES module namespace; unwrap the default export.
  function ensureUnwrapped() {
    if (window.Vizceral && window.Vizceral.default) {
      window.Vizceral = window.Vizceral.default;
    }
  }
  const driver = {};
  driver.ensureUnwrapped = ensureUnwrapped;

  // --- Deterministic PRNG (mulberry32) -------------------------------------
  function mulberry32(seed) {
    let state = seed >>> 0;
    return function random() {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  driver.installDeterministicRandom = function installDeterministicRandom(seed) {
    window.Math.random = mulberry32(seed || 20261115);
  };

  // --- GL context accounting -----------------------------------------------
  driver.glAccount = { created: 0, lost: 0 };
  const originalGetContext = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
    const context = originalGetContext.apply(this, [type, ...args]);
    if ((type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2')
        && context && !this.__vizceralGlCounted) {
      this.__vizceralGlCounted = true;
      driver.glAccount.created += 1;
    }
    return context;
  };
  const originalGetExtension = window.WebGLRenderingContext.prototype.getExtension;
  window.WebGLRenderingContext.prototype.getExtension = function patched(name) {
    const ext = originalGetExtension.call(this, name);
    if (name === 'WEBGL_lose_context' && ext) {
      const originalLose = ext.loseContext;
      ext.loseContext = function loseContext(...loseArgs) {
        if (!this.__vizceralLost) {
          this.__vizceralLost = true;
          driver.glAccount.lost += 1;
        }
        return originalLose.apply(this, loseArgs);
      };
    }
    return ext;
  };
  // --- Hashing (FNV-1a over bytes, hex) ------------------------------------
  driver.hashBytes = function hashBytes(bytes) {
    let hash = 0x811C9DC5;
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // Extend to 64 hex chars via two independent passes for collision resistance.
    let hash2 = 0x1000193;
    for (let j = 0; j < bytes.length; j += 1) {
      hash2 ^= bytes[j];
      hash2 = Math.imul(hash2, 0x01000193) >>> 0;
      hash2 ^= (j & 0xFF);
    }
    const h1 = (`00000000${hash.toString(16)}`).slice(-8);
    const h2 = (`00000000${hash2.toString(16)}`).slice(-8);
    let out = '';
    for (let k = 0; k < 4; k += 1) { out += h1 + h2; }
    return out;
  };

  driver.snapshotPixels = function snapshotPixels(vizceral, width, height) {
    const gl = vizceral.renderer.getContext();
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };

  driver.snapshotState = function snapshotState(vizceral) {
    const graph = vizceral.currentGraph;
    const particleSummary = FixtureData.REGIONS.map((name) => {
      const node = graph && graph.nodes ? graph.nodes[name] : undefined;
      const incoming = node && node.incomingVolumeTotal !== undefined
        ? node.incomingVolumeTotal : 0;
      const outgoing = node && node.outgoingVolumeTotal !== undefined
        ? node.outgoingVolumeTotal : 0;
      return [name, incoming, outgoing];
    });
    return JSON.stringify({
      view: graph ? graph.graphIndex : null,
      width: vizceral.width,
      height: vizceral.height,
      particle: particleSummary
    });
  };

  driver.domCanvasCount = function domCanvasCount() {
    return document.querySelectorAll('canvas').length;
  };

  // --- Construction helpers ------------------------------------------------
  driver.createLive = function createLive(width, height) {
    ensureUnwrapped();
    const canvas = document.createElement('canvas');
    canvas.setAttribute('id', 'live-canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // Keep the layout box at the requested size so baseline and current builds
    // render at identical dimensions regardless of the browser viewport.
    canvas.style.display = 'inline-block';
    canvas.style.position = 'absolute';
    document.body.appendChild(canvas);
    const vizceral = new Vizceral(canvas);
    // The constructor forces width/height:100% styles; pin the layout box again
    // so auto-resize keeps the requested dimensions regardless of viewport.
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    vizceral.setSize(width, height);
    return vizceral;
  };

  driver.feed = function feed(vizceral, tick) {
    vizceral.updateData(FixtureData.buildSnapshot(tick));
    vizceral.setView([]);
  };

  // Drive `count` deterministic frames on the live instance at fixed timestamps.
  driver.stepFrames = function stepFrames(vizceral, timestamps) {
    timestamps.forEach((time) => {
      vizceral.render(time);
    });
  };

  driver.warmup = function warmup(vizceral, count) {
    const timestamps = [];
    for (let i = 1; i <= count; i += 1) { timestamps.push(i * (1000 / 60)); }
    driver.stepFrames(vizceral, timestamps);
  };

  window.driver = driver;
}());
