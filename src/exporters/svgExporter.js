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
import * as THREE from 'three';

/**
 * Stable, machine readable error codes for every deterministic export failure.
 */
export const SVG_EXPORT_ERRORS = {
  NO_SCENE: 'NO_SCENE',
  EMPTY_SCENE: 'EMPTY_SCENE',
  ELEMENT_LIMIT_EXCEEDED: 'ELEMENT_LIMIT_EXCEEDED',
  INVALID_OPTIONS: 'INVALID_OPTIONS'
};

export class SVGExportError extends Error {
  constructor (code, message) {
    super(message || code);
    this.name = 'SVGExportError';
    this.code = code;
  }
}

export const DEGRADATION_CODES = {
  RASTER_TEXTURE_FALLBACK: 'raster-texture-fallback',
  ADDITIVE_BLENDING_FLATTENED: 'additive-blending-flattened',
  PARTICLE_ANIMATION_FROZEN: 'particle-animation-frozen',
  CUSTOM_SHADER_BAKED: 'custom-shader-baked',
  LINE_WIDTH_UNSUPPORTED: 'line-width-unsupported',
  UNSUPPORTED_GEOMETRY_SKIPPED: 'unsupported-geometry-skipped'
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';
const PAD = 8;
const DEFAULT_MAX_ELEMENTS = 200000;

function round (value) {
  // Two decimals give sub-0.01 unit precision while keeping coordinates compact
  // enough for very large graphs; world units map 1:1 to SVG user units.
  return Math.round(value * 100) / 100;
}

function xmlEscape (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colorToCss (color, opacity) {
  if (!color) { return 'rgb(0,0,0)'; }
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  if (opacity === undefined || opacity >= 1) {
    return `rgb(${r},${g},${b})`;
  }
  return `rgba(${r},${g},${b},${round(opacity)})`;
}

function isObjectVisible (object) {
  let current = object;
  while (current) {
    if (current.visible === false) { return false; }
    current = current.parent;
  }
  return true;
}

function collectMaterialList (material) {
  if (!material) { return []; }
  return Array.isArray(material) ? material : [material];
}

function materialOpacity (material) {
  if (!material) { return 1; }
  if (Array.isArray(material)) {
    return material.reduce((max, entry) => Math.max(max, entry.opacity === undefined ? 1 : entry.opacity), 0);
  }
  return material.opacity === undefined ? 1 : material.opacity;
}

/**
 * Streaming SVG fragment builder. Holding an array of small fragments and
 * joining once keeps peak memory proportional to the final document instead of
 * retaining many intermediate concatenated strings.
 */
class SvgBuilder {
  constructor () {
    this.fragments = [];
    // Circles (particles) are bucketed by identical visual style so the output
    // carries one shared fill on a <g> instead of repeating it on every circle.
    this.circleBuckets = new Map();
    this.stats = {
      objectsVisited: 0,
      meshes: 0,
      lines: 0,
      lineSegments: 0,
      pointsObjects: 0,
      particles: 0,
      labels: 0,
      rasterFallbacks: 0,
      skippedInvisible: 0,
      skippedZeroOpacity: 0,
      svgPaths: 0,
      svgPolylines: 0,
      svgLines: 0,
      svgCircles: 0,
      svgRects: 0,
      svgTexts: 0,
      svgImages: 0
    };
    this.degradationCounts = {};
    this.degradations = [];
    this.bounds = null;
  }

  recordDegradation (code, detail) {
    if (!this.degradationCounts[code]) {
      this.degradationCounts[code] = 0;
    }
    this.degradationCounts[code] += 1;
    this.degradations.push({ code, detail });
  }

  expandBounds (x, y) {
    if (!this.bounds) {
      this.bounds = {
        minX: x, minY: y, maxX: x, maxY: y
      };
      return;
    }
    if (x < this.bounds.minX) { this.bounds.minX = x; }
    if (x > this.bounds.maxX) { this.bounds.maxX = x; }
    if (y < this.bounds.minY) { this.bounds.minY = y; }
    if (y > this.bounds.maxY) { this.bounds.maxY = y; }
  }

  append (fragment) {
    this.fragments.push(fragment);
  }

  appendCircle (cx, cy, radius, fill) {
    if (!this.circleBuckets.has(fill)) {
      this.circleBuckets.set(fill, []);
    }
    this.circleBuckets.get(fill).push(`<circle cx="${cx}" cy="${cy}" r="${radius}"/>`);
    this.stats.svgCircles++;
    this.stats.particles++;
  }

  flushCircles () {
    this.circleBuckets.forEach((circles, fill) => {
      this.append(`<g fill="${fill}">${circles.join('')}</g>`);
    });
    this.circleBuckets.clear();
  }
}

/**
 * Convert any indexed/non-indexed triangle-based geometry into closed SVG sub
 * paths expressed in world coordinates. One path is emitted per material group
 * so fill color/opacity still match the screen rendering. Every emitted sub
 * path is closed with Z, which is later structurally verified.
 */
function meshToPathEntries (mesh, builder) {
  const { geometry } = mesh;
  if (!geometry) {
    builder.recordDegradation(DEGRADATION_CODES.UNSUPPORTED_GEOMETRY_SKIPPED,
      `mesh ${mesh.uuid} has no geometry`);
    return [];
  }

  mesh.updateMatrixWorld(true);
  const materials = collectMaterialList(mesh.material);
  const world = new THREE.Vector3();
  const entries = [];

  const writeVertex = (vertexIndex) => {
    if (geometry.isBufferGeometry) {
      world.fromBufferAttribute(geometry.attributes.position, vertexIndex);
    } else {
      world.copy(geometry.vertices[vertexIndex]);
    }
    world.applyMatrix4(mesh.matrixWorld);
    const x = round(world.x);
    const y = round(world.y);
    builder.expandBounds(world.x, world.y);
    return `${x} ${-y}`;
  };

  const writeTriangle = (a, b, c) => `M${writeVertex(a)}L${writeVertex(b)}L${writeVertex(c)}Z`;

  if (geometry.isBufferGeometry) {
    if (!geometry.attributes || !geometry.attributes.position) {
      builder.recordDegradation(DEGRADATION_CODES.UNSUPPORTED_GEOMETRY_SKIPPED,
        `mesh ${mesh.uuid} has no position attribute`);
      return [];
    }
    const { position } = geometry.attributes;
    const index = geometry.index ? geometry.index.array : null;
    const groups = geometry.groups && geometry.groups.length > 0
      ? geometry.groups
      : [{ start: 0, count: index ? index.length : position.count, materialIndex: 0 }];

    groups.forEach((group) => {
      let data = '';
      const triangleCount = Math.floor(group.count / 3);
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        const groupOffset = group.start + (triangle * 3);
        const indices = [0, 1, 2].map(corner => (index ? index[groupOffset + corner] : groupOffset + corner));
        data += writeTriangle(indices[0], indices[1], indices[2]);
      }
      if (data) {
        entries.push({ data, material: materials[group.materialIndex] || materials[0], triangles: triangleCount });
      }
    });
  } else if (geometry.faces && geometry.vertices) {
    // Legacy THREE.Geometry: ShapeGeometry/PlaneGeometry in three r106 keep
    // explicit faces with vertex indices plus a shared vertices array.
    geometry.faces.forEach((face) => {
      entries.push({
        data: writeTriangle(face.a, face.b, face.c),
        material: materials[face.materialIndex] || materials[0],
        triangles: 1
      });
    });
  } else {
    builder.recordDegradation(DEGRADATION_CODES.UNSUPPORTED_GEOMETRY_SKIPPED,
      `mesh ${mesh.uuid} geometry type is not supported`);
  }

  return entries;
}

function collectLinePoints (object, builder) {
  const { geometry } = object;
  object.updateMatrixWorld(true);
  const points = [];
  const world = new THREE.Vector3();

  if (geometry.isBufferGeometry) {
    const { position } = geometry.attributes;
    if (!position) { return points; }
    for (let i = 0; i < position.count; i++) {
      world.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      points.push({ x: world.x, y: world.y });
      builder.expandBounds(world.x, world.y);
    }
  } else if (geometry.vertices) {
    geometry.vertices.forEach((vertex) => {
      world.copy(vertex).applyMatrix4(object.matrixWorld);
      points.push({ x: world.x, y: world.y });
      builder.expandBounds(world.x, world.y);
    });
  }
  return points;
}

function lineDashArray (material) {
  if (material.userData && material.userData.svgDashArray) {
    return material.userData.svgDashArray;
  }
  if (material.isLineDashedMaterial && material.dashSize !== undefined) {
    const gap = material.gapSize !== undefined ? material.gapSize : material.dashSize;
    return `${round(material.dashSize)},${round(gap)}`;
  }
  return null;
}

function appendLineObject (object, builder) {
  const material = collectMaterialList(object.material)[0];
  const opacity = materialOpacity(material);
  if (opacity <= 0.001) {
    builder.stats.skippedZeroOpacity++;
    return;
  }
  const points = collectLinePoints(object, builder);
  if (points.length < 2) { return; }

  if (material.blending === THREE.AdditiveBlending) {
    builder.recordDegradation(DEGRADATION_CODES.ADDITIVE_BLENDING_FLATTENED,
      `line ${object.uuid} uses additive blending; emitted with mix-blend-mode: screen`);
  }
  if (material.linewidth && material.linewidth > 1) {
    // WebGL LineBasicMaterial ignores linewidth on most platforms; SVG strokes
    // use 1px to match what is actually on screen and flag the difference.
    builder.recordDegradation(DEGRADATION_CODES.LINE_WIDTH_UNSUPPORTED,
      `line ${object.uuid} requested width ${material.linewidth}`);
  }
  const dash = lineDashArray(material);
  const dashAttribute = dash ? ` stroke-dasharray="${dash}"` : '';
  const blendAttribute = material.blending === THREE.AdditiveBlending ? ' style="mix-blend-mode:screen"' : '';
  const stroke = colorToCss(material.color || new THREE.Color(0xffffff), opacity);

  const isSegments = object.isLineSegments;
  if (isSegments) {
    builder.stats.lineSegments++;
    for (let i = 0; i + 1 < points.length; i += 2) {
      builder.append(
        `<line x1="${round(points[i].x)}" y1="${-round(points[i].y)}" x2="${round(points[i + 1].x)}" y2="${-round(points[i + 1].y)}" stroke="${stroke}" stroke-width="1"${dashAttribute}${blendAttribute}/>`
      );
      builder.stats.svgLines++;
    }
  } else {
    builder.stats.lines++;
    const pairs = points.map(point => `${round(point.x)},${-round(point.y)}`).join(' ');
    builder.append(
      `<polyline points="${pairs}" fill="none" stroke="${stroke}" stroke-width="1"${dashAttribute}${blendAttribute}/>`
    );
    builder.stats.svgPolylines++;
  }
}

function appendPointsObject (pointsObject, builder, options) {
  const { geometry } = pointsObject;
  const position = geometry && geometry.attributes && geometry.attributes.position;
  if (!position) {
    builder.recordDegradation(DEGRADATION_CODES.UNSUPPORTED_GEOMETRY_SKIPPED,
      `points ${pointsObject.uuid} has no position attribute`);
    return;
  }
  pointsObject.updateMatrixWorld(true);

  const opacityAttribute = geometry.attributes.customOpacity;
  const colorAttribute = geometry.attributes.customColor;
  const sizeAttribute = geometry.attributes.size;
  const baseMaterial = collectMaterialList(pointsObject.material)[0];
  let uniformOpacity = 1;
  if (baseMaterial && baseMaterial.uniforms && baseMaterial.uniforms.opacity) {
    uniformOpacity = baseMaterial.uniforms.opacity.value;
  } else if (baseMaterial && baseMaterial.opacity !== undefined) {
    uniformOpacity = baseMaterial.opacity;
  }

  // A static document cannot reproduce the particle animation; the export
  // freezes the current frame's positions.
  builder.recordDegradation(DEGRADATION_CODES.PARTICLE_ANIMATION_FROZEN,
    `points ${pointsObject.uuid} captured at export time`);
  if (baseMaterial && baseMaterial.isShaderMaterial) {
    builder.recordDegradation(DEGRADATION_CODES.CUSTOM_SHADER_BAKED,
      'shader point material flattened to solid circles');
  }

  const world = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    const particleOpacity = opacityAttribute ? opacityAttribute.getX(i) : 1;
    const effectiveOpacity = particleOpacity * uniformOpacity;
    if (effectiveOpacity > 0.001) {
      world.fromBufferAttribute(position, i).applyMatrix4(pointsObject.matrixWorld);
      const radius = sizeAttribute ? sizeAttribute.getX(i) / 2 : (options.defaultParticleRadius || 3);
      const color = colorAttribute
        ? new THREE.Color(colorAttribute.getX(i), colorAttribute.getY(i), colorAttribute.getZ(i))
        : (baseMaterial && baseMaterial.color) || new THREE.Color(0xffffff);

      builder.expandBounds(world.x - radius, world.y - radius);
      builder.expandBounds(world.x + radius, world.y + radius);
      builder.appendCircle(round(world.x), -round(world.y), round(radius),
        colorToCss(color, effectiveOpacity));
    } else {
      builder.stats.skippedZeroOpacity++;
    }
  }
  builder.stats.pointsObjects++;
}

