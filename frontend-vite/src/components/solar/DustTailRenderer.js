import * as THREE from 'three';

function createParticleMask() {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const offset = (row * size + column) * 4;
      const radius = Math.hypot(2 * column / (size - 1) - 1, 2 * row / (size - 1) - 1);
      data[offset] = data[offset + 1] = data[offset + 2] = 255;
      data[offset + 3] = radius < 1 ? Math.round(255 * Math.cos(Math.PI * radius / 2) ** 2) : 0;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// Renders the dust tail as a single THREE.Points primitive with a fixed-capacity
// position attribute. Only beta > 0 particles are displayed (4 of the 5 physical
// bands); the beta = 0 gravity-reference band never enters the GPU buffer.
//
// Capacity is fixed at 201 releases * 4 visible bands = 804 vertices. On shrink,
// stale slots beyond the current draw range keep old coordinates on purpose; the
// safety invariant is geometry.setDrawRange(0, visibleCount), which is the only
// thing WebGL is allowed to read.
export class DustTailRenderer {
  constructor({ scene, physicalToDisplay }) {
    this.scene = scene;
    this.physicalToDisplay = physicalToDisplay;
    this.visibleCount = 0;

    // Fixed capacity of 804 visible particles (201 * 4).
    this.maxVisibleCount = 804;
    const positions = new Float32Array(this.maxVisibleCount * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const colors = new Float32Array(this.maxVisibleCount * 4).fill(1);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    this.geometry.setDrawRange(0, 0);

    this.particleMask = createParticleMask();
    this.material = new THREE.PointsMaterial({
      color: 0xffe8c8,
      map: this.particleMask,
      vertexColors: true,
      size: 1.8,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'halley-dust-tail';
    this.points.renderOrder = 2;
    this.points.raycast = () => {}; // never intercept picking rays
    this.points.frustumCulled = false;

    this.disposed = false;
    this.screenX = new Float64Array(this.maxVisibleCount);
    this.screenY = new Float64Array(this.maxVisibleCount);
    this.binX = new Float64Array(this.maxVisibleCount);
    this.binY = new Float64Array(this.maxVisibleCount);
    this.binCounts = new Uint32Array(2048);
    this.binKeysX = new Float64Array(2048);
    this.binKeysY = new Float64Array(2048);
    this.microCounts = new Uint32Array(2048);
    this.microKeysX = new Float64Array(2048);
    this.microKeysY = new Float64Array(2048);
    this.microRepresentatives = new Uint32Array(2048);
    this.projectScratch = new THREE.Vector3();
    this.modelViewScratch = new THREE.Matrix4();
    this.bufferSizeScratch = new THREE.Vector2();
    this.pointSizeRenderer = null;
    this.pointSizeRange = null;

    this.scene.add(this.points);
  }

  // physicalFloat32Array layout: 5 beta bands, each validReleaseCount * 3 floats.
  // We map bands 1..4 (beta > 0) into the contiguous display buffer.
  update(physicalFloat32Array, validReleaseCount) {
    const visibleCount = validReleaseCount * 4;
    const posAttr = this.geometry.attributes.position;
    const array = posAttr.array;

    for (let betaIdx = 1; betaIdx <= 4; betaIdx += 1) {
      const srcBetaOffset = betaIdx * validReleaseCount * 3;
      const dstBetaOffset = (betaIdx - 1) * validReleaseCount * 3;

      for (let r = 0; r < validReleaseCount; r += 1) {
        const srcOffset = srcBetaOffset + r * 3;
        const dstOffset = dstBetaOffset + r * 3;
        const disp = this.physicalToDisplay({
          x: physicalFloat32Array[srcOffset],
          y: physicalFloat32Array[srcOffset + 1],
          z: physicalFloat32Array[srcOffset + 2]
        });
        array[dstOffset] = disp.x;
        array[dstOffset + 1] = disp.y;
        array[dstOffset + 2] = disp.z;
      }
    }

    posAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, visibleCount);
    this.visibleCount = visibleCount;
  }

  clear() {
    this.visibleCount = 0;
    this.geometry.setDrawRange(0, 0);
  }

  _findBin(horizontal, vertical) {
    const mask = this.binCounts.length - 1;
    let slot = (Math.imul(horizontal, 73856093) ^ Math.imul(vertical, 19349663)) & mask;
    while (this.binCounts[slot] && (this.binKeysX[slot] !== horizontal || this.binKeysY[slot] !== vertical)) {
      slot = (slot + 1) & mask;
    }
    return slot;
  }

  prepareFrame(camera, renderer) {
    if (this.disposed) return;
    const color = this.geometry.attributes.color;
    const count = Math.min(this.visibleCount, this.geometry.drawRange.start + this.geometry.drawRange.count);
    const start = this.geometry.drawRange.start;
    renderer.getDrawingBufferSize(this.bufferSizeScratch);
    const width = this.bufferSizeScratch.x;
    const height = this.bufferSizeScratch.y;
    if (this.pointSizeRenderer !== renderer) {
      const context = renderer.getContext();
      this.pointSizeRange = context.getParameter(context.ALIASED_POINT_SIZE_RANGE);
      this.pointSizeRenderer = renderer;
    }
    camera.updateWorldMatrix(true, false);
    this.points.updateWorldMatrix(true, false);
    this.modelViewScratch.multiplyMatrices(camera.matrixWorldInverse, this.points.matrixWorld);
    const positions = this.geometry.attributes.position;
    const perspective = camera.projectionMatrix.elements[11] === -1;
    let footprint = Math.max(1, this.pointSizeRange[0]);
    for (let index = 0; index < this.visibleCount; index += 1) {
      color.array[index * 4 + 3] = 0;
      this.screenX[index] = Number.NaN;
      if (index < start || index >= count) continue;
      this.projectScratch.fromBufferAttribute(positions, index).applyMatrix4(this.modelViewScratch);
      const depth = -this.projectScratch.z;
      this.projectScratch.applyMatrix4(camera.projectionMatrix);
      if (!Number.isFinite(this.projectScratch.x) || !Number.isFinite(this.projectScratch.y) || !Number.isFinite(this.projectScratch.z) || this.projectScratch.z < -1 || this.projectScratch.z > 1 || (perspective && depth <= 0)) continue;
      const pointSize = this.material.size * (this.material.sizeAttenuation && perspective ? (height + 1) / (2 * depth) : renderer.getPixelRatio());
      footprint = Math.max(footprint, Math.min(this.pointSizeRange[1], pointSize));
      this.screenX[index] = (this.projectScratch.x + 1) * width / 2;
      this.screenY[index] = (this.projectScratch.y + 1) * height / 2;
    }
    const microSize = 0.25;
    const rasterSafety = 1;
    const binSize = Math.ceil(footprint) + Math.ceil(microSize + rasterSafety);
    this.binCounts.fill(0);
    this.microCounts.fill(0);
    const microMask = this.microCounts.length - 1;
    for (let index = start; index < count; index += 1) {
      if (!Number.isFinite(this.screenX[index])) continue;
      const horizontal = Math.floor(this.screenX[index] / binSize);
      const vertical = Math.floor(this.screenY[index] / binSize);
      this.binX[index] = horizontal;
      this.binY[index] = vertical;
      const slot = this._findBin(horizontal, vertical);
      this.binKeysX[slot] = horizontal;
      this.binKeysY[slot] = vertical;
      this.binCounts[slot] += 1;
      const microHorizontal = Math.floor(this.screenX[index] / microSize);
      const microVertical = Math.floor(this.screenY[index] / microSize);
      let microSlot = (Math.imul(microHorizontal, 73856093) ^ Math.imul(microVertical, 19349663)) & microMask;
      while (this.microCounts[microSlot] && (this.microKeysX[microSlot] !== microHorizontal || this.microKeysY[microSlot] !== microVertical)) {
        microSlot = (microSlot + 1) & microMask;
      }
      if (!this.microCounts[microSlot]) {
        this.microKeysX[microSlot] = microHorizontal;
        this.microKeysY[microSlot] = microVertical;
        this.microRepresentatives[microSlot] = index;
      }
      this.microCounts[microSlot] += 1;
    }
    for (let microSlot = 0; microSlot < this.microCounts.length; microSlot += 1) {
      const members = this.microCounts[microSlot];
      if (!members) continue;
      const index = this.microRepresentatives[microSlot];
      let neighbours = 0;
      for (let vertical = -1; vertical <= 1; vertical += 1) {
        for (let horizontal = -1; horizontal <= 1; horizontal += 1) {
          neighbours += this.binCounts[this._findBin(this.binX[index] + horizontal, this.binY[index] + vertical)];
        }
      }
      color.array[index * 4 + 3] = members / Math.max(members, neighbours);
    }
    color.needsUpdate = true;
  }

  getDiagnostics() {
    return {
      visibleCount: this.visibleCount,
      drawRangeCount: this.geometry.drawRange.count,
      attributeCount: this.geometry.attributes.position.count
    };
  }

  copyVisiblePositions() {
    return this.geometry.attributes.position.array.slice(0, this.visibleCount * 3);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    if (this.points && this.scene) {
      this.scene.remove(this.points);
    }
    this.points = null;
    this.geometry.dispose();
    this.material.dispose();
    this.particleMask.dispose();
    this.pointSizeRenderer = null;
  }
}
