/**
 * components/StarMap.js
 * 3D 地球星图组件——基于 Canvas 2D 投影，无需 Three.js。
 *
 * 用法：
 *   import { StarMap } from './StarMap.js'
 *   const map = new StarMap('#globe-canvas', servers)
 *   map.start()   // 开始渲染 & 交互
 *   map.stop()    // 停止
 *   map.setServers(newServers) // 热更新数据
 */

// ─── 地理工具 ─────────────────────────────────────────────────────────────────

/** 球面投影：(lat,lng) → 画布坐标 */
function project3d(lat, lng, r, cx, cy, rotY, rotX) {
  const phi   = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  let x = -Math.sin(phi) * Math.cos(theta);
  let y =  Math.cos(phi);
  let z =  Math.sin(phi) * Math.sin(theta);
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  const x2 = x * cosY - z * sinY, z2 = x * sinY + z * cosY;
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const y2 = y * cosX - z2 * sinX, z3 = y * sinX + z2 * cosX;
  return { px: cx + x2 * r, py: cy + y2 * r, z: z3, visible: z3 < 0.18 };
}

/** 城市名 → 经纬度（中文关键字匹配） */
function locationToLatLng(loc) {
  const MAP = {
    '洛杉矶':  { lat: 34.05, lng: -118.24 }, '纽约':    { lat: 40.71, lng:  -74.01 },
    '芝加哥':  { lat: 41.88, lng:  -87.63 }, '西雅图':  { lat: 47.61, lng: -122.33 },
    '达拉斯':  { lat: 32.78, lng:  -96.80 }, '弗里蒙特':{ lat: 37.55, lng: -121.99 },
    '圣何塞':  { lat: 37.34, lng: -121.89 }, '香港':    { lat: 22.32, lng:  114.17 },
    '东京':    { lat: 35.69, lng:  139.69 }, '大阪':    { lat: 34.69, lng:  135.50 },
    '新加坡':  { lat:  1.35, lng:  103.82 }, '首尔':    { lat: 37.57, lng:  126.98 },
    '台北':    { lat: 25.03, lng:  121.56 }, '上海':    { lat: 31.23, lng:  121.47 },
    '北京':    { lat: 39.90, lng:  116.41 }, '深圳':    { lat: 22.54, lng:  114.06 },
    '法兰克福':{ lat: 50.11, lng:    8.68 }, '伦敦':    { lat: 51.51, lng:   -0.13 },
    '阿姆斯特丹':{ lat:52.37, lng:    4.90 }, '巴黎':    { lat: 48.86, lng:    2.35 },
    '华沙':    { lat: 52.23, lng:   21.01 }, '赫尔辛基':{ lat: 60.17, lng:   24.94 },
    '莫斯科':  { lat: 55.75, lng:   37.62 }, '圣保罗':  { lat:-23.55, lng:  -46.63 },
    '悉尼':    { lat:-33.87, lng:  151.21 }, '孟买':    { lat: 19.08, lng:   72.88 },
    '班加罗尔':{ lat: 12.97, lng:   77.59 }, '吉隆坡':  { lat:  3.14, lng:  101.69 },
    '雅加达':  { lat: -6.21, lng:  106.85 },
  };
  for (const key in MAP) {
    if (loc.includes(key)) return MAP[key];
  }
  return { lat: 30 + Math.random() * 10, lng: 100 + Math.random() * 30 };
}

/** 解析 TopoJSON arcs → [[lng,lat][],...] */
function extractGeoArcs(topo) {
  if (!topo?.transform) return [];
  const { scale, translate } = topo.transform;
  const decoded = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(pt => { x += pt[0]; y += pt[1]; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
  });
  const countries = topo.objects?.countries;
  if (!countries) return decoded.slice(0, 500);
  const result = [];
  function collect(geom) {
    if (!geom) return;
    if (geom.type === 'GeometryCollection') { geom.geometries.forEach(collect); return; }
    const rings = geom.type === 'Polygon' ? geom.arcs : geom.type === 'MultiPolygon' ? geom.arcs.flat() : [];
    rings.forEach(ring => {
      const pts = [];
      ring.forEach(idx => { const a = idx < 0 ? [...decoded[~idx]].reverse() : decoded[idx]; pts.push(...a); });
      if (pts.length > 1) result.push(pts);
    });
  }
  countries.geometries?.forEach(collect);
  return result;
}

