/**
 * globe-layers.js — Deck.gl 图层定义
 * 霓虹光柱 + 动态飞线 + glow 底环
 */
import { ColumnLayer, ArcLayer, ScatterplotLayer } from '@deck.gl/layers';
import {
  getServerCoords,
  getStatusColor,
  getStatusGlow,
  generateArcData,
  getColumnHeight,
  getColumnRadius,
} from './globe-utils.js';

/**
 * 构建所有 Deck.gl 图层
 * @param {Array} servers - 后端节点数据
 * @param {number} time - 动画时间戳 (performance.now())
 * @param {Function} onColumnClick - 光柱点击回调
 * @returns {Array} Deck.gl Layer 数组
 */
export function buildGlobeLayers(servers, time, onColumnClick) {
  if (!servers || servers.length === 0) return [];

  const nodeData = servers.map(s => {
    const [lat, lon] = getServerCoords(s);
    return { ...s, lat, lon };
  });

  const arcData = generateArcData(servers);

  return [
    // ── 底部发光环：ScatterplotLayer ──────────────────────────────────
    new ScatterplotLayer({
      id: 'node-glow-ring',
      data: nodeData,
      getPosition: d => [d.lon, d.lat],
      getRadius: 38000,
      getFillColor: d => getStatusGlow(d),
      radiusMinPixels: 4,
      radiusMaxPixels: 28,
      opacity: 0.55,
      stroked: false,
      billboard: false,
      pickable: false,
      parameters: {
        blend: true,
        blendFunc: [770, 1], // SRC_ALPHA, ONE — additive
        depthTest: false,
      },
    }),

    // ── 霓虹光柱：ColumnLayer ─────────────────────────────────────────
    new ColumnLayer({
      id: 'node-columns',
      data: nodeData,
      diskResolution: 16,
      radius: d => getColumnRadius(d),
      elevationScale: 1,
      getPosition: d => [d.lon, d.lat],
      getElevation: d => getColumnHeight(d),
      getFillColor: d => {
        const base = getStatusColor(d);
        // 顶部更亮，底部稍暗 — 用固定透明度模拟
        return [...base, 210];
      },
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 80],
      onClick: (info) => {
        if (info?.object && onColumnClick) {
          onColumnClick(info.object);
        }
      },
      material: {
        ambient: 0.6,
        diffuse: 0.35,
        shininess: 64,
        specularColor: [180, 220, 255],
      },
      parameters: {
        blend: true,
        blendFunc: [770, 771], // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
        depthTest: true,
      },
    }),

    // ── 光柱外发光层：第二层 ColumnLayer 更粗更透明 ──────────────────
    new ColumnLayer({
      id: 'node-columns-glow',
      data: nodeData,
      diskResolution: 12,
      radius: d => getColumnRadius(d) * 2.2,
      elevationScale: 1,
      getPosition: d => [d.lon, d.lat],
      getElevation: d => getColumnHeight(d) * 0.92,
      getFillColor: d => {
        const base = getStatusColor(d);
        return [...base, 45];
      },
      pickable: false,
      material: {
        ambient: 0.9,
        diffuse: 0.1,
        shininess: 0,
      },
      parameters: {
        blend: true,
        blendFunc: [770, 1], // additive blend
        depthTest: true,
        depthMask: false,
      },
    }),

    // ── 动态飞线：ArcLayer ────────────────────────────────────────────
    new ArcLayer({
      id: 'connection-arcs',
      data: arcData,
      getSourcePosition: d => d.sourcePosition,
      getTargetPosition: d => d.targetPosition,
      getSourceColor: d => {
        const c = getStatusColor(d.source);
        return [...c, 200];
      },
      getTargetColor: d => {
        const c = getStatusColor(d.target);
        return [...c, 200];
      },
      getWidth: 2.5,
      getHeight: 0.4,
      greatCircle: true,
      widthMinPixels: 1,
      widthMaxPixels: 4,
      pickable: false,
      parameters: {
        blend: true,
        blendFunc: [770, 1], // additive
        depthTest: true,
      },
    }),

    // ── 飞线动态流光层（更亮更窄的叠加弧线） ──────────────────────────
    new ArcLayer({
      id: 'connection-arcs-pulse',
      data: arcData,
      getSourcePosition: d => d.sourcePosition,
      getTargetPosition: d => d.targetPosition,
      getSourceColor: [160, 240, 255, 255],
      getTargetColor: [80, 200, 255, 120],
      getWidth: 1.2,
      getHeight: 0.4,
      greatCircle: true,
      widthMinPixels: 1,
      widthMaxPixels: 2,
      // getTilt 随时间变化产生流光
      getTilt: () => {
        const phase = (time * 0.00015) % 1.0;
        return Math.sin(phase * Math.PI * 2) * 15;
      },
      pickable: false,
      parameters: {
        blend: true,
        blendFunc: [770, 1],
        depthTest: true,
        depthMask: false,
      },
    }),
  ];
}
