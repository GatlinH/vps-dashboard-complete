import '../../../globals/dashboardGlobals.js';
import * as Cesium from 'cesium';
import { escapeHtml } from '../vpsEntities.js';
import { getGlobeRuntimeDebug } from '../../../utils/debugState.js';

const VISITOR_FLAG_BY_CODE = {
  US:'🇺🇸', CA:'🇨🇦', MX:'🇲🇽', BR:'🇧🇷', GB:'🇬🇧', UK:'🇬🇧', FR:'🇫🇷', DE:'🇩🇪', NL:'🇳🇱', ES:'🇪🇸', IT:'🇮🇹', SG:'🇸🇬', HK:'🇭🇰', MO:'🇲🇴', TW:'🇹🇼', CN:'🇨🇳', JP:'🇯🇵', KR:'🇰🇷', IN:'🇮🇳', AU:'🇦🇺', RU:'🇷🇺'
};

const VISITOR_FLAG_RULES = [
  [/香港|hong kong|\bhk\b/i, '🇭🇰'], [/台湾|taiwan|taipei/i, '🇹🇼'], [/新加坡|singapore|\bsg\b/i, '🇸🇬'],
  [/日本|japan|tokyo|osaka|\bjp\b/i, '🇯🇵'], [/韩国|korea|seoul|\bkr\b/i, '🇰🇷'],
  [/美国|united states|usa|san jose|seattle|los angeles|new york|\bus\b/i, '🇺🇸'],
  [/德国|germany|frankfurt|\bde\b/i, '🇩🇪'], [/英国|united kingdom|london|\buk\b|\bgb\b/i, '🇬🇧'],
  [/法国|france|paris|\bfr\b/i, '🇫🇷'], [/中国|china|beijing|shanghai|\bcn\b/i, '🇨🇳']
];

function inferVisitorFlag(info = {}) {
  const rawCode = String(info.countryCode || info.country_code || info.country_code2 || info.countryCode2 || '').toUpperCase();
  if (VISITOR_FLAG_BY_CODE[rawCode]) return VISITOR_FLAG_BY_CODE[rawCode];
  const text = [info.country, info.country_name, info.regionName, info.region, info.city, info.timezone, info.query, info.ip].filter(Boolean).join(' · ');
  for (const [rule, flag] of VISITOR_FLAG_RULES) if (rule.test(text)) return flag;
  return '🌐';
}

function flagCountryCodeFromEmoji(flag) {
  const chars = Array.from(String(flag || ''));
  if (chars.length < 2) return '';
  const codes = chars.slice(0, 2).map(ch => ch.codePointAt(0) - 0x1F1E6 + 65);
  if (codes.some(c => c < 65 || c > 90)) return '';
  return String.fromCharCode(...codes).toLowerCase();
}

