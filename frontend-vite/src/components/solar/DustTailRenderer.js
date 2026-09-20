import * as THREE from 'three';

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
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.PointsMaterial({
      color: 0xffe8c8,
      size: 1.8,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.renderOrder = 2;
    this.points.raycast = () => {}; // never intercept picking rays
    this.points.frustumCulled = false;

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
    this.clear();
    if (this.points && this.scene) {
      this.scene.remove(this.points);
    }
    this.points = null;
    this.geometry.dispose();
    this.material.dispose();
  }
}
