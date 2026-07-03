export class NasaParallaxBackground {
  constructor(host) {
    this.host = host;
    this.layers = [];
    this.targetX = 0;
    this.targetY = 0;
    this.x = 0;
    this.y = 0;
    this.destroyed = false;
    this._raf = null;
    this._onMouseMove = (e) => this.onMouseMove(e);
    this._onOrientation = (e) => this.onOrientation(e);
    this.build();
    this.bind();
    this.animate();
    window.__DBG__.nasaParallaxBackground = this;
  }

  build() {
    const specs = [
      { cls: 'nasa-parallax-layer nasa-parallax-bg', src: '/globe/backgrounds/deep-nebula-heic1509a.jpg', factor: 0.008 },
      { cls: 'nasa-parallax-layer nasa-parallax-mid', src: '/globe/backgrounds/deep-nebula-heic1509a.jpg', factor: 0.018 },
      { cls: 'nasa-parallax-layer nasa-parallax-fg', src: '/globe/backgrounds/deep-nebula-heic1509a.jpg', factor: 0.035 },
    ];
    for (const spec of specs) {
      const el = document.createElement('div');
      el.className = spec.cls;
      el.style.backgroundImage = `url('${spec.src}')`;
      el.dataset.factor = String(spec.factor);
      this.host.appendChild(el);
      this.layers.push({ el, factor: spec.factor });
    }
  }

  bind() {
    window.addEventListener('mousemove', this._onMouseMove, { passive: true });
    window.addEventListener('deviceorientation', this._onOrientation, { passive: true });
  }

  onMouseMove(e) {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    this.targetX = (e.clientX - w / 2) / (w / 2);
    this.targetY = (e.clientY - h / 2) / (h / 2);
  }

  onOrientation(e) {
    if (typeof e.gamma !== 'number' || typeof e.beta !== 'number') return;
    this.targetX = Math.max(-1, Math.min(1, e.gamma / 28));
    this.targetY = Math.max(-1, Math.min(1, e.beta / 38));
  }

  animate() {
    if (this.destroyed) return;
    this.x += (this.targetX - this.x) * 0.075;
    this.y += (this.targetY - this.y) * 0.075;
    for (const { el, factor } of this.layers) {
      const px = this.x * factor * 1000;
      const py = this.y * factor * 1000;
      const scale = 1.045 + factor * 1.6;
      el.style.transform = `translate3d(${px}px, ${py}px, 0) scale(${scale})`;
    }
    this._raf = requestAnimationFrame(() => this.animate());
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('deviceorientation', this._onOrientation);
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const { el } of this.layers) el.remove();
    this.layers = [];
    if (window.__DBG__.nasaParallaxBackground === this) window.__DBG__.nasaParallaxBackground = null;
  }
}
