import { Vector2, Vector3 } from 'three';

const DEFAULT_MIN_ZOOM = 0.5;
const DEFAULT_MAX_ZOOM = 8;
const DEFAULT_WHEEL_ZOOM_SPEED = 0.0015;
const PAN_DRAG_THRESHOLD = 6;
const LEFT_MOUSE_BUTTON = 0;

function eventIsLeftButton (event) {
  return event.button === undefined || event.button === LEFT_MOUSE_BUTTON;
}

/**
 * Adds wheel zoom (centered on the cursor), drag-to-pan and double-click-reset
 * on top of an existing orthographic camera. All transforms are applied to the
 * camera itself, so Three.js raycasting keeps returning correct world-space
 * hits without any extra coordinate conversion.
 */
class ZoomPanInteraction {
  constructor (vizceral) {
    this.vizceral = vizceral;

    this._isEnabled = false;
    this.minZoom = DEFAULT_MIN_ZOOM;
    this.maxZoom = DEFAULT_MAX_ZOOM;
    this.wheelZoomSpeed = DEFAULT_WHEEL_ZOOM_SPEED;

    this._state = 0;
    this._suppressNextClick = false;
    this._lastMouseLocInVPSpace = new Vector2(0, 0);
    this._panDragStartMouseLocInVPSpace = new Vector2(0, 0);

    this._onWheel_func = this.onWheel.bind(this);
    this._onCanvasMouseDown_func = this.onCanvasMouseDown.bind(this);
    this._onDocumentMouseMove_func = this.onDocumentMouseMove.bind(this);
    this._onDocumentMouseUp_func = this.onDocumentMouseUp.bind(this);
    this._onLostCapture_func = this.onLostCapture.bind(this);
    this._onDoubleClick_func = this.onDoubleClick.bind(this);
  }

  getCanvas () {
    return this.vizceral.renderer.domElement;
  }

  getCamera () {
    return this.vizceral.camera;
  }

  isEnabled () {
    return this._isEnabled;
  }

  setEnabled (value) {
    if (typeof value !== 'boolean') throw new TypeError('ZoomPanInteraction.setEnabled: value must be a boolean');
    if (value === this._isEnabled) return;
    this._isEnabled = value;
    const canvas = this.getCanvas();
    if (value) {
      canvas.addEventListener('wheel', this._onWheel_func, { passive: false });
      canvas.addEventListener('mousedown', this._onCanvasMouseDown_func, false);
      canvas.addEventListener('dblclick', this._onDoubleClick_func, false);
      document.addEventListener('mousemove', this._onDocumentMouseMove_func, false);
      document.addEventListener('mouseup', this._onDocumentMouseUp_func, false);
      window.addEventListener('blur', this._onLostCapture_func, false);
    } else {
      this.onLostCapture();
      canvas.removeEventListener('wheel', this._onWheel_func);
      canvas.removeEventListener('mousedown', this._onCanvasMouseDown_func);
      canvas.removeEventListener('dblclick', this._onDoubleClick_func);
      document.removeEventListener('mousemove', this._onDocumentMouseMove_func);
      document.removeEventListener('mouseup', this._onDocumentMouseUp_func);
      window.removeEventListener('blur', this._onLostCapture_func);
    }
  }

  /**
   * Converts a viewport (clientX/clientY) location to the world position the
   * ray passes through on the camera plane. Reuses the exact raycaster path
   * used for node hit testing, so the conversion cannot drift from it.
   */
  viewportToWorld (clientX, clientY, target) {
    this.vizceral.validateRaycaster(clientX, clientY);
    // For an orthographic camera the ray origin is already the world point
    // under the cursor (at the near plane), including zoom and pan.
    target.copy(this.vizceral.raycaster.ray.origin);
    return target;
  }

  clampZoom (zoom) {
    if (!Number.isFinite(zoom)) {
      return this.getCamera().zoom;
    }
    return Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }

  /**
   * Applies a new zoom level while keeping the world point currently under the
   * cursor anchored at the same screen location.
   */
  zoomAt (clientX, clientY, nextZoom) {
    const camera = this.getCamera();
    const clampedZoom = this.clampZoom(nextZoom);
    if (clampedZoom === camera.zoom) {
      return clampedZoom;
    }

    const worldUnderCursor = this.viewportToWorld(clientX, clientY, new Vector3());

    camera.zoom = clampedZoom;
    camera.updateProjectionMatrix();

    // Recompute where that same world point lands now and move the camera so
    // the point returns under the cursor.
    const worldUnderCursorAfter = this.viewportToWorld(clientX, clientY, new Vector3());
    const correction = new Vector3().subVectors(worldUnderCursor, worldUnderCursorAfter);
    this.moveCameraBy(correction.x, correction.y);
    return clampedZoom;
  }

