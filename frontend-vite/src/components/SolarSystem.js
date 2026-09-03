import * as THREE from 'three';

export class SolarSystem {
  constructor(containerSelectorOrElement, { onEarthClick, onSunClick, onMoonClick } = {}) {
    this.container = typeof containerSelectorOrElement === 'string' ? document.querySelector(containerSelectorOrElement) : containerSelectorOrElement;
    this.callbacks = { onEarthClick, onSunClick, onMoonClick };
    this.running = false;
    if (!this.container) return;
    this.container.style.position = this.container.style.position || 'relative';
    try {
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      this.camera.position.set(0, 3.5, 10);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.container.appendChild(this.renderer.domElement);
      this.scene.add(new THREE.AmbientLight(0x445577, 1.2));
      const sun = new THREE.Mesh(new THREE.SphereGeometry(1.15, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffc34d }));
      const earth = new THREE.Mesh(new THREE.SphereGeometry(.48, 20, 14), new THREE.MeshStandardMaterial({ color: 0x3d8edb, roughness: .8 }));
      earth.position.set(3, 0, 0);
      const moon = new THREE.Mesh(new THREE.SphereGeometry(.16, 16, 10), new THREE.MeshStandardMaterial({ color: 0xbfc8d4 }));
      moon.position.set(.8, 0, 0);
      this.scene.add(sun, earth); earth.add(moon);
      this.targets = [{ object: sun, callback: onSunClick, label: '太阳' }, { object: earth, callback: onEarthClick, label: '地球' }, { object: moon, callback: onMoonClick, label: '月亮' }];
      this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
      this.renderer.domElement.addEventListener('pointerdown', (event) => this._pick(event));
      this.buttons = this.targets.map((target) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'solar-system-hit'; b.setAttribute('aria-label', target.label); b.addEventListener('click', () => target.callback?.()); this.container.appendChild(b); return b; });
      this.resize(); this.running = true; this._tick();
    } catch (error) { window.__DBG__ = window.__DBG__ || {}; window.__DBG__.solarSystemError = String(error?.message || error); this.renderer?.domElement.remove(); }
  }
  _pick(event) { const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); this.raycaster.setFromCamera(this.pointer, this.camera); const hit = this.raycaster.intersectObjects(this.targets.map((x) => x.object), true)[0]; if (hit) this.targets.find((x) => hit.object === x.object || hit.object.parent === x.object)?.callback?.(); }
  _tick() { if (!this.running) return; this.targets[1].object.rotation.y += .003; this.targets[2].object.rotation.y += .01; this.renderer.render(this.scene, this.camera); this._positionButtons(); requestAnimationFrame(() => this._tick()); }
  _positionButtons() { const rect = this.container.getBoundingClientRect(); this.targets.forEach((target, i) => { const p = target.object.getWorldPosition(new THREE.Vector3()).project(this.camera); const b = this.buttons[i]; b.style.left = `${(p.x * .5 + .5) * rect.width - 24}px`; b.style.top = `${(-p.y * .5 + .5) * rect.height - 24}px`; }); }
  resize() { if (!this.renderer || !this.container) return; const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h, false); }
  destroy() { this.running = false; this.renderer?.domElement.remove(); this.buttons?.forEach((b) => b.remove()); this.renderer?.dispose(); }
}