function meshWorldBox (mesh) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  return {
    minX: box.min.x,
    minY: box.min.y,
    maxX: box.max.x,
    maxY: box.max.y
  };
}

function appendVectorLabel (mesh, builder) {
  const meta = mesh.userData.svgLabel;
  const material = collectMaterialList(mesh.material)[0];
  const opacity = materialOpacity(material);
  const box = meshWorldBox(mesh);
  builder.expandBounds(box.minX, box.minY);
  builder.expandBounds(box.maxX, box.maxY);

  const x = round(box.minX);
  const y = -round(box.maxY);
  const width = round(box.maxX - box.minX);
  const height = round(box.maxY - box.minY);
  const centerX = round((box.minX + box.maxX) / 2);
  const centerY = -round((box.minY + box.maxY) / 2);
  const fontSize = round(meta.fontSize || height * 0.65);

  const fragments = [
    `<g class="vizceral-label" data-label-kind="${xmlEscape(meta.kind || 'label')}">`
  ];

  if (meta.background !== null) {
    const radius = meta.rectRadius === undefined ? 3 : meta.rectRadius;
    fragments.push(
      `${`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}" `
      + `fill="${xmlEscape(meta.background || 'rgba(0,0,0,0)')}" `}${
        meta.borderColor ? `stroke="${xmlEscape(meta.borderColor)}" stroke-width="2" ` : ''
      }opacity="${round(opacity)}"/>`
    );
    builder.stats.svgRects++;
  }

  fragments.push(
    `<text x="${centerX}" y="${centerY}" font-family="${xmlEscape(meta.fontFamily || "'Source Sans Pro', sans-serif")}" `
    + `font-size="${fontSize}" font-weight="${meta.fontWeight || 400}" fill="${xmlEscape(meta.textColor || '#000')}" `
    + `text-anchor="middle" dominant-baseline="central" opacity="${round(opacity)}">${xmlEscape(meta.text)}</text>`
  );
  fragments.push('</g>');
  builder.append(fragments.join(''));
  builder.stats.svgTexts++;
  builder.stats.labels++;
}

function textureToDataUrl (texture) {
  if (!texture || !texture.image) { return null; }
  const { image } = texture;
  if (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) {
    return image.toDataURL('image/png');
  }
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement && image.src) {
    return image.src;
  }
  return image.src || null;
}

function appendRasterFallback (mesh, builder) {
  const material = collectMaterialList(mesh.material)[0];
  const texture = material && material.map;
  const dataUrl = textureToDataUrl(texture);
  const box = meshWorldBox(mesh);
  builder.expandBounds(box.minX, box.minY);
  builder.expandBounds(box.maxX, box.maxY);

  if (!dataUrl) {
    builder.recordDegradation(DEGRADATION_CODES.RASTER_TEXTURE_FALLBACK,
      `mesh ${mesh.uuid} texture could not be serialized; element omitted`);
    return;
  }

  builder.append(
    `<image x="${round(box.minX)}" y="${-round(box.maxY)}" width="${round(box.maxX - box.minX)}" height="${round(box.maxY - box.minY)}" `
    + `href="${dataUrl}" preserveAspectRatio="none" opacity="${round(materialOpacity(material))}"/>`
  );
  builder.stats.svgImages++;
  builder.stats.rasterFallbacks++;
  builder.recordDegradation(DEGRADATION_CODES.RASTER_TEXTURE_FALLBACK,
    `mesh ${mesh.uuid} exported as embedded raster image`);
}

function appendGenericMesh (mesh, builder) {
  const entries = meshToPathEntries(mesh, builder);
  const materials = collectMaterialList(mesh.material);

  // Merge triangle entries that share an identical material into one path
  // element. Each triangle still carries its own M...Z closed sub-path, so
  // structural closure verification is unchanged while the file stays compact.
  const mergedByMaterial = new Map();
  entries.forEach((entry) => {
    const material = entry.material || materials[0];
    const key = material.uuid;
    if (!mergedByMaterial.has(key)) {
      mergedByMaterial.set(key, { material, data: '' });
    }
    mergedByMaterial.get(key).data += entry.data;
  });

  mergedByMaterial.forEach((entry) => {
    const { material } = entry;
    const opacity = materialOpacity(material);
    if (opacity <= 0.001) {
      builder.stats.skippedZeroOpacity++;
      return;
    }
    const fill = material.vertexColors
      ? 'rgb(255,255,255)'
      : colorToCss(material.color || new THREE.Color(0xffffff), opacity);
    let fillOpacity = null;
    if (material.vertexColors) {
      fillOpacity = round(opacity);
    } else if (material.opacity !== undefined && material.opacity < 1) {
      fillOpacity = round(material.opacity);
    }
    const opacityAttribute = fillOpacity ? ` fill-opacity="${fillOpacity}"` : '';
    const blendAttribute = material.blending === THREE.AdditiveBlending ? ' style="mix-blend-mode:screen"' : '';
    if (material.blending === THREE.AdditiveBlending) {
      builder.recordDegradation(DEGRADATION_CODES.ADDITIVE_BLENDING_FLATTENED,
        `mesh ${mesh.uuid} uses additive blending`);
    }
    builder.append(`<path d="${entry.data}" fill="${fill}"${opacityAttribute}${blendAttribute}/>`);
    builder.stats.svgPaths++;
  });
}

function traverseScene (root, builder, options) {
  let emittedElements = 0;
  root.updateMatrixWorld(true);

  root.traverse((object) => {
    builder.stats.objectsVisited++;
    if (!isObjectVisible(object)) {
      builder.stats.skippedInvisible++;
      return;
    }

    if (object.isMesh) {
      builder.stats.meshes++;
      const material = collectMaterialList(object.material)[0];
      if (materialOpacity(object.material) <= 0.001 && !object.userData.svgLabel) {
        builder.stats.skippedZeroOpacity++;
        return;
      }
      if (object.userData.svgLabel) {
        appendVectorLabel(object, builder);
      } else if (material && material.map) {
        appendRasterFallback(object, builder);
      } else {
        appendGenericMesh(object, builder);
      }
      emittedElements++;
    } else if (object.isLine || object.isLineSegments) {
      appendLineObject(object, builder);
      emittedElements++;
    } else if (object.isPoints) {
      appendPointsObject(object, builder, options);
      emittedElements++;
    }

    if (emittedElements > options.maxElements) {
      throw new SVGExportError(SVG_EXPORT_ERRORS.ELEMENT_LIMIT_EXCEEDED,
        `SVG export exceeded the configured element limit of ${options.maxElements}`);
    }
  });
}

function buildDocument (builder, options) {
  if (!builder.bounds) {
    throw new SVGExportError(SVG_EXPORT_ERRORS.EMPTY_SCENE, 'SVG export found no visible drawable objects');
  }

  const minX = round(builder.bounds.minX - PAD);
  const minY = -round(builder.bounds.maxY + PAD);
  const width = round(builder.bounds.maxX - builder.bounds.minX + (PAD * 2));
  const height = round(builder.bounds.maxY - builder.bounds.minY + (PAD * 2));

  const degradationSummary = Object.keys(builder.degradationCounts)
    .map(code => `${code}=${builder.degradationCounts[code]}`).join(', ');

  const header = [
    XML_HEADER,
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
    + `viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}" `
    + `data-vizceral-svg="1" data-degradations="${xmlEscape(degradationSummary)}">`,
    '<title>Vizceral SVG export</title>',
    `<desc>Vector export of the current Vizceral scene. Degraded effects: ${xmlEscape(degradationSummary || 'none')}</desc>`
  ];

  if (options.background) {
    header.push(
      `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${xmlEscape(options.background)}"/>`
    );
    builder.stats.svgRects++;
  }

  const degradationNotes = builder.degradations.map((entry, index) => `<degradation index="${index}" code="${xmlEscape(entry.code)}" detail="${xmlEscape(entry.detail || '')}"/>`);

  return [
    header.join('\n'),
    `<metadata id="vizceral-export-metadata" type="application/json">${
      JSON.stringify({ degradations: builder.degradationCounts, stats: builder.stats })
    }</metadata>`,
    '<g id="vizceral-scene">',
    builder.fragments.join('\n'),
    '</g>',
    degradationNotes.length ? `<g id="vizceral-degradations" display="none">${degradationNotes.join('')}</g>` : '',
    '</svg>'
  ].filter(Boolean).join('\n');
}

