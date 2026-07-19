import '../globals/dashboardGlobals.js';
import * as PIXI from 'pixi.js';

const lerp = (a, b, t) => a + (b - a) * t;
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export class StarEffectsLayer {
  constructor(container, options = {}) {
    this.container = container;
    this.seed = options.seed || 2406;
    this.rand = mulberry32(this.seed);
    this.stars = [];
    this.ripples = [];
    this.particles = [];
    this._frame = 0;
    this._onResize = () => this.resize();
    this._onPointerDown = (e) => this.handlePointerDown(e);
    this.ready = this.init();
  }

  async init() {
    this.app = new PIXI.Application();
    await this.app.init({
      resizeTo: this.container,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      powerPreference: 'high-performance',
    });
    this.app.canvas.className = 'star-effects-canvas';
    this.app.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:20;';
    this.container.appendChild(this.app.canvas);

    this.stage = new PIXI.Container();
    this.starLayer = new PIXI.Container();
    this.rayLayer = new PIXI.Container();
    this.rippleLayer = new PIXI.Container();
    this.app.stage.addChild(this.stage);
    this.stage.addChild(this.rayLayer, this.starLayer, this.rippleLayer);

    this.buildStars();
    this.buildRays();
    this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('pointerdown', this._onPointerDown, true);
    this.app.ticker.maxFPS = 30;
    this.app.ticker.add((delta) => this.tick(delta));
    window.__DBG__.starEffectsLayer = this;
  }

  buildStars() {
    for (let i = 0; i < 500; i++) {
      const x = this.rand();
      const y = this.rand();
      const nearCluster = x > .52 && x < .86 && y < .34;
      const warm = nearCluster ? this.rand() > .58 : this.rand() > .82;
      const color = warm ? 0xffb060 : 0xc8e0ff;
      const radius = this.rand() > .965 ? lerp(1.2, 2.1, this.rand()) : lerp(.45, 1.05, this.rand());
      const g = new PIXI.Graphics();
      g.beginFill(color, lerp(.25, .78, this.rand()));
      g.drawCircle(0, 0, radius);
      g.endFill();
      g.blendMode = 'add';
      g._base = { x, y, radius, alpha: g.alpha || 1, phase: this.rand() * Math.PI * 2, speed: lerp(.012, .045, this.rand()), color };
      this.starLayer.addChild(g);
      this.stars.push(g);
    }
  }

  buildRays() {
    const bright = [
      { x:.66, y:.11, len:78, rot:0 },
      { x:.72, y:.18, len:62, rot:.35 },
      { x:.58, y:.16, len:54, rot:-.28 },
    ];
    for (const b of bright) {
      for (let i = 0; i < 6; i++) {
        const ray = new PIXI.Graphics();
        const len = b.len * lerp(.72, 1.08, this.rand());
        ray.beginFill(0xc8e0ff, lerp(.20, .38, this.rand()));
        ray.drawRoundedRect(-len / 2, -0.7, len, 1.4, .8);
        ray.endFill();
        ray.blendMode = 'add';
        ray._base = { x:b.x, y:b.y, rot:b.rot + i * Math.PI / 3, phase:this.rand()*Math.PI*2, alpha:ray.alpha || 1 };
        this.rayLayer.addChild(ray);
      }
    }
    // Soft fake godrays from upper-right cluster toward lower-left; cheaper than a full filter.
    this.godrays = new PIXI.Graphics();
    this.godrays.blendMode = 'add';
    this.rayLayer.addChildAt(this.godrays, 0);
  }

  resize() {
    if (!this.app) return;
    const w = this.app.renderer.width / this.app.renderer.resolution;
    const h = this.app.renderer.height / this.app.renderer.resolution;
    this.w = w; this.h = h;
    for (const s of this.stars) {
      s.x = s._base.x * w;
      s.y = s._base.y * h;
    }
    for (const r of this.rayLayer.children) {
      if (!r._base) continue;
      r.x = r._base.x * w;
      r.y = r._base.y * h;
      r.rotation = r._base.rot;
    }
    this.drawGodrays();
  }

  drawGodrays() {
    if (!this.godrays) return;
    const w = this.w || 1, h = this.h || 1;
    this.godrays.clear();
    const sx = w * .65, sy = h * .10;
    for (let i = 0; i < 9; i++) {
      const spread = (i - 4) * 0.07;
      this.godrays.beginFill(0x88bfff, .035 + (i % 3) * .01);
      this.godrays.moveTo(sx, sy);
      this.godrays.lineTo(w * (.05 + spread), h * .95);
      this.godrays.lineTo(w * (.17 + spread), h * .95);
      this.godrays.lineTo(sx + 20, sy + 10);
      this.godrays.endFill();
    }
  }

  handlePointerDown(e) {
    if (e.target && e.target.closest && e.target.closest('#cesium-globe-container')) return;
    const rect = this.app.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ring = new PIXI.Graphics();
    ring.blendMode = 'add';
    ring._life = 0; ring._x = x; ring._y = y;
    this.rippleLayer.addChild(ring);
    this.ripples.push(ring);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const p = new PIXI.Graphics();
      p.beginFill(0x9fd4ff, .62); p.drawCircle(0, 0, 1.6); p.endFill();
      p.blendMode = 'add';
      p.x = x; p.y = y; p._life = 0; p._vx = Math.cos(a) * lerp(1.6, 4.2, this.rand()); p._vy = Math.sin(a) * lerp(1.6, 4.2, this.rand());
      this.rippleLayer.addChild(p); this.particles.push(p);
    }
  }

  tick(delta) {
    this._frame += 1;
    const t = performance.now() / 1000;
    for (const s of this.stars) {
      const b = s._base;
      s.alpha = b.alpha * (.55 + .45 * Math.sin(t * b.speed * 12 + b.phase));
    }
    for (const r of this.rayLayer.children) {
      if (!r._base) continue;
      r.alpha = .26 + .12 * Math.sin(t * .55 + r._base.phase);
      r.rotation = r._base.rot + Math.sin(t * .18 + r._base.phase) * .035;
    }
    if (this.godrays) this.godrays.alpha = .38 + .07 * Math.sin(t * .42);

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const ring = this.ripples[i];
      ring._life += delta / 30;
      const r = ring._life * 110;
      ring.clear();
      ring.lineStyle(2, 0x9fd4ff, Math.max(0, .55 * (1 - ring._life)));
      ring.drawCircle(ring._x, ring._y, r);
      if (ring._life > 1) { ring.destroy(); this.ripples.splice(i, 1); }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p._life += delta / 30; p.x += p._vx * delta; p.y += p._vy * delta; p.alpha = Math.max(0, 1 - p._life);
      if (p._life > 1) { p.destroy(); this.particles.splice(i, 1); }
    }
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    if (window.__DBG__.starEffectsLayer === this) window.__DBG__.starEffectsLayer = null;
    try { this.app?.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (_) {}
    this.app = null;
  }
}
