import React, { useEffect, useRef, useState, useCallback } from "react";

// ─── Default server data ────────────────────────────────────────────────────
const DEFAULT_SERVERS = [
  { id:1,  name:"LA-Pro-01",     flag:"🇺🇸", location:"美国洛杉矶",    ip:"104.21.45.67",  cpu_use:34, ram_use:62, net_up:12.4, net_down:89.2,  status:"online"  },
  { id:2,  name:"HK-Node-02",    flag:"🇭🇰", location:"香港",          ip:"43.155.88.12",  cpu_use:78, ram_use:88, net_up:45.1, net_down:120.5, status:"warn"    },
  { id:3,  name:"JP-Sakura-03",  flag:"🇯🇵", location:"日本东京",      ip:"27.0.234.55",   cpu_use:22, ram_use:41, net_up:8.9,  net_down:56.3,  status:"online"  },
  { id:4,  name:"DE-Hetzner-04", flag:"🇩🇪", location:"德国法兰克福",  ip:"95.216.12.88",  cpu_use:15, ram_use:33, net_up:5.2,  net_down:30.1,  status:"online"  },
  { id:5,  name:"SG-Linode-05",  flag:"🇸🇬", location:"新加坡",        ip:"172.104.55.99", cpu_use:5,  ram_use:55, net_up:2.1,  net_down:18.5,  status:"offline" },
  { id:6,  name:"US-OVH-06",     flag:"🇺🇸", location:"美国纽约",      ip:"51.81.22.44",   cpu_use:48, ram_use:71, net_up:25.0, net_down:180.0, status:"online"  },
  { id:7,  name:"UK-Node-07",    flag:"🇬🇧", location:"英国伦敦",      ip:"178.62.10.55",  cpu_use:30, ram_use:50, net_up:18.0, net_down:95.0,  status:"online"  },
  { id:8,  name:"KR-Seoul-08",   flag:"🇰🇷", location:"韩国首尔",      ip:"49.236.200.22", cpu_use:60, ram_use:75, net_up:33.0, net_down:140.0, status:"warn"    },
  { id:9,  name:"AU-Sydney-09",  flag:"🇦🇺", location:"澳大利亚悉尼",  ip:"139.99.11.88",  cpu_use:12, ram_use:28, net_up:4.5,  net_down:22.0,  status:"online"  },
  { id:10, name:"BR-SP-10",      flag:"🇧🇷", location:"巴西圣保罗",    ip:"200.143.55.11", cpu_use:20, ram_use:40, net_up:7.0,  net_down:45.0,  status:"online"  },
  { id:11, name:"IN-Mumbai-11",  flag:"🇮🇳", location:"印度孟买",      ip:"103.21.76.44",  cpu_use:55, ram_use:65, net_up:10.0, net_down:60.0,  status:"online"  },
  { id:12, name:"NL-AMS-12",     flag:"🇳🇱", location:"荷兰阿姆斯特丹",ip:"37.120.222.88", cpu_use:18, ram_use:38, net_up:6.5,  net_down:35.0,  status:"online"  },
];

// ─── Lat/Lng lookup ─────────────────────────────────────────────────────────
const LOC_MAP = {
  "洛杉矶":    { lat: 34.05, lng: -118.24 },
  "纽约":      { lat: 40.71, lng: -74.01  },
  "香港":      { lat: 22.32, lng: 114.17  },
  "东京":      { lat: 35.69, lng: 139.69  },
  "新加坡":    { lat:  1.35, lng: 103.82  },
  "法兰克福":  { lat: 50.11, lng:   8.68  },
  "伦敦":      { lat: 51.51, lng:  -0.13  },
  "首尔":      { lat: 37.57, lng: 126.98  },
  "悉尼":      { lat:-33.87, lng: 151.21  },
  "圣保罗":    { lat:-23.55, lng: -46.63  },
  "孟买":      { lat: 19.08, lng:  72.88  },
  "阿姆斯特丹":{ lat: 52.37, lng:   4.90  },
};