// ─── StarMap 类 ───────────────────────────────────────────────────────────────

export class StarMap {
  /**
   * @param {string|HTMLCanvasElement} canvas  CSS 选择器或 canvas 元素
   * @param {object[]} servers  服务器数组（含 location, status, name, flag, ip, cpu_use, ram_use）
   */
  constructor(canvas, servers) {
    this._canvas  = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    this._ctx     = this._canvas.getContext('2d');
    this._servers = servers;

    // 视图状态
    this._rot     = { y: 0.4, x: 0.25 };
    this._zoom    = 1.0;
    this._drag    = { active: false, lastX: 0, lastY: 0 };
    this._hovered = null;
    this._raf     = null;

    // 选项开关
    this.opts = {
      showLines: true,
      autoSpin: true,
      showCountries: true,
      tileMode: false,
      minZoom: 0.45,
      maxZoom: 3.5,
    };

    // Geo & tile 数据
    this._geoFeatures = null;
    this._tileCache   = new Map();

    // 状态回调
    this.onStatusChange = null; // (msg, spinning) => void
    this.onHover        = null; // (server | null) => void
    this.onFetchTick    = null; // () => void（外部传入探针刷新逻辑）

    this._bindEvents();
    this._loadGeoData();
  }

  // ── 公开方法 ─────────────────────────────────────────────────────────────

  start() {
    if (!this._raf) this._loop();
  }

  stop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  setServers(servers) { this._servers = servers; }

  adjustZoom(delta) {
    this._zoom = Math.max(this.opts.minZoom, Math.min(this.opts.maxZoom, this._zoom + delta));
  }

  get zoom() { return this._zoom; }

  // ── 内部：事件绑定 ───────────────────────────────────────────────────────