  moveCameraBy (deltaX, deltaY) {
    const camera = this.getCamera();
    camera.position.x += deltaX;
    camera.position.y += deltaY;
    this.vizceral.cameraTarget.x = camera.position.x;
    this.vizceral.cameraTarget.y = camera.position.y;
    camera.lookAt(this.vizceral.cameraTarget);
    camera.updateMatrixWorld(true);
  }

  onWheel (event) {
    if (!this._isEnabled) {
      return;
    }
    event.preventDefault();
    const camera = this.getCamera();
    const zoomFactor = Math.exp(-event.deltaY * this.wheelZoomSpeed);
    this.zoomAt(event.clientX, event.clientY, camera.zoom * zoomFactor);
  }

  onCanvasMouseDown (event) {
    if (this._state !== 0 || !eventIsLeftButton(event)) {
      return;
    }
    // Node dragging (when enabled) owns presses that start on a draggable node.
    if (this.vizceral.options
      && this.vizceral.options.allowDraggingOfNodes
      && this.vizceral.objectToSwitch
      && this.vizceral.objectToSwitch.type === 'node') {
      return;
    }
    this._state = 1;
    this._suppressNextClick = false;
    this._lastMouseLocInVPSpace.set(event.clientX, event.clientY);
    this._panDragStartMouseLocInVPSpace.set(event.clientX, event.clientY);
  }

  onDocumentMouseMove (event) {
    if (this._state === 0) {
      return;
    }
    const totalDeltaX = event.clientX - this._panDragStartMouseLocInVPSpace.x;
    const totalDeltaY = event.clientY - this._panDragStartMouseLocInVPSpace.y;

    if (this._state === 1) {
      if (Math.sqrt((totalDeltaX * totalDeltaX) + (totalDeltaY * totalDeltaY)) < PAN_DRAG_THRESHOLD) {
        return;
      }
      this._state = 2;
    }

    const camera = this.getCamera();
    const canvas = this.getCanvas();
    const worldUnitsPerPixelX = (camera.right - camera.left) / (canvas.clientWidth * camera.zoom);
    const worldUnitsPerPixelY = (camera.top - camera.bottom) / (canvas.clientHeight * camera.zoom);

    const deltaPixelX = event.clientX - this._lastMouseLocInVPSpace.x;
    const deltaPixelY = event.clientY - this._lastMouseLocInVPSpace.y;
    this._lastMouseLocInVPSpace.set(event.clientX, event.clientY);

    this.moveCameraBy(-deltaPixelX * worldUnitsPerPixelX, deltaPixelY * worldUnitsPerPixelY);
    this._suppressNextClick = true;

    // Hover detection at the cursor position is meaningless mid-gesture.
    this.vizceral.disableHoverInteractions = true;
  }

  onDocumentMouseUp () {
    if (this._state === 0) {
      return;
    }
    this._state = 0;
    if (this._suppressNextClick) {
      // Re-enable hover on the next genuine mouse move instead of this release.
      setTimeout(() => {
        this.vizceral.disableHoverInteractions = false;
      }, 0);
    } else {
      this.vizceral.disableHoverInteractions = false;
    }
  }

  onLostCapture () {
    this._state = 0;
  }

  /**
   * Returns true when the in-flight tap/click is part of a pan gesture and the
   * click handlers must ignore it so existing click behavior is untouched.
   */
  shouldSuppressClick () {
    return this._suppressNextClick;
  }

  consumeClickSuppression () {
    const suppressed = this._suppressNextClick;
    this._suppressNextClick = false;
    return suppressed;
  }

  onDoubleClick (event) {
    if (!this._isEnabled) {
      return;
    }
    // Double-clicking a node keeps its original drill-down behavior; only a
    // double-click on empty space resets the view.
    const intersected = this.vizceral.calculateIntersectedObject(event.clientX, event.clientY);
    if (intersected) {
      return;
    }
    this.resetView();
  }

  resetView () {
    const camera = this.getCamera();
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, camera.position.z);
    this.vizceral.cameraTarget.set(0, 0, 0);
    camera.lookAt(this.vizceral.cameraTarget);
    camera.updateMatrixWorld(true);
    this._state = 0;
    this._suppressNextClick = false;
  }
}

export default ZoomPanInteraction;
