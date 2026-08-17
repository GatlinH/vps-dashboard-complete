import * as THREE from 'three';

export const bussardFXMethods = {
_makeGlowTexture(r, g, b) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(48, 48, 0, 48, 48, 48);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(0.24, `rgba(${r}, ${g}, ${b}, .92)`);
  gradient.addColorStop(0.58, `rgba(${r}, ${g}, ${b}, .28)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 96, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
},

_addBussardCollectorFidelity() {
  if (!this.ship || this.bussardCollectorEffects) return;
  this.bussardCollectorEffects = new THREE.Group();
  this.bussardCollectorEffects.name = 'Visible animated Bussard collector glows';

  const orangeTexture = this._makeGlowTexture(255, 92, 18);
  const makeCollector = (engineName, id) => {
    const engine = this.ship.getObjectByName(engineName);
    if (!engine) return null;

    // Find actual forward-most local mesh point from the animated Bussard hierarchy.
    // A small camera-facing sprite avoids hiding the native rotating dome yet guarantees
    // that its orange collection glow is visible at the homepage hero distance.
    const box = new THREE.Box3().setFromObject(engine);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const localCenter = this.ship.worldToLocal(center.clone());
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: orangeTexture,
      color: 0xff6a20,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }));
    sprite.name = `${id} visible orange Bussard collector`;
    sprite.position.copy(localCenter);
    // Raw GLB local units; box size gives a scale that reads as a compact dome, not HUD.
    const glow = Math.max(44, Math.min(92, Math.max(size.x, size.y, size.z) * 0.56));
    sprite.scale.set(glow, glow, 1);
    sprite.renderOrder = 54;
    sprite.userData = { engineName, localCenter: localCenter.toArray(), glow };
    this.bussardCollectorEffects.add(sprite);
    return sprite;
  };

  this.bussardCollectorRight = makeCollector('bussard_right', 'Starboard');
  this.bussardCollectorLeft = makeCollector('bussard_left', 'Port');
  if (this.bussardCollectorRight || this.bussardCollectorLeft) {
    this.ship.add(this.bussardCollectorEffects);
  }
  this._dbgSet('starshipBussardCollectors', {
    left: this.bussardCollectorLeft?.userData || null,
    right: this.bussardCollectorRight?.userData || null,
    visibleOrange: !!(this.bussardCollectorLeft || this.bussardCollectorRight),
  });
}
};
