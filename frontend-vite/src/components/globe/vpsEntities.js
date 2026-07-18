import * as Cesium from 'cesium';
import { getServerCoords, STATUS_COLORS } from '../globe-utils.js';
import { clusterServersByCoordinate } from './vpsClusters.js';
import { aggregateClusterStatus, buildClusterBeaconAppearance } from './vpsClusterInteraction.js';

function toCesiumColor(rgb, alpha = 1) {
  return new Cesium.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, alpha);
}

function statusColor(server, alpha = 1) {
  const c = STATUS_COLORS[server.status] || STATUS_COLORS.unknown;
  return toCesiumColor(c, alpha);
}

function removeEntities(viewer, entities = []) {
  for (const entity of entities) {
    try { viewer?.entities?.remove(entity); } catch (_) {}
  }
}

function clearHtmlLabels(globe) {
  globe._htmlLabels?.forEach((el) => el.remove());
  globe._htmlLabels = new Map();
}

function resetNodeAndVisitorLayers(globe) {
  removeEntities(globe.viewer, globe._nodeEntities);
  removeEntities(globe.viewer, globe._arcEntities);
  globe._nodeEntities = [];
  globe._arcEntities = [];
  globe._tilesLoadingCount = 0;
  globe._lastNodeClampAt = 0;
  clearHtmlLabels(globe);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

function flagFromCountryCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  const cc = normalized === 'UK' ? 'GB' : normalized;
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return Array.from(cc).map(ch => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join('');
}

function serverFlag(server) {
  const explicitFlag = String(server?.flag || '');
  if (/[\u{1F1E6}-\u{1F1FF}]{2}/u.test(explicitFlag)) return explicitFlag;
  return flagFromCountryCode(server?.country_code || server?.countryCode || server?.country) || '🌐';
}

function flagCountryCodeFromEmoji(flag) {
  const chars = Array.from(String(flag || ''));
  if (chars.length < 2) return '';
  const codes = chars.slice(0, 2).map(ch => ch.codePointAt(0) - 0x1F1E6 + 65);
  if (codes.some(c => c < 65 || c > 90)) return '';
  return String.fromCharCode(...codes).toLowerCase();
}

function serverFlagCode(server) {
  const explicit = String(server?.country_code || server?.countryCode || server?.country || '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(explicit)) return explicit === 'uk' ? 'gb' : explicit;
  const fromEmoji = flagCountryCodeFromEmoji(serverFlag(server));
  return fromEmoji || 'un';
}

function renderFlagImg(flag, code) {
  const cc = /^[a-z]{2}$/.test(String(code || '')) ? String(code).toLowerCase() : 'un';
  const src = cc === 'us' ? "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%20741%20390%22%3E%3Crect%20width=%22741%22%20height=%22390%22%20fill=%22%23b22234%22/%3E%3Cg%20fill=%22%23fff%22%3E%3Crect%20y=%2230%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%2290%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22150%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22210%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22270%22%20width=%22741%22%20height=%2230%22/%3E%3Crect%20y=%22330%22%20width=%22741%22%20height=%2230%22/%3E%3C/g%3E%3Crect%20width=%22296%22%20height=%22210%22%20fill=%22%233c3b6e%22/%3E%3Cg%20fill=%22%23fff%22%3E%3Ccircle%20cx=%2237%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%22111%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%22185%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%22259%22%20cy=%2230%22%20r=%2210%22/%3E%3Ccircle%20cx=%2274%22%20cy=%2270%22%20r=%2210%22/%3E%3Ccircle%20cx=%22148%22%20cy=%2270%22%20r=%2210%22/%3E%3Ccircle%20cx=%22222%22%20cy=%2270%22%20r=%2210%22/%3E%3Ccircle%20cx=%2237%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%22111%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%22185%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%22259%22%20cy=%22110%22%20r=%2210%22/%3E%3Ccircle%20cx=%2274%22%20cy=%22150%22%20r=%2210%22/%3E%3Ccircle%20cx=%22148%22%20cy=%22150%22%20r=%2210%22/%3E%3Ccircle%20cx=%22222%22%20cy=%22150%22%20r=%2210%22/%3E%3Ccircle%20cx=%2237%22%20cy=%22190%22%20r=%2210%22/%3E%3Ccircle%20cx=%22111%22%20cy=%22190%22%20r=%2210%22/%3E%3Ccircle%20cx=%22185%22%20cy=%22190%22%20r=%2210%22/%3E%3Ccircle%20cx=%22259%22%20cy=%22190%22%20r=%2210%22/%3E%3C/g%3E%3C/svg%3E" : `https://flagcdn.com/w40/${escapeHtml(cc)}.png`;
  const srcset = cc === 'us' ? '' : ` srcset="https://flagcdn.com/w80/${escapeHtml(cc)}.png 2x"`;
  return `<img class="node-flag-img node-flag-${escapeHtml(cc)}" src="${src}"${srcset} alt="${escapeHtml(flag)}" title="${escapeHtml(flag)}" loading="eager" decoding="sync">`;
}

export function shortServerLabel(server) {
  const name = String(server?.name || `VPS-${server?.id || ''}`);
  if (/hong\s*kong|hk-|hk\b|node-02/i.test(name)) return 'HK 节点';
  if (/tokyo|jp-|sakura/i.test(name)) return '东京节点';
  if (/singapore|sg-|linode/i.test(name)) return '新加坡节点';
  if (/los\s*angeles|la-|pro-01/i.test(name)) return '洛杉矶节点';
  if (/frankfurt|de-|hetzner/i.test(name)) return '德国节点';
  return name.length > 14 ? `${name.slice(0, 12)}…` : name;
}

export function rebuildVpsEntities(globe) {
  resetNodeAndVisitorLayers(globe);

  for (const cluster of clusterServersByCoordinate(globe.servers)) {
    const server = cluster.members[0];
    const { lat, lon } = cluster.valid ? cluster : getServerCoords(server);
    const isCluster = cluster.members.length > 1;
    const memberTitle = cluster.members.map((member) => String(member.name || 'VPS-' + (member.id || ''))).join(' · ');
    const beaconAppearance = isCluster ? buildClusterBeaconAppearance(cluster.members) : null;
    const clusterStatus = isCluster ? aggregateClusterStatus(cluster.members) : server.status;
    const healthColor = statusColor({ status: clusterStatus });
    const clusterClickProperties = isCluster ? {
      serverId: server.id,
      serverData: server,
      clusterMembers: cluster.members,
      clusterCentroid: { lat, lon, clusterKey: cluster.key },
      vpsClusterClick: true,
    } : null;
    let nodeEntity = null;
    if (!isCluster) {
      const coreColor = Cesium.Color.fromCssColorString('#38e8ff').withAlpha(0.95);
      nodeEntity = globe.viewer.entities.add({
        id: `node-${server.id}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 180),
        point: {
          pixelSize: 10,
          color: coreColor,
          outlineColor: Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.9),
          outlineWidth: 2,
          scaleByDistance: new Cesium.NearFarScalar(220000, 1.35, 5.0e7, 0.85),
          translucencyByDistance: new Cesium.NearFarScalar(200000, 1.0, 5.0e7, 0.9),
          heightReference: Cesium.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${serverFlag(server)} ${shortServerLabel(server)}`,
          font: '700 15px Inter, system-ui, sans-serif',
          fillColor: Cesium.Color.WHITE.withAlpha(0.96),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.88),
          outlineWidth: 1.5,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.78),
          backgroundPadding: new Cesium.Cartesian2(9, 6),
          pixelOffset: new Cesium.Cartesian2(0, -40),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          scaleByDistance: new Cesium.NearFarScalar(200000, 1.08, 18_000_000, 0.72),
          translucencyByDistance: new Cesium.NearFarScalar(180000, 1.0, 22_000_000, 0.55),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: false,
        },
        properties: { serverId: server.id, serverData: server, clusterMembers: cluster.members },
      });
      globe._nodeEntities.push(nodeEntity);
    }

    const beaconRing = globe.viewer.entities.add({
      id: `node-ring-${server.id}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 120),
      ellipse: {
        semiMajorAxis: 26000,
        semiMinorAxis: 26000,
        material: healthColor.withAlpha(0.16),
        outline: true,
        outlineColor: healthColor.withAlpha(0.72),
        outlineWidth: 1.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        classificationType: Cesium.ClassificationType.TERRAIN,
      },
      properties: { ...clusterClickProperties, clusterKey: cluster.key, vpsBeaconRing: true },
      show: true,
    });

    globe._arcEntities.push(beaconRing);
    if (beaconAppearance) {
      const sectorAngle = Cesium.Math.TWO_PI / beaconAppearance.sectors.length;
      beaconAppearance.sectors.forEach((sector, index) => {
        const sectorEntity = globe.viewer.entities.add({
          id: `node-sector-${server.id}-${index}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 122),
          ellipse: {
            semiMajorAxis: 17500,
            semiMinorAxis: 17500,
            material: Cesium.Color.fromCssColorString(sector.color).withAlpha(0.88),
            theta: index * sectorAngle,
            delta: sectorAngle,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            classificationType: Cesium.ClassificationType.TERRAIN,
          },
          properties: { ...clusterClickProperties, clusterKey: cluster.key, vpsBeaconSector: true },
        });
        globe._arcEntities.push(sectorEntity);
      });
    }
    // VPS 信标信息框: 与访客信标同款视觉，但不显示 192-VPS-Agen 这类机器名，避免误读。
    if (globe._labelLayer) {
      const labelEl = document.createElement('div');
      labelEl.className = 'google-earth-node-html-label is-vps-node is-vps-beacon-node';
      const explicitPlace = server.public_note || server.publicRemark || server.public_remark || server.remark || server.location;
      const placeParts = explicitPlace ? [explicitPlace] : [server.city, server.country].filter(Boolean)
        .filter((part, idx, arr) => arr.findIndex(x => String(x).toLowerCase() === String(part).toLowerCase()) === idx);
      const place = placeParts.join(' · ') || '未知地区';
      const displayName = isCluster ? beaconAppearance.label : (shortServerLabel(server) || String(server?.name || 'VPS-' + (server?.id || '')));
      const flag = serverFlag(server);
      const flagCode = serverFlagCode(server);
      labelEl.innerHTML = `<span class="node-place"><span class="node-flag">${renderFlagImg(flag, flagCode)}</span><span class="node-title" title="${escapeHtml(memberTitle)}">${escapeHtml(displayName)}</span></span><span class="node-name">${escapeHtml(place)}</span>`;
      labelEl.dataset.nodeId = String(server.id);
      if (isCluster) labelEl.dataset.clusterKey = cluster.key;
      labelEl.title = memberTitle;
      labelEl.style.pointerEvents = 'auto';
      labelEl.style.cursor = 'pointer';
      const goDetail = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof globe.onNodeClick === 'function') globe.onNodeClick(server, cluster.members, { lat, lon, clusterKey: cluster.key });
        else if (server?.id != null) window.location.href = `/?server=${server.id}`;
      };
      labelEl.addEventListener('click', goDetail);
      globe._labelLayer.appendChild(labelEl);
      globe._htmlLabels.set(nodeEntity?.id || `node-${server.id}`, labelEl);
    }
  }
}