/**
 * Export a THREE.Scene (or any Object3D root) to a standalone SVG string.
 * Coordinates are taken from world space, so the orthographic camera's current
 * viewport never clips the output: the viewBox is computed from the full scene.
 *
 * @param {THREE.Object3D} scene Root object to export (normally Vizceral.scene)
 * @param {object} [options]
 * @param {string} [options.background] Optional page background fill color
 * @param {number} [options.maxElements=200000] Safety cap on emitted drawables
 * @returns {{svg: string, stats: object, degradations: object, viewBox: object}}
 */
export function exportSceneToSVG (scene, options = {}) {
  if (!scene) {
    throw new SVGExportError(SVG_EXPORT_ERRORS.NO_SCENE, 'exportSceneToSVG requires a THREE.Object3D scene');
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new SVGExportError(SVG_EXPORT_ERRORS.INVALID_OPTIONS, 'options must be a plain object');
  }
  const maxElements = options.maxElements === undefined ? DEFAULT_MAX_ELEMENTS : options.maxElements;
  if (!Number.isFinite(maxElements) || maxElements <= 0) {
    throw new SVGExportError(SVG_EXPORT_ERRORS.INVALID_OPTIONS, 'maxElements must be a positive finite number');
  }

  const builder = new SvgBuilder();
  traverseScene(scene, builder, { maxElements, defaultParticleRadius: options.defaultParticleRadius });
  builder.flushCircles();
  const svg = buildDocument(builder, options);
  const { bounds } = builder;

  return {
    svg,
    stats: builder.stats,
    degradations: builder.degradationCounts,
    degradationDetails: builder.degradations,
    viewBox: {
      x: round(bounds.minX - PAD),
      y: -round(bounds.maxY + PAD),
      width: round(bounds.maxX - bounds.minX + (PAD * 2)),
      height: round(bounds.maxY - bounds.minY + (PAD * 2))
    }
  };
}

