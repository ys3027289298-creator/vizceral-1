require('./env');
const path = require('path');
const { SRC_ROOT } = require('./env');
const Vizceral = require(path.join(SRC_ROOT, 'vizceral')).default;
const trafficData = require('./sampleData');

const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 800;

function createVizceral () {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_WIDTH;
  canvas.height = VIEW_HEIGHT;
  canvas.style.width = `${VIEW_WIDTH}px`;
  canvas.style.height = `${VIEW_HEIGHT}px`;
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: VIEW_WIDTH });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: VIEW_HEIGHT });
  Object.defineProperty(canvas, 'offsetWidth', { configurable: true, value: VIEW_WIDTH });
  Object.defineProperty(canvas, 'offsetHeight', { configurable: true, value: VIEW_HEIGHT });
  canvas.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: VIEW_WIDTH, bottom: VIEW_HEIGHT,
    width: VIEW_WIDTH, height: VIEW_HEIGHT
  });
  document.getElementById('host').appendChild(canvas);

  const vizceral = new Vizceral(canvas, 0);
  vizceral.setSize(VIEW_WIDTH, VIEW_HEIGHT);
  vizceral.updateData(trafficData);
  vizceral.setView([]);
  // Run a few update ticks so layout/particles/views settle deterministically.
  for (let i = 0; i < 5; i++) {
    vizceral.render(1000 + (i * 16));
  }
  return vizceral;
}

module.exports = { createVizceral, VIEW_WIDTH, VIEW_HEIGHT, trafficData };