function visitorFlagCode(info = {}, flag = '') {
  const rawCode = String(info.countryCode || info.country_code || info.country_code2 || info.countryCode2 || '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(rawCode)) return rawCode === 'uk' ? 'gb' : rawCode;
  return flagCountryCodeFromEmoji(flag) || 'un';
}

function renderFlagImg(flag, code) {
  const cc = /^[a-z]{2}$/.test(String(code || '')) ? String(code).toLowerCase() : 'un';
  const src = cc === 'us' ? "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%20741%20390%22%3E%3Crect%20width=%22741%22%20height=%22390%22%20fill=%22%23b22234%22/%3E%3Cg%20fill=%22%23fff%22%3E%3Crect%20y=%2230%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%2290%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22150%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22210%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22270%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22330%22%20width=%22741%22%20height=%2230%22/%3E%3C/g%3E%3Crect%20width=%22296%22%20height=%22210%22%20fill=%22%233c3b6e%22/%3E%3Cg%20fill=%22%23fff%22%3E%3Ccircle%20cx=%2237%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%22111%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%22185%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%22259%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%2274%22%20cy=%2270%22%20r=%2210%22/%3E%3Ccircle%20cx=%22148%22%20cy=%2270%22%20r=%2210%22/%3E%3Ccircle%20cx=%22222%22%20cy=%2270%22%20r=%2210%22/%3E%3Ccircle%20cx=%2237%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%22111%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%22185%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%22259%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%2274%22%20cy=%22150%22%20r=%2210%22/%3E%3Ccircle%20cx=%22148%22%20cy=%22150%22%20r=%2210%22/%3E%3Ccircle%20cx=%22222%22%20cy=%22150%22%20r=%2210%22/%3E%3Ccircle%20cx=%2237%22%20cy=%22190%22%20r=%2210%22/%3E%3Ccircle%20cx=%22111%22%20cy=%22190%22%20r=%2210%22/%3E%3Ccircle%20cx=%22185%22%20cy=%22190%22%20r=%2210%22/%3E%3Ccircle%20cx=%22259%22%20cy=%22190%22%20r=%2210%22/%3E%3C/g%3E%3C/svg%3E" : `https://flagcdn.com/w40/${escapeHtml(cc)}.png`;
  const srcset = cc === 'us' ? '' : ` srcset="https://flagcdn.com/w80/${escapeHtml(cc)}.png 2x"`;
  return `<img class="node-flag-img node-flag-${escapeHtml(cc)}" src="${src}"${srcset} alt="${escapeHtml(flag)}" title="${escapeHtml(flag)}" loading="eager" decoding="sync">`;
}

if (typeof window !== 'undefined') window.__DBG__.inferVisitorFlagForTest = inferVisitorFlag;

function clearVisitorBeacon(globe) {
  for (const entity of globe._visitorEntities || []) {
    try { globe.viewer?.entities?.remove(entity); } catch (_) {}
  }
  globe._visitorEntities = [];
  if (globe._visitorLabel) {
    globe._visitorLabel.remove();
    globe._visitorLabel = null;
  }
}

export function isRenderableVisitorGeo(info = {}) {
  const lat = Number(info.lat ?? info.latitude);
  const lon = Number(info.lon ?? info.lng ?? info.longitude);
  return info?.valid !== false
    && !info?.degraded
    && info?.source !== 'fallback:anonymous'
    && Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90 && lat <= 90
    && lon >= -180 && lon <= 180
    && !(lat === 0 && lon === 0);
}

export async function installVisitorBeacon(globe) {
  if (globe._visitorFetchStarted) {
    if (globe._visitorInfo && (!globe._visitorEntities || globe._visitorEntities.length === 0)) addVisitorBeacon(globe);
    return;
  }
  globe._visitorFetchStarted = true;
  try {
    const resp = await fetch('/api/v1/probe/ip-info', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!resp.ok) throw new Error(`visitor geo HTTP ${resp.status}`);
    const info = await resp.json();
    if (!isRenderableVisitorGeo(info)) throw new Error('visitor geo is not renderable');
    const lat = Number(info.lat ?? info.latitude);
    const lon = Number(info.lon ?? info.lng ?? info.longitude);
    const flag = inferVisitorFlag(info);
    globe._visitorInfo = { ...info, lat, lon, flag };
    addVisitorBeacon(globe);
    getGlobeRuntimeDebug().visitorBeaconDebug = { flag, lat, lon, location: [info.city, info.regionName, info.country].filter(Boolean).join(' · '), source: info.source || '/api/v1/probe/ip-info' };
  } catch (error) {
    globe._visitorInfo = null;
    const visitorBeaconError = String(error?.message || error);
    getGlobeRuntimeDebug().visitorBeaconError = visitorBeaconError;
    getGlobeRuntimeDebug().visitorBeaconDebug = { hidden: true, source: '/api/v1/probe/ip-info', error: visitorBeaconError };
    console.warn('[cesium-globe] visitor beacon hidden: geo lookup failed', error);
  }
}

export function addVisitorBeacon(globe) {
  if (!globe.viewer || !globe._visitorInfo) return;
  clearVisitorBeacon(globe);
  const { lat, lon } = globe._visitorInfo;

  // 访客信标: 冷青色精致小点, 细白边, 与 VPS 节点同一套精简视觉语言
  const visitorPoint = globe.viewer.entities.add({
    id: 'visitor-beacon-point',
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 220),
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString('#38e8ff').withAlpha(0.95),
      outlineColor: Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.85),
      outlineWidth: 2,
      scaleByDistance: new Cesium.NearFarScalar(220000, 1.3, 3.0e7, 0.8),
      translucencyByDistance: new Cesium.NearFarScalar(220000, 1.0, 3.4e7, 0.85),
      heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    properties: { visitorBeacon: true },
  });

  // 柔和呼吸光环: 半径随时间脉动, 比旧版 52km 实心环更轻盈
  const baseRadius = 26000;
  const pulse = new Cesium.CallbackProperty((time) => {
    const t = (Cesium.JulianDate.secondsDifference(time, globe._visitorPulseEpoch || (globe._visitorPulseEpoch = time)));
    const s = 1 + 0.35 * Math.sin(t * 1.6);
    return baseRadius * s;
  }, false);
  const visitorRing = globe.viewer.entities.add({
    id: 'visitor-beacon-ring',
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 40),
    ellipse: {
      semiMajorAxis: pulse,
      semiMinorAxis: pulse,
      material: Cesium.Color.fromCssColorString('#38e8ff').withAlpha(0.14),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#aef6ff').withAlpha(0.5),
      outlineWidth: 1.5,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      classificationType: Cesium.ClassificationType.TERRAIN,
    },
    properties: { visitorBeacon: true },
  });

  globe._visitorEntities.push(visitorRing, visitorPoint);
  if (globe._labelLayer) {
    const el = document.createElement('div');
    el.className = 'google-earth-node-html-label is-visitor-node';
    const place = [globe._visitorInfo.city, globe._visitorInfo.regionName, globe._visitorInfo.country].filter(Boolean).join(' · ') || '访客位置';
    const flag = globe._visitorInfo.flag || inferVisitorFlag(globe._visitorInfo);
    const flagCode = visitorFlagCode(globe._visitorInfo, flag);
    el.innerHTML = `<span class="node-place"><span class="node-flag">${renderFlagImg(flag, flagCode)}</span><span class="node-title">访客信标</span></span><span class="node-name">${escapeHtml(place)}</span>`;
    globe._labelLayer.appendChild(el);
    globe._visitorLabel = el;
  }
}