/**
 * Pure-string structural validation for an exported SVG document. Runs in both
 * browser and Node environments without a DOM. Verifies element counts against
 * the exporter stats and proves every emitted path is closed.
 */
export function validateSVGStructure (svgText, expectedStats) {
  const errors = [];
  const countTag = (tag) => {
    const matches = svgText.match(new RegExp(`<${tag}\\b`, 'g'));
    return matches ? matches.length : 0;
  };

  const counts = {
    svg: countTag('svg'),
    path: countTag('path'),
    polyline: countTag('polyline'),
    line: countTag('line'),
    circle: countTag('circle'),
    rect: countTag('rect'),
    text: countTag('text'),
    image: countTag('image'),
    title: countTag('title')
  };

  if (counts.svg !== 1) { errors.push(`expected exactly 1 svg root, found ${counts.svg}`); }

  // Every path data string must contain a matching number of move commands and
  // closepath commands, and must end with Z (sub-paths are triangle fans/rings).
  const pathElements = svgText.match(/<path\b[^>]*\bd="([^"]*)"[^>]*>/g) || [];
  let closedPaths = 0;
  let openPaths = 0;
  pathElements.forEach((element) => {
    const dataMatch = element.match(/\bd="([^"]*)"/);
    const data = dataMatch ? dataMatch[1] : '';
    const moveCount = (data.match(/M/g) || []).length;
    const closeCount = (data.match(/Z/g) || []).length;
    if (moveCount > 0 && moveCount === closeCount && /Z$/.test(data.trim())) {
      closedPaths++;
    } else {
      openPaths++;
      errors.push(`unclosed or malformed path detected (M=${moveCount}, Z=${closeCount})`);
    }
  });

  if (expectedStats) {
    const expectations = {
      path: expectedStats.svgPaths,
      polyline: expectedStats.svgPolylines,
      line: expectedStats.svgLines,
      circle: expectedStats.svgCircles,
      text: expectedStats.svgTexts,
      image: expectedStats.svgImages
    };
    // The optional background rect and label rects make rect counts asserted
    // only as a lower bound; all other tags must match exactly.
    Object.keys(expectations).forEach((tag) => {
      const expected = expectations[tag];
      if (expected !== undefined && counts[tag] !== expected) {
        errors.push(`element count mismatch for <${tag}>: expected ${expected}, found ${counts[tag]}`);
      }
    });
    if (expectedStats.svgRects !== undefined && counts.rect < expectedStats.svgRects) {
      errors.push(`element count mismatch for <rect>: expected at least ${expectedStats.svgRects}, found ${counts.rect}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    counts,
    closedPaths,
    openPaths,
    bytes: svgText.length
  };
}