function locationToLatLng(loc, server = {}) {
  const directLat = Number(server.lat ?? server.latitude ?? server.geo?.lat ?? server.agent_config?.lat ?? server.agent_config?.inventory_meta?.lat);
  const directLng = Number(server.lng ?? server.lon ?? server.longitude ?? server.geo?.lng ?? server.geo?.lon ?? server.agent_config?.lon ?? server.agent_config?.inventory_meta?.lon);
  if (Number.isFinite(directLat) && Number.isFinite(directLng) && Math.abs(directLat) <= 90 && Math.abs(directLng) <= 180 && !(directLat === 0 && directLng === 0)) {
    return { lat: directLat, lng: directLng };
  }
  const text = String(loc || server.location || server.city || server.region || server.country || server.name || '');
  for (const key in LOC_MAP) {
    if (text.includes(key)) return LOC_MAP[key];
  }
  return null;
}

// ─── 3D projection ───────────────────────────────────────────────────────────
function project3d(lat, lng, r, cx, cy, rotY, rotX) {
  const phi   = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  let x = -Math.sin(phi) * Math.cos(theta);
  let y =  Math.cos(phi);
  let z =  Math.sin(phi) * Math.sin(theta);
  const cY = Math.cos(rotY), sY = Math.sin(rotY);
  const x2 = x * cY - z * sY, z2 = x * sY + z * cY;
  const cX = Math.cos(rotX), sX = Math.sin(rotX);
  const y2 = y * cX - z2 * sX, z3 = y * sX + z2 * cX;
  return { px: cx + x2 * r, py: cy + y2 * r, z: z3, visible: z3 < 0.18 };
}

// ─── TopoJSON extractor ──────────────────────────────────────────────────────
function extractArcs(topo) {
  const sc = topo.transform ? topo.transform.scale     : [1, 1];
  const tr = topo.transform ? topo.transform.translate : [0, 0];
  const decoded = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(pt => { x += pt[0]; y += pt[1]; return [x*sc[0]+tr[0], y*sc[1]+tr[1]]; });
  });
  const countries = topo.objects.countries;
  if (!countries) return decoded.slice(0, 500);
  const result = [];
  function collect(geom) {
    if (!geom) return;
    if (geom.type === "GeometryCollection") { geom.geometries.forEach(collect); return; }
    const rings = geom.type === "Polygon"
      ? geom.arcs
      : geom.type === "MultiPolygon" ? geom.arcs.flat() : [];
    rings.forEach(ring => {
      const pts = [];
      ring.forEach(idx => {
        const a = idx < 0 ? [...decoded[~idx]].reverse() : decoded[idx];
        pts.push(...a);
      });
      if (pts.length > 1) result.push(pts);
    });
  }
  if (countries.geometries) countries.geometries.forEach(collect);
  return result;
}

// ─── Tile helpers ────────────────────────────────────────────────────────────
function latLngToTile(lat, lng, z) {
  const n  = Math.pow(2, z);
  const x  = Math.floor((lng + 180) / 360 * n);
  const lr = lat * Math.PI / 180;
  const y  = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  return { x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)), z };
}

// ─── Status colors ───────────────────────────────────────────────────────────
const STATUS_COLOR = { online: "#38ef7d", warn: "#ff9f43", offline: "#ff6b6b" };
const STATUS_LABEL = { online: "在线", warn: "预警", offline: "离线" };

function currentTheme() {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") || document.body?.dataset?.theme || "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const update = () => setTheme(currentTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("storage", update);
    return () => { observer.disconnect(); window.removeEventListener("storage", update); };
  }, []);
  return theme;
}