  _bindEvents() {
    const c = this._canvas;
    c.style.cursor = 'grab';

    c.addEventListener('mousedown', e => {
      this._drag = { active: true, lastX: e.clientX, lastY: e.clientY };
      c.style.cursor = 'grabbing';
    });
    const endDrag = () => { this._drag.active = false; c.style.cursor = 'grab'; };
    c.addEventListener('mouseup',    endDrag);
    c.addEventListener('mouseleave', endDrag);

    c.addEventListener('mousemove', e => {
      if (this._drag.active) {
        this._rot.y += (e.clientX - this._drag.lastX) * 0.005 / this._zoom;
        this._rot.x += (e.clientY - this._drag.lastY) * 0.003 / this._zoom;
        this._rot.x  = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this._rot.x));
        this._drag.lastX = e.clientX; this._drag.lastY = e.clientY;
      }
      this._updateHover(e);
    });

    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.adjustZoom(e.deltaY > 0 ? -0.12 : 0.12);
    }, { passive: false });

    // Touch
    let lastPinch = null;
    c.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        lastPinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      } else {
        this._drag = { active: true, lastX: e.touches[0].clientX, lastY: e.touches[0].clientY };
      }
    }, { passive: true });
    c.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && lastPinch !== null) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.adjustZoom((d / lastPinch - 1) * this._zoom);
        lastPinch = d;
      } else if (e.touches.length === 1 && this._drag.active) {
        this._rot.y += (e.touches[0].clientX - this._drag.lastX) * 0.005 / this._zoom;
        this._rot.x += (e.touches[0].clientY - this._drag.lastY) * 0.003 / this._zoom;
        this._rot.x  = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this._rot.x));
        this._drag.lastX = e.touches[0].clientX; this._drag.lastY = e.touches[0].clientY;
      }
    }, { passive: true });
    c.addEventListener('touchend', () => { this._drag.active = false; lastPinch = null; });
  }

  _updateHover(e) {
    const rect = this._canvas.getBoundingClientRect();
    const W = this._canvas.width, H = this._canvas.height;
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top)  * (H / rect.height);
    const r  = this._r();
    const cx = W / 2, cy = H / 2;
    let found = null;
    this._projectedLocs().forEach(loc => {
      if (!loc.p.visible) return;
      const dx = mx - loc.p.px, dy = my - loc.p.py;
      if (Math.sqrt(dx * dx + dy * dy) < 14) found = loc;
    });
    this._hovered = found;
    this.onHover?.(found ? found : null);
  }

  // ── 内部：Geo 数据加载 ───────────────────────────────────────────────────

  async _loadGeoData() {
    this.onStatusChange?.('正在加载矢量地图...', true);
    try {
      const topo = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json());
      this._geoFeatures = extractGeoArcs(topo);
      this.onStatusChange?.('矢量地图就绪', false);
    } catch (_) {
      this.onStatusChange?.('矢量地图加载失败', false);
    }
  }

  // ── 内部：Tile（CARTO 暗色）──────────────────────────────────────────────

  _latLngToTile(lat, lng, zoom) {
    const z = Math.floor(zoom);
    const n = 2 ** z;
    const x = Math.floor((lng + 180) / 360 * n);
    const lr = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
    return { x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)), z };
  }

  async _fetchTile(tx, ty, tz) {
    const key = `${tz}/${tx}/${ty}`;
    if (this._tileCache.has(key)) return this._tileCache.get(key);
    const s = ['a', 'b', 'c'][Math.abs(tx + ty) % 3];
    try {
      const bmp = await createImageBitmap(await (await fetch(`https://${s}.basemaps.cartocdn.com/dark_all/${tz}/${tx}/${ty}.png`)).blob());
      if (this._tileCache.size > 300) this._tileCache.delete(this._tileCache.keys().next().value);
      this._tileCache.set(key, bmp);
      return bmp;
    } catch { return null; }
  }

  // ── 内部：渲染辅助 ───────────────────────────────────────────────────────

  _r()  { return 230 * this._zoom; }

  _projectedLocs() {
    const r  = this._r();
    const cx = this._canvas.width / 2, cy = this._canvas.height / 2;
    return this._servers.map(s => {
      const { lat, lng } = locationToLatLng(s.location);
      return { ...s, lat, lng, p: project3d(lat, lng, r, cx, cy, this._rot.y, this._rot.x) };
    });
  }

  // ── 内部：主绘制循环 ─────────────────────────────────────────────────────

  _loop() {
    const canvas = this._canvas, ctx = this._ctx;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

    const draw = () => {
      const r = this._r();
      ctx.clearRect(0, 0, W, H);

      // 海洋球体
      const grad = ctx.createRadialGradient(cx - r * .35, cy - r * .35, r * .08, cx, cy, r);
      grad.addColorStop(0, 'rgba(18,38,68,0.98)');
      grad.addColorStop(1, 'rgba(5,9,18,0.99)');
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();

      // 发光描边
      ctx.beginPath(); ctx.arc(cx, cy, r,     0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(99,179,237,0.32)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r + 1,  0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(99,179,237,0.06)'; ctx.lineWidth = 7; ctx.stroke();

      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r - .5, 0, Math.PI * 2); ctx.clip();

      // 经纬网格
      this._drawGrid(ctx, r, cx, cy);

      // 国家轮廓（矢量）
      if (this.opts.showCountries && this._geoFeatures && !this.opts.tileMode) {
        this._drawCountries(ctx, r, cx, cy);
      }

      // 连线弧
      if (this.opts.showLines) this._drawArcs(ctx, r, cx, cy);

      // 节点标记
      this._drawNodes(ctx, r, cx, cy);

      ctx.restore();

      // 缩放指示
      ctx.fillStyle = 'rgba(99,179,237,0.5)';
      ctx.font = '10px Space Mono, monospace';
      ctx.fillText(`${this._zoom.toFixed(2)}×`, W - 48, H - 10);

      if (this.opts.autoSpin && !this._drag.active) this._rot.y += 0.0018;
      this._raf = requestAnimationFrame(draw);
    };

    this._raf = requestAnimationFrame(draw);
  }

  _drawGrid(ctx, r, cx, cy) {
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath(); let f = true;
      for (let lg = -180; lg <= 180; lg += 3) {
        const p = project3d(lat, lg, r, cx, cy, this._rot.y, this._rot.x);
        if (!p.visible) { f = true; continue; }
        f ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py); f = false;
      }
      ctx.strokeStyle = lat === 0 ? 'rgba(99,179,237,0.2)' : 'rgba(99,179,237,0.07)';
      ctx.lineWidth   = lat === 0 ? 0.8 : 0.4; ctx.stroke();
    }
    for (let lg = -180; lg < 180; lg += 30) {
      ctx.beginPath(); let f = true;
      for (let la = -85; la <= 85; la += 3) {
        const p = project3d(la, lg, r, cx, cy, this._rot.y, this._rot.x);
        if (!p.visible) { f = true; continue; }
        f ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py); f = false;
      }
      ctx.strokeStyle = 'rgba(99,179,237,0.055)'; ctx.lineWidth = 0.35; ctx.stroke();
    }
  }

  _drawCountries(ctx, r, cx, cy) {
    ctx.strokeStyle = 'rgba(99,179,237,0.30)'; ctx.lineWidth = 0.7;
    this._geoFeatures.forEach(arc => {
      ctx.beginPath(); let f = true;
      arc.forEach(([lng, lat]) => {
        const p = project3d(lat, lng, r, cx, cy, this._rot.y, this._rot.x);
        if (!p.visible) { f = true; return; }
        f ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py); f = false;
      });
      ctx.stroke();
    });
  }

  _drawArcs(ctx, r, cx, cy) {
    const locs = this._projectedLocs().filter(l => l.status !== 'offline');
    const t    = (Date.now() % 2400) / 2400;
    for (let i = 0; i < locs.length; i++) {
      for (let j = i + 1; j < locs.length; j++) {
        const a = locs[i], b = locs[j];
        if (!a.p.visible || !b.p.visible) continue;
        const mx = (a.p.px + b.p.px) / 2, my = (a.p.py + b.p.py) / 2;
        const dist = Math.hypot(b.p.px - a.p.px, b.p.py - a.p.py);
        const lift = Math.min(dist * 0.38, 75);
        const grad = ctx.createLinearGradient(a.p.px, a.p.py, b.p.px, b.p.py);
        grad.addColorStop(0,                     'rgba(99,179,237,0)');
        grad.addColorStop(t,                     'rgba(99,179,237,0.75)');
        grad.addColorStop(Math.min(1, t + .14),  'rgba(255,255,255,0.5)');
        grad.addColorStop(Math.min(1, t + .28),  'rgba(99,179,237,0)');
        grad.addColorStop(1,                     'rgba(99,179,237,0)');
        ctx.beginPath(); ctx.moveTo(a.p.px, a.p.py);
        ctx.quadraticCurveTo(mx, my - lift, b.p.px, b.p.py);
        ctx.strokeStyle = grad; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  }

  _drawNodes(ctx, r, cx, cy) {
    const COL = { online: '#38ef7d', warn: '#ff9f43', offline: '#ff6b6b' };
    this._projectedLocs().forEach(loc => {
      if (!loc.p.visible) return;
      const col      = COL[loc.status] || '#aaa';
      const isHover  = this._hovered?.id === loc.id;
      const sz       = isHover ? 10 : 6.5;
      const pingR    = sz + 4 + Math.sin(Date.now() * .004 + loc.lat) * 2.5;

      ctx.beginPath(); ctx.arc(loc.p.px, loc.p.py, pingR, 0, Math.PI * 2);
      ctx.strokeStyle = col + (loc.status === 'online' ? '55' : '22');
      ctx.lineWidth = 1; ctx.stroke();

      ctx.beginPath(); ctx.arc(loc.p.px, loc.p.py, sz, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      if (isHover) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }

      if (this._zoom > 0.6) {
        ctx.fillStyle = 'rgba(226,232,240,0.9)';
        ctx.font = `${isHover ? 11 : 10}px Space Mono, monospace`;
        ctx.fillText(`${loc.flag} ${loc.name}`, loc.p.px + sz + 4, loc.p.py + 4);
      }
    });
  }
}
