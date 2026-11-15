const path = require('path');
const { JSDOM } = require('jsdom');
const createGL = require('gl');

// VIZCERAL_SRC points at either the modified working-tree sources or the
// pristine baseline copy, enabling before/after runs with identical inputs.
const SRC_ROOT = process.env.VIZCERAL_SRC
  ? path.resolve(process.env.VIZCERAL_SRC)
  : path.resolve(__dirname, '..', 'src');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="host" style="width:1280px;height:800px"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
});

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
global.Event = dom.window.Event;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);
global.cancelAnimationFrame = id => clearTimeout(id);
if (!global.performance) global.performance = { now: () => Date.now() };
global.__DEBUG__ = true;
global.__HIDE_DATA__ = false;
global.Image = class Image {
  set src (value) {
    this._src = value;
    // Simulate asynchronous decode of an in-memory data URL.
    if (typeof value === 'string' && value.indexOf('data:') === 0) {
      setTimeout(() => {
        this.naturalWidth = this.width || 1;
        this.naturalHeight = this.height || 1;
        if (typeof this.onload === 'function') this.onload({ target: this });
      }, 0);
    } else if (typeof this.onerror === 'function') {
      setTimeout(() => this.onerror(new Error('headless image load unsupported')), 0);
    }
  }
  get src () { return this._src; }
};

global.HTMLCanvasElement.prototype.getContext = function getContext (type, attrs) {
  if (String(type).indexOf('webgl') === 0 || type === 'experimental-webgl') {
    if (!this._glContext) {
      this._glContext = createGL(this.width || 300, this.height || 150, Object.assign({ preserveDrawingBuffer: true }, attrs));
      this._glContext.canvas = this;
      patchHeadlessGL(this._glContext);
    }
    return this._glContext;
  }
  if (type === '2d') {
    if (!this._ctx2d) this._ctx2d = createStub2DContext();
    return this._ctx2d;
  }
  return null;
};

// The headless ANGLE build treats the identifier `texture` as a reserved
// builtin, while real WebGL 1 browsers accept it as a uniform name. Rewrite the
// particle shader's uniform at the GL boundary (test harness only; app source
// is untouched).
function patchHeadlessGL (gl) {
  const originalShaderSource = gl.shaderSource;
  gl.shaderSource = function shaderSource (shader, source) {
    const patched = String(source)
      .replace(/uniform sampler2D texture;/g, 'uniform sampler2D particleTex;')
      .replace(/texture2D\( texture,/g, 'texture2D( particleTex,');
    return originalShaderSource.call(this, shader, patched);
  };
}

function createStub2DContext () {
  const ctx = {
    canvas: null,
    measureText: text => ({ width: String(text).length * 8 })
  };
  const noop = () => {};
  ['arc', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip', 'closePath', 'createLinearGradient',
    'createRadialGradient', 'drawImage', 'ellipse', 'fill', 'fillRect', 'fillText', 'lineTo',
    'moveTo', 'putImageData', 'quadraticCurveTo', 'rect', 'restore', 'rotate', 'save', 'scale',
    'setLineDash', 'stroke', 'strokeRect', 'strokeText', 'transform', 'translate', 'drawFocusIfNeeded'].forEach((method) => {
    ctx[method] = noop;
  });
  const gradient = { addColorStop: noop };
  ctx.createLinearGradient = () => gradient;
  ctx.createRadialGradient = () => gradient;
  ctx.createPattern = () => ({});
  ctx.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  ctx.createImageData = w => ({ data: new Uint8ClampedArray(w * 4), width: w, height: 1 });
  return ctx;
}

// Label textures create offscreen canvases without explicit sizing; give them
// a sane default so headless GL never receives zero/huge allocations.
const defaultCanvasWidth = 1024;
const defaultCanvasHeight = 256;
dom.window.HTMLCanvasElement.prototype.__defineSetter__('width', function (value) {
  this._stubWidth = value;
});
dom.window.HTMLCanvasElement.prototype.__defineGetter__('width', function () {
  return this._stubWidth === undefined ? defaultCanvasWidth : this._stubWidth;
});
dom.window.HTMLCanvasElement.prototype.__defineSetter__('height', function (value) {
  this._stubHeight = value;
});
dom.window.HTMLCanvasElement.prototype.__defineGetter__('height', function () {
  return this._stubHeight === undefined ? defaultCanvasHeight : this._stubHeight;
});

// Transpile the vizceral ES module sources on require.
require('babel-register')({
  presets: [require.resolve('babel-preset-env')],
  plugins: [require.resolve('babel-plugin-lodash')],
  only: [SRC_ROOT],
  ignore: nodeModules => nodeModules.indexOf('node_modules') !== -1
});

// Stub webpack-specific asset/loader imports used by the vizceral sources.
// Installed after babel-register so its resolver still delegates to this hook.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveFilename (request, parent, isMain, options) {
  if (/^worker-loader\?/i.test(request)) {
    return path.resolve(__dirname, 'workerStub.js');
  }
  if (/^(url-loader|file-loader|raw-loader|style-loader|css-loader)\?/i.test(request)
    || /\.(png|jpg|gif|glsl|woff2?|otf|ttf|eot|svg|css)$/i.test(request)) {
    return path.resolve(__dirname, 'assetStub.js');
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

module.exports = { dom, SRC_ROOT };