// ─── NodeCard sub-component ──────────────────────────────────────────────────
function NodeCard({ server, isLight = false }) {
  const col = STATUS_COLOR[server.status] || "#aaa";
  return (
    <div style={{
      background: "rgba(13,21,37,0.92)",
      border: isLight ? "1px solid rgba(38,99,108,0.24)" : "1px solid rgba(99,179,237,0.15)",
      borderRadius: 10,
      padding: "12px 14px",
      position: "relative",
      overflow: "hidden",
      transition: "border-color .2s, transform .15s",
      cursor: "default",
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(99,179,237,0.3)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(99,179,237,0.15)"; e.currentTarget.style.transform = "translateY(0)"; }}
    >
      {/* Status top bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 2,
        background: col,
      }} />
      <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginBottom: 2 }}>
        {server.flag} {server.name}
      </div>
      <div style={{ fontSize: 11, color: "#63b3ed", marginBottom: 6 }}>
        {server.location}
      </div>
      <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", lineHeight: 1.9 }}>
        CPU: <span style={{ color: isLight ? "#2f4e55" : "#94a3b8" }}>{server.cpu_use.toFixed(1)}%</span>
        {" "}&nbsp;MEM: <span style={{ color: isLight ? "#2f4e55" : "#94a3b8" }}>{server.ram_use.toFixed(1)}%</span><br />
        ↑<span style={{ color: isLight ? "#2f4e55" : "#94a3b8" }}>{server.net_up.toFixed(1)}</span>
        {" "}↓<span style={{ color: isLight ? "#2f4e55" : "#94a3b8" }}>{server.net_down.toFixed(1)}</span> MB/s<br />
        <span style={{ color: col }}>● {STATUS_LABEL[server.status]}</span>
      </div>
    </div>
  );
}

// ─── Toggle sub-component ────────────────────────────────────────────────────
function Toggle({ label, checked, onChange, isLight = false }) {
  const shellBg = isLight ? "rgba(255,249,236,0.86)" : "#111d33";
  const shellBorder = isLight ? "rgba(38,99,108,.28)" : "rgba(99,179,237,0.15)";
  const textColor = isLight ? "#31585f" : "#8ea7c7";
  const accent = isLight ? "#0b6670" : "#63b3ed";
  const offTrack = isLight ? "#eadfc6" : "#070b14";
  const offKnob = isLight ? "#8a7355" : "#64748b";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      background: shellBg,
      border: `1px solid ${shellBorder}`,
      borderRadius: 8, padding: "6px 12px",
      fontSize: 11, color: textColor, userSelect: "none",
    }}>
      {label}
      <label style={{ position: "relative", display: "inline-block", width: 36, height: 20, cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
          style={{ opacity: 0, width: 0, height: 0 }} />
        <span style={{
          position: "absolute", inset: 0,
          background: checked ? (isLight ? "rgba(11,102,112,.18)" : "rgba(99,179,237,0.2)") : offTrack,
          border: `1px solid ${checked ? accent : shellBorder}`,
          borderRadius: 20, transition: ".2s",
        }}>
          <span style={{
            position: "absolute",
            width: 14, height: 14,
            left: checked ? 18 : 2, top: 2,
            background: checked ? accent : offKnob,
            borderRadius: "50%", transition: ".2s",
          }} />
        </span>
      </label>
    </div>
  );
}

// ─── Main GlobeStarmap component ─────────────────────────────────────────────
export default function GlobeStarmap({
  servers: serversProp,
  width   = 900,
  height  = 520,
  baseRadius = 230,
  showInfoPanel = true,
  originServerId = null,
}) {
  const servers = Array.isArray(serversProp) ? serversProp : [];
  const theme = useDocumentTheme();
  const isLight = theme === "light";

  // ── UI state ──────────────────────────────────────────────────────────────
  const [showLines,     setShowLines]     = useState(true);
  const [autoSpin,      setAutoSpin]      = useState(true);
  const [showCountries, setShowCountries] = useState(true);
  const [zoom,          setZoom]          = useState(0.68);
  const [status,        setStatus]        = useState("正在初始化...");
  const [spinning,      setSpinning]      = useState(false);
  const [liveServers,   setLiveServers]   = useState(() =>
    servers.map(s => ({ ...s }))
  );
  const [tooltip, setTooltip] = useState(null); // { loc, px, py }

  // ── Canvas & refs ─────────────────────────────────────────────────────────
  const canvasRef  = useRef(null);
  const dpr = typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;
  const internalWidth = Math.round(width * dpr);
  const internalHeight = Math.round(height * dpr);
  const stateRef   = useRef({
    rotY: 0.4, rotX: 0.18,
    dragging: false, lastX: 0, lastY: 0,
    animFrame: null,
    geoFeatures: null, geoReady: false,
    tileCache: new Map(),
    fetchCount: 0, lastFetch: null,
    fetchTimer: null,
    // mirrors of React state for use inside rAF closure
    showLines: true, autoSpin: true, showCountries: true,
    tileMode: false, zoom: 0.68,
    liveServers: servers.map(s => ({ ...s })),
    hovered: null,
  });

  // Keep stateRef mirrors in sync with React state
  useEffect(() => { stateRef.current.showLines     = showLines;     }, [showLines]);
  useEffect(() => { stateRef.current.autoSpin      = autoSpin;      }, [autoSpin]);
  useEffect(() => { stateRef.current.showCountries = showCountries; }, [showCountries]);
  useEffect(() => { stateRef.current.zoom          = zoom;          }, [zoom]);
  useEffect(() => { stateRef.current.liveServers   = liveServers;   }, [liveServers]);
  useEffect(() => {
    const normalized = servers.map(s => ({ ...s }));
    setLiveServers(normalized);
    stateRef.current.liveServers = normalized;
  }, [servers]);

  // ── Tile helpers ──────────────────────────────────────────────────────────
  const fetchTile = useCallback(async (tx, ty, tz) => {
    const key = `${tz}/${tx}/${ty}`;
    const cache = stateRef.current.tileCache;
    if (cache.has(key)) return cache.get(key);
    const s = ["a","b","c"][Math.abs(tx + ty) % 3];
    try {
      const bmp = await createImageBitmap(
        await (await fetch(`https://${s}.basemaps.cartocdn.com/dark_all/${tz}/${tx}/${ty}.png`)).blob()
      );
      cache.set(key, bmp);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return bmp;
    } catch { return null; }
  }, []);

  const prefetchTiles = useCallback(async () => {
    const S = stateRef.current;
    if (!S.tileMode) return;
    const tz = Math.max(0, Math.min(5, Math.floor(S.zoom * 2)));
    const tasks = [];
    for (let lat = -75; lat <= 75; lat += 30)
      for (let dlng = -150; dlng <= 150; dlng += 30) {
        const lng = ((S.rotY * 180 / Math.PI + dlng + 180) % 360) - 180;
        const { x, y, z } = latLngToTile(lat, lng, tz);
        const key = `${z}/${x}/${y}`;
        if (!S.tileCache.has(key)) tasks.push(fetchTile(x, y, z));
      }
    await Promise.allSettled(tasks);
  }, [fetchTile]);

  // ── Geo data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const S = stateRef.current;
    if (S.geoReady) return;
    setStatus("正在加载矢量地图..."); setSpinning(true);
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then(r => r.json())
      .then(topo => {
        S.geoFeatures = extractArcs(topo);
        S.geoReady = true;
        setStatus("矢量地图就绪"); setSpinning(false);
      })
      .catch(() => { setStatus("矢量地图加载失败"); setSpinning(false); });
  }, []);

  // ── Zoom helpers ──────────────────────────────────────────────────────────
  const adjustZoom = useCallback((d) => {
    setZoom(prev => {
      const next = Math.max(0.4, Math.min(3.5, prev + d));
      stateRef.current.zoom = next;
      prefetchTiles();
      return next;
    });
  }, [prefetchTiles]);

  // ── Canvas draw loop ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = internalWidth, H = internalHeight;
    const cx = W / 2;
    // Visual centering: keep globe balanced inside the canvas at the 0.68 default zoom.
    const cy = H / 2;

    // ── Pointer events ──────────────────────────────────────────────────────
    const onDown = e => {
      const S = stateRef.current;
      S.dragging = true;
      S.lastX = e.clientX; S.lastY = e.clientY;
      canvas.style.cursor = "grabbing";
    };
    const onUp = () => {
      stateRef.current.dragging = false;
      canvas.style.cursor = "grab";
    };
    const onMove = e => {
      const S = stateRef.current;
      if (S.dragging) {
        S.rotY += (e.clientX - S.lastX) * 0.005 / S.zoom;
        S.rotX += (e.clientY - S.lastY) * 0.003 / S.zoom;
        // free vertical 360° tumble: no clamp
        S.lastX = e.clientX; S.lastY = e.clientY;
      }
      // Hover detection
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (internalWidth / rect.width);
      const my = (e.clientY - rect.top)  * (internalHeight / rect.height);
      const r  = baseRadius * S.zoom;
      let found = null;
      S.liveServers.forEach(loc => {
        const ll = locationToLatLng(loc.location, loc);
        if (!ll) return;
        const p  = project3d(ll.lat, ll.lng, r, cx, cy, S.rotY, S.rotX);
        if (!p.visible) return;
        if (Math.sqrt((mx - p.px)**2 + (my - p.py)**2) < 14 * dpr) {
          found = { loc, px: e.clientX - rect.left, py: e.clientY - rect.top };
        }
      });
      S.hovered = found;
      setTooltip(found);
    };
    const onWheel = e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.12 : 0.12;
      const S = stateRef.current;
      S.zoom = Math.max(0.4, Math.min(3.5, S.zoom + delta));
      setZoom(S.zoom);
      prefetchTiles();
    };

    // Touch
    let lastPinch = null;
    const onTouchStart = e => {
      const S = stateRef.current;
      if (e.touches.length === 2) {
        lastPinch = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      } else if (e.touches.length === 1) {
        S.dragging = true;
        S.lastX = e.touches[0].clientX;
        S.lastY = e.touches[0].clientY;
      }
    };
    const onTouchMove = e => {
      const S = stateRef.current;
      if (e.touches.length === 2 && lastPinch) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        S.zoom = Math.max(0.4, Math.min(3.5, S.zoom * (d / lastPinch)));
        setZoom(S.zoom);
        lastPinch = d;
      } else if (e.touches.length === 1 && S.dragging) {
        S.rotY += (e.touches[0].clientX - S.lastX) * 0.005 / S.zoom;
        S.rotX += (e.touches[0].clientY - S.lastY) * 0.003 / S.zoom;
        // free vertical 360° tumble: no clamp
        S.lastX = e.touches[0].clientX;
        S.lastY = e.touches[0].clientY;
      }
    };
    const onTouchEnd = () => { stateRef.current.dragging = false; lastPinch = null; };

    canvas.addEventListener("mousedown",  onDown);
    canvas.addEventListener("mouseup",    onUp);
    canvas.addEventListener("mouseleave", onUp);
    canvas.addEventListener("mousemove",  onMove);
    canvas.addEventListener("wheel",      onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove",  onTouchMove,  { passive: true });
    canvas.addEventListener("touchend",   onTouchEnd);

    // ── Draw ────────────────────────────────────────────────────────────────
    function draw() {
      const S  = stateRef.current;
      const r  = baseRadius * S.zoom;
      const ls = S.liveServers;

      ctx.clearRect(0, 0, W, H);

      const lightMode = currentTheme() === "light";
      // Ocean sphere
      const sph = ctx.createRadialGradient(cx - r*0.35, cy - r*0.35, r*0.08, cx, cy, r);
      if (lightMode) {
        sph.addColorStop(0, "rgba(182,223,218,0.98)");
        sph.addColorStop(0.56, "rgba(119,181,185,0.93)");
        sph.addColorStop(1, "rgba(69,123,136,0.92)");
      } else {
        sph.addColorStop(0, "rgba(18,38,68,0.98)");
        sph.addColorStop(1, "rgba(5,9,18,0.99)");
      }
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = sph; ctx.fill();

      // Glow border
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = lightMode ? "rgba(21,91,101,0.42)" : "rgba(99,179,237,0.32)"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
      ctx.strokeStyle = lightMode ? "rgba(21,91,101,0.16)" : "rgba(99,179,237,0.06)"; ctx.lineWidth = 7; ctx.stroke();

      // Clip to sphere
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2); ctx.clip();

      // Raster tile mode
      if (S.tileMode && S.tileCache.size > 0) {
        const tz   = Math.max(0, Math.min(5, Math.floor(S.zoom * 2)));
        const step = 3;
        for (let lat = -85; lat < 85; lat += step) {
          for (let lng = -180; lng < 180; lng += step) {
            const p0 = project3d(lat,       lng,       r, cx, cy, S.rotY, S.rotX);
            const p1 = project3d(lat + step, lng,       r, cx, cy, S.rotY, S.rotX);
            const p2 = project3d(lat + step, lng + step, r, cx, cy, S.rotY, S.rotX);
            const p3 = project3d(lat,        lng + step, r, cx, cy, S.rotY, S.rotX);
            if (!p0.visible && !p1.visible && !p2.visible && !p3.visible) continue;
            const { x: tx, y: ty, z: tz2 } = latLngToTile(lat + step/2, lng + step/2, tz);
            const bmp = S.tileCache.get(`${tz2}/${tx}/${ty}`);
            if (!bmp) { fetchTile(tx, ty, tz2); continue; }
            const n  = Math.pow(2, tz2);
            const u0 = (lng / 360 + 0.5) * n - tx;
            const v0 = ((1 - Math.log(Math.tan((lat+step)*Math.PI/180) + 1/Math.cos((lat+step)*Math.PI/180)) / Math.PI) / 2) * n - ty;
            const u1 = ((lng+step) / 360 + 0.5) * n - tx;
            const v1 = ((1 - Math.log(Math.tan(lat*Math.PI/180) + 1/Math.cos(lat*Math.PI/180)) / Math.PI) / 2) * n - ty;
            const tW = bmp.width, tH = bmp.height;
            const sx = Math.max(0, u0*tW), sy = Math.max(0, v0*tH);
            const sw = Math.min(tW - sx, (u1 - u0)*tW), sh = Math.min(tH - sy, (v1 - v0)*tH);
            if (sw <= 0 || sh <= 0) continue;
            try {
              ctx.save();
              ctx.beginPath();
              ctx.moveTo(p0.px, p0.py); ctx.lineTo(p1.px, p1.py);
              ctx.lineTo(p2.px, p2.py); ctx.lineTo(p3.px, p3.py);
              ctx.closePath(); ctx.clip();
              const pw = Math.abs(p3.px - p0.px) + Math.abs(p2.px - p1.px);
              const ph = Math.abs(p1.py - p0.py) + Math.abs(p2.py - p3.py);
              ctx.drawImage(bmp, sx, sy, Math.max(1, sw), Math.max(1, sh),
                Math.min(p0.px, p3.px), Math.min(p0.py, p1.py), Math.max(4, pw), Math.max(4, ph));
              ctx.restore();
            } catch (_) {}
          }
        }
      }

      // Lat/Lng grid
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath(); let f = true;
        for (let lg = -180; lg <= 180; lg += 3) {
          const p = project3d(lat, lg, r, cx, cy, S.rotY, S.rotX);
          if (!p.visible) { f = true; continue; }
          if (f) { ctx.moveTo(p.px, p.py); f = false; } else ctx.lineTo(p.px, p.py);
        }
        ctx.strokeStyle = lat === 0 ? (lightMode ? "rgba(255,255,246,0.54)" : "rgba(99,179,237,0.22)") : (lightMode ? "rgba(255,255,246,0.24)" : "rgba(99,179,237,0.07)");
        ctx.lineWidth   = lat === 0 ? 0.8 : 0.4;
        ctx.stroke();
      }
      for (let lg = -180; lg < 180; lg += 30) {
        ctx.beginPath(); let f2 = true;
        for (let la = -85; la <= 85; la += 3) {
          const p = project3d(la, lg, r, cx, cy, S.rotY, S.rotX);
          if (!p.visible) { f2 = true; continue; }
          if (f2) { ctx.moveTo(p.px, p.py); f2 = false; } else ctx.lineTo(p.px, p.py);
        }
        ctx.strokeStyle = lightMode ? "rgba(255,255,246,0.18)" : "rgba(99,179,237,0.055)"; ctx.lineWidth = 0.35; ctx.stroke();
      }

      // Country outlines
      if (S.showCountries && S.geoFeatures && !S.tileMode) {
        ctx.strokeStyle = lightMode ? "rgba(255,255,246,0.58)" : "rgba(99,179,237,0.30)"; ctx.lineWidth = 0.7;
        S.geoFeatures.forEach(arc => {
          ctx.beginPath(); let fp = true;
          arc.forEach(([ln, la]) => {
            const p = project3d(la, ln, r, cx, cy, S.rotY, S.rotX);
            if (!p.visible) { fp = true; return; }
            if (fp) { ctx.moveTo(p.px, p.py); fp = false; } else ctx.lineTo(p.px, p.py);
          });
          ctx.stroke();
        });
      }

      // Connection arcs
      if (S.showLines) {
        const projLocs = ls.map(s => {
          const ll = locationToLatLng(s.location, s);
          if (!ll) return null;
          return { ...s, p: project3d(ll.lat, ll.lng, r, cx, cy, S.rotY, S.rotX) };
        });
        const validProjLocs = projLocs.filter(Boolean);
        const origin = originServerId == null
          ? validProjLocs[0]
          : validProjLocs.find(s => String(s.id) === String(originServerId)) || validProjLocs[0];
        window.__DETAIL_STARMAP_ORIGIN__ = origin ? { id: origin.id, name: origin.name } : null;
        const arcPairs = origin ? validProjLocs.filter(s => String(s.id) !== String(origin.id)).map(target => [origin, target]) : [];
        window.__DETAIL_STARMAP_ARCS__ = arcPairs.map(([a, b]) => ({ from: a.name, fromId: a.id, to: b.name, toId: b.id }));
        for (const [a, b] of arcPairs) {
          if (a.status === "offline" || b.status === "offline") continue;
          if (!a.p.visible || !b.p.visible) continue;
          const mx2  = (a.p.px + b.p.px) / 2, my2 = (a.p.py + b.p.py) / 2;
          const dist = Math.sqrt((b.p.px - a.p.px)**2 + (b.p.py - a.p.py)**2);
          const lift = Math.min(dist * 0.38, 75);
          const t    = (Date.now() % 2400) / 2400;
          const grad = ctx.createLinearGradient(a.p.px, a.p.py, b.p.px, b.p.py);
          grad.addColorStop(0,                   "rgba(99,179,237,0)");
          grad.addColorStop(t,                   "rgba(104,246,255,0.95)");
          grad.addColorStop(Math.min(1, t+0.14), "rgba(255,255,255,0.78)");
          grad.addColorStop(Math.min(1, t+0.28), "rgba(99,179,237,0)");
          grad.addColorStop(1,                   "rgba(99,179,237,0)");
          ctx.beginPath();
          ctx.moveTo(a.p.px, a.p.py);
          ctx.quadraticCurveTo(mx2, my2 - lift, b.p.px, b.p.py);
          ctx.strokeStyle = grad; ctx.lineWidth = 1.8; ctx.stroke();
        }
      }

      // Node markers
      ls.forEach(s => {
        const ll  = locationToLatLng(s.location, s);
        if (!ll) return;
        const p   = project3d(ll.lat, ll.lng, r, cx, cy, S.rotY, S.rotX);
        if (!p.visible) return;
        const col = STATUS_COLOR[s.status] || "#aaa";
        const isH = S.hovered && S.hovered.loc.id === s.id;
        const sz  = isH ? 12 : 8.2;

        // Pulse ring
        const pr = sz + 6 + Math.sin(Date.now() * 0.004 + ll.lat) * 3.4;
        ctx.beginPath(); ctx.arc(p.px, p.py, pr, 0, Math.PI * 2);
        ctx.strokeStyle = col + (s.status === "online" ? "88" : "44");
        ctx.lineWidth = 1.8; ctx.stroke();

        // Core dot
        ctx.beginPath(); ctx.arc(p.px, p.py, sz, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
        if (isH) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }

        // Label
        if (S.zoom > 0.6) {
          ctx.fillStyle = lightMode ? "rgba(18,50,56,0.95)" : "rgba(226,232,240,0.9)";
          ctx.font = `${isH ? 11 : 10}px monospace`;
          ctx.fillText(s.flag + " " + s.name, p.px + sz + 4, p.py + 4);
        }
      });

      ctx.restore();

      // Zoom indicator
      ctx.fillStyle = lightMode ? "rgba(25,91,103,0.70)" : "rgba(99,179,237,0.45)";
      ctx.font = "10px monospace";
      ctx.fillText(S.zoom.toFixed(2) + "×", W - 52, H - 12);

      if (S.autoSpin && !S.dragging) S.rotY += 0.0018;
      window.__DETAIL_STARMAP_RENDER_INFO__ = { dpr, width, height, internalWidth, internalHeight };
      S.animFrame = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      if (stateRef.current.animFrame) cancelAnimationFrame(stateRef.current.animFrame);
      canvas.removeEventListener("mousedown",  onDown);
      canvas.removeEventListener("mouseup",    onUp);
      canvas.removeEventListener("mouseleave", onUp);
      canvas.removeEventListener("mousemove",  onMove);
      canvas.removeEventListener("wheel",      onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove",  onTouchMove);
      canvas.removeEventListener("touchend",   onTouchEnd);
    };
  }, [baseRadius, fetchTile, prefetchTiles, theme]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const toolbarBg = isLight ? "rgba(255,249,236,0.86)" : "#111d33";
  const toolbarBorder = isLight ? "rgba(38,99,108,.28)" : "rgba(99,179,237,0.15)";
  const toolbarAccent = isLight ? "#0b6670" : "#63b3ed";
  const toolbarMuted = isLight ? "#5f7064" : "#8ea7c7";
  const btnStyle = {
    padding: "5px 14px", borderRadius: 7,
    background: toolbarBg,
    border: `1px solid ${isLight ? "rgba(38,99,108,.30)" : "rgba(99,179,237,0.3)"}`,
    color: toolbarAccent, fontSize: 12, cursor: "pointer",
    fontFamily: "monospace",
    transition: "background .15s, color .15s, border-color .15s",
  };

  return (
    <div style={{
      background: isLight ? "linear-gradient(180deg,#f7f0dc,#eadfc6)" : "#070b14",
      color: isLight ? "#203438" : "#e2e8f0",
      fontFamily: "'Noto Sans SC', sans-serif",
      padding: "1.25rem",
      borderRadius: 16,
      minWidth: 0,
    }}>


      {/* ── Toolbar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        flexWrap: "wrap", marginBottom: "0.875rem",
      }}>
        <Toggle label="连线" checked={showLines}     onChange={setShowLines} isLight={isLight} />
        <Toggle label="旋转" checked={autoSpin}      onChange={setAutoSpin} isLight={isLight} />
        <Toggle label="国家" checked={showCountries} onChange={setShowCountries} isLight={isLight} />

        {/* Zoom */}
        <div style={{
          display: "flex", alignItems: "center",
          background: toolbarBg,
          border: `1px solid ${toolbarBorder}`,
          borderRadius: 8, overflow: "hidden",
        }}>
          <button onClick={() => adjustZoom(-0.2)}
            style={{ ...btnStyle, border: "none", borderRight: `1px solid ${toolbarBorder}`, borderRadius: 0, padding: "5px 10px" }}>−</button>
          <span style={{ padding: "4px 10px", fontSize: 11, fontFamily: "monospace", color: toolbarMuted, minWidth: 48, textAlign: "center" }}>
            {zoom.toFixed(2)}×
          </span>
          <button onClick={() => adjustZoom(+0.2)}
            style={{ ...btnStyle, border: "none", borderLeft: `1px solid ${toolbarBorder}`, borderRadius: 0, padding: "5px 10px" }}>+</button>
        </div>

        {/* Status */}
        {spinning && (
          <div style={{
            width: 14, height: 14, borderRadius: "50%",
            border: `2px solid ${isLight ? "rgba(11,102,112,.16)" : "rgba(99,179,237,0.2)"}`,
            borderTopColor: toolbarAccent,
            animation: "spin .7s linear infinite",
          }} />
        )}
        <span style={{ fontSize: 11, color: toolbarMuted, fontFamily: "monospace" }}>{status}</span>
      </div>

      {/* ── Globe + Legend + Tooltip ── */}
      <div style={{ position: "relative", display: "flex", justifyContent: "center" }}>
        <canvas
          ref={canvasRef}
          width={internalWidth}
          height={internalHeight}
          style={{
            display: "block",
            cursor: "grab",
            borderRadius: 16,
            border: "1px solid rgba(99,179,237,0.15)",
            maxWidth: "100%",
            width: `${width}px`,
            height: `${height}px`,
          }}
        />


        {/* Tooltip */}
        {tooltip && (
          <div style={{
            position: "absolute",
            left: tooltip.px + 16,
            top:  tooltip.py - 10,
            background: isLight ? "rgba(250,244,226,0.96)" : "rgba(13,21,37,0.96)",
            border: isLight ? "1px solid rgba(38,99,108,0.32)" : "1px solid rgba(99,179,237,0.3)",
            borderRadius: 10, padding: "10px 14px",
            pointerEvents: "none", zIndex: 10,
            minWidth: 180,
            backdropFilter: "blur(8px)",
            boxShadow: "0 8px 32px rgba(0,0,0,.5)",
          }}>
            <div style={{ fontWeight: 700, color: isLight ? "#1e353a" : "#e2e8f0", fontSize: 13, marginBottom: 3 }}>
              {tooltip.loc.flag} {tooltip.loc.name}
            </div>
            <div style={{ fontSize: 12, color: isLight ? "#0b6670" : "#63b3ed", marginBottom: 5 }}>
              {tooltip.loc.location}
            </div>
            <div style={{ color: STATUS_COLOR[tooltip.loc.status], fontSize: 11, marginBottom: 5 }}>
              ● {STATUS_LABEL[tooltip.loc.status]}
            </div>
            <div style={{ fontSize: 11, color: isLight ? "#2f4e55" : "#94a3b8", lineHeight: 1.9, fontFamily: "monospace" }}>
              IP: {tooltip.loc.ip}<br />
              CPU: {tooltip.loc.cpu_use.toFixed(1)}% &nbsp; MEM: {tooltip.loc.ram_use.toFixed(1)}%<br />
              ↑{tooltip.loc.net_up.toFixed(1)} &nbsp; ↓{tooltip.loc.net_down.toFixed(1)} MB/s
            </div>
          </div>
        )}
      </div>

      {/* ── Info panel ── */}
      {showInfoPanel && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
          gap: 10,
          marginTop: "1.25rem",
        }}>
          {liveServers.map(s => <NodeCard key={s.id} server={s} isLight={isLight} />)}
        </div>
      )}

      {/* Spin keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
