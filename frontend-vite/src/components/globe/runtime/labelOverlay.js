import * as Cesium from 'cesium';

export function installPlaceLabels(globe) {
  if (!globe._placeLabelLayer) return;
  const places = [
    { text: '中国', lon: 104.2, lat: 35.8, level: 'country' },
    { text: '日本', lon: 138.0, lat: 37.8, level: 'country' },
    { text: '美国', lon: -98.5, lat: 39.8, level: 'country' },
    { text: '德国', lon: 10.4, lat: 51.2, level: 'country' },
    { text: '加拿大', lon: -106.3, lat: 56.1, level: 'country' },
    { text: '俄罗斯', lon: 92.0, lat: 61.0, level: 'country' },
    { text: '澳大利亚', lon: 134.0, lat: -25.0, level: 'country' },
    { text: '英国', lon: -2.5, lat: 54.0, level: 'country' },
    { text: '法国', lon: 2.2, lat: 46.2, level: 'country' },
    { text: '意大利', lon: 12.5, lat: 42.7, level: 'country' },
    { text: '西班牙', lon: -3.7, lat: 40.2, level: 'country' },
    { text: '印度', lon: 78.9, lat: 22.8, level: 'country' },
    { text: '巴西', lon: -51.9, lat: -10.8, level: 'country' },
    { text: '墨西哥', lon: -102.5, lat: 23.6, level: 'country' },
    { text: '韩国', lon: 127.8, lat: 36.4, level: 'country' },
    { text: '印度尼西亚', lon: 113.9, lat: -2.0, level: 'country' },
    { text: '南非', lon: 24.0, lat: -29.0, level: 'country' },
    { text: '土耳其', lon: 35.2, lat: 39.0, level: 'country' },
    { text: '沙特阿拉伯', lon: 45.0, lat: 24.0, level: 'country' },
    { text: '阿根廷', lon: -64.0, lat: -34.0, level: 'country' },
    { text: '智利', lon: -71.5, lat: -30.0, level: 'country' },
    { text: '挪威', lon: 8.0, lat: 62.0, level: 'country' },
    { text: '瑞典', lon: 15.0, lat: 62.0, level: 'country' },
    { text: '芬兰', lon: 26.0, lat: 64.5, level: 'country' },
    { text: '格陵兰', lon: -42.0, lat: 72.0, level: 'country' },
    { text: '新加坡', lon: 103.82, lat: 1.35, level: 'city' },
    { text: '东京', lon: 139.65, lat: 35.68, level: 'city' },
    { text: '香港', lon: 114.17, lat: 22.32, level: 'city' },
    { text: '洛杉矶', lon: -118.24, lat: 34.05, level: 'city' },
    { text: '法兰克福', lon: 8.68, lat: 50.11, level: 'city' },
    { text: '首尔', lon: 126.98, lat: 37.56, level: 'city' },
    { text: '上海', lon: 121.47, lat: 31.23, level: 'city' },
    { text: '北京', lon: 116.40, lat: 39.90, level: 'city' },
    { text: '伦敦', lon: -0.12, lat: 51.50, level: 'city' },
    { text: '纽约', lon: -74.0, lat: 40.71, level: 'city' },
    { text: '深圳', lon: 114.06, lat: 22.54, level: 'town' },
    { text: '广州', lon: 113.26, lat: 23.13, level: 'town' },
    { text: '台北', lon: 121.56, lat: 25.04, level: 'town' },
    { text: '大阪', lon: 135.50, lat: 34.69, level: 'town' },
    { text: '横滨', lon: 139.64, lat: 35.44, level: 'town' },
    { text: '仁川', lon: 126.70, lat: 37.46, level: 'town' },
    { text: '吉隆坡', lon: 101.69, lat: 3.14, level: 'town' },
    { text: '曼谷', lon: 100.50, lat: 13.75, level: 'town' },
    { text: '雅加达', lon: 106.85, lat: -6.21, level: 'town' },
    { text: '悉尼', lon: 151.21, lat: -33.87, level: 'town' },
    { text: '墨尔本', lon: 144.96, lat: -37.81, level: 'town' },
    { text: '巴黎', lon: 2.35, lat: 48.86, level: 'town' },
    { text: '阿姆斯特丹', lon: 4.90, lat: 52.37, level: 'town' },
    { text: '柏林', lon: 13.40, lat: 52.52, level: 'town' },
    { text: '旧金山', lon: -122.42, lat: 37.77, level: 'town' },
    { text: '西雅图', lon: -122.33, lat: 47.61, level: 'town' },
    { text: '芝加哥', lon: -87.63, lat: 41.88, level: 'town' },
    { text: '多伦多', lon: -79.38, lat: 43.65, level: 'town' },
    { text: '温哥华', lon: -123.12, lat: 49.28, level: 'town' },
    { text: '南京', lon: 118.80, lat: 32.06, level: 'town' },
    { text: '杭州', lon: 120.15, lat: 30.27, level: 'town' },
    { text: '成都', lon: 104.06, lat: 30.67, level: 'town' },
    { text: '重庆', lon: 106.55, lat: 29.56, level: 'town' },
    { text: '武汉', lon: 114.31, lat: 30.59, level: 'town' },
    { text: '厦门', lon: 118.09, lat: 24.48, level: 'town' },
    { text: '名古屋', lon: 136.91, lat: 35.18, level: 'town' },
    { text: '福冈', lon: 130.40, lat: 33.59, level: 'town' },
    { text: '马尼拉', lon: 120.98, lat: 14.60, level: 'town' },
    { text: '胡志明市', lon: 106.70, lat: 10.78, level: 'town' },
    { text: '河内', lon: 105.85, lat: 21.03, level: 'town' },
    { text: '孟买', lon: 72.88, lat: 19.08, level: 'town' },
    { text: '迪拜', lon: 55.27, lat: 25.20, level: 'town' },
    { text: '米兰', lon: 9.19, lat: 45.46, level: 'town' },
    { text: '马德里', lon: -3.70, lat: 40.42, level: 'town' },
    { text: '都柏林', lon: -6.26, lat: 53.35, level: 'town' },
    { text: '赫尔辛基', lon: 24.94, lat: 60.17, level: 'town' },
    { text: '达拉斯', lon: -96.80, lat: 32.78, level: 'town' },
    { text: '迈阿密', lon: -80.19, lat: 25.76, level: 'town' },
    { text: '亚特兰大', lon: -84.39, lat: 33.75, level: 'town' },
    { text: '蒙特利尔', lon: -73.57, lat: 45.50, level: 'town' },
    { text: '圣保罗', lon: -46.63, lat: -23.55, level: 'town' },
    { text: '莫斯科', lon: 37.62, lat: 55.75, level: 'city' },
    { text: '罗马', lon: 12.50, lat: 41.90, level: 'city' },
    { text: '巴塞罗那', lon: 2.17, lat: 41.38, level: 'town' },
    { text: '苏黎世', lon: 8.54, lat: 47.37, level: 'town' },
    { text: '维也纳', lon: 16.37, lat: 48.21, level: 'town' },
    { text: '华沙', lon: 21.01, lat: 52.23, level: 'town' },
    { text: '布拉格', lon: 14.42, lat: 50.08, level: 'town' },
    { text: '斯德哥尔摩', lon: 18.07, lat: 59.33, level: 'town' },
    { text: '奥斯陆', lon: 10.75, lat: 59.91, level: 'town' },
    { text: '哥本哈根', lon: 12.57, lat: 55.68, level: 'town' },
    { text: '里斯本', lon: -9.14, lat: 38.72, level: 'town' },
    { text: '开罗', lon: 31.24, lat: 30.04, level: 'city' },
    { text: '约翰内斯堡', lon: 28.04, lat: -26.20, level: 'town' },
    { text: '拉各斯', lon: 3.38, lat: 6.52, level: 'town' },
    { text: '内罗毕', lon: 36.82, lat: -1.29, level: 'town' },
    { text: '伊斯坦布尔', lon: 28.98, lat: 41.01, level: 'city' },
    { text: '利雅得', lon: 46.68, lat: 24.71, level: 'town' },
    { text: '特拉维夫', lon: 34.78, lat: 32.08, level: 'town' },
    { text: '德里', lon: 77.21, lat: 28.61, level: 'city' },
    { text: '班加罗尔', lon: 77.59, lat: 12.97, level: 'town' },
    { text: '加尔各答', lon: 88.36, lat: 22.57, level: 'town' },
    { text: '卡拉奇', lon: 67.01, lat: 24.86, level: 'town' },
    { text: '达卡', lon: 90.41, lat: 23.81, level: 'town' },
    { text: '金边', lon: 104.93, lat: 11.56, level: 'town' },
    { text: '仰光', lon: 96.16, lat: 16.84, level: 'town' },
    { text: '香港', lon: 114.17, lat: 22.32, level: 'city' },
    { text: '青岛', lon: 120.38, lat: 36.07, level: 'town' },
    { text: '西安', lon: 108.94, lat: 34.34, level: 'town' },
    { text: '札幌', lon: 141.35, lat: 43.06, level: 'town' },
    { text: '仙台', lon: 140.87, lat: 38.27, level: 'town' },
    { text: '檀香山', lon: -157.86, lat: 21.31, level: 'town' },
    { text: '丹佛', lon: -104.99, lat: 39.74, level: 'town' },
    { text: '凤凰城', lon: -112.07, lat: 33.45, level: 'town' },
    { text: '休斯敦', lon: -95.37, lat: 29.76, level: 'town' },
    { text: '波士顿', lon: -71.06, lat: 42.36, level: 'town' },
    { text: '华盛顿', lon: -77.04, lat: 38.90, level: 'town' },
    { text: '墨西哥城', lon: -99.13, lat: 19.43, level: 'city' },
    { text: '布宜诺斯艾利斯', lon: -58.38, lat: -34.60, level: 'city' },
    { text: '圣地亚哥', lon: -70.67, lat: -33.45, level: 'town' },
    { text: '利马', lon: -77.04, lat: -12.05, level: 'town' },
    { text: '波哥大', lon: -74.07, lat: 4.71, level: 'town' },
    { text: '里约热内卢', lon: -43.17, lat: -22.91, level: 'town' },
    { text: '奥克兰', lon: 174.76, lat: -36.85, level: 'town' },
    { text: '惠灵顿', lon: 174.78, lat: -41.29, level: 'town' },
    { text: '珀斯', lon: 115.86, lat: -31.95, level: 'town' },
    { text: '布里斯班', lon: 153.03, lat: -27.47, level: 'town' },
    { text: '东亚', lon: 112.0, lat: 31.0, level: 'region' },
    { text: '北美', lon: -105.0, lat: 44.0, level: 'region' },
    { text: '欧洲', lon: 14.0, lat: 49.0, level: 'region' },
  ];
  globe._placeLabelLayer.innerHTML = '';
  globe._placeLabels = places.map((place) => {
    const el = document.createElement('div');
    el.className = `google-earth-place-label ${place.level}`;
    el.textContent = place.text;
    globe._placeLabelLayer.appendChild(el);
    return { ...place, el };
  });
}

export function updatePlaceLabels(globe, height) {
  if (!globe._placeLabelLayer || !globe.viewer) return;
  const scene = globe.viewer.scene;
  const width = globe.container.clientWidth || window.innerWidth;
  const h = globe.container.clientHeight || window.innerHeight;
  const farOnlyEarth = height >= 9_000_000;
  globe._placeLabelLayer.classList.toggle('is-far-hidden', farOnlyEarth);
  const showRegion = height >= 2_600_000 && height < 9_000_000;
  const showCountry = height >= 800_000 && height < 5_800_000;
  const showCity = height < 2_800_000;
  const showTown = height < 950_000;
  for (const place of globe._placeLabels || []) {
    if (farOnlyEarth) {
      place.el.classList.remove('is-visible');
      place.el.style.transform = 'translate3d(-9999px, -9999px, 0)';
      continue;
    }
    const visibleByLevel = place.level === 'region' ? showRegion : place.level === 'country' ? showCountry : place.level === 'town' ? showTown : showCity;
    if (!visibleByLevel) { place.el.classList.remove('is-visible'); place.el.style.transform = 'translate3d(-9999px, -9999px, 0)'; continue; }
    const pos = Cesium.Cartesian3.fromDegrees(place.lon, place.lat, 0);
    const surfaceNormal = Cesium.Cartesian3.normalize(pos, new Cesium.Cartesian3());
    const cameraNormal = Cesium.Cartesian3.normalize(globe.viewer.camera.positionWC, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.dot(surfaceNormal, cameraNormal) < 0.08) {
      place.el.classList.remove('is-visible');
      place.el.style.transform = 'translate3d(-9999px, -9999px, 0)';
      continue;
    }
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos);
    if (!win || win.x < -80 || win.x > width + 80 || win.y < -80 || win.y > h + 80) {
      place.el.classList.remove('is-visible');
      place.el.style.transform = 'translate3d(-9999px, -9999px, 0)';
      continue;
    }
    place.el.style.transform = `translate3d(${Math.round(win.x)}px, ${Math.round(win.y)}px, 0) translate(-50%, -50%)`;
    place.el.classList.add('is-visible');
  }
}

export function updateHtmlNodeLabels(globe, cityMode) {
  if (!globe._labelLayer || !globe.viewer) return;
  const scene = globe.viewer.scene;
  const now = globe.viewer.clock.currentTime;
  const width = globe.container.clientWidth || window.innerWidth;
  const height = globe.container.clientHeight || window.innerHeight;
  const cameraHeight = globe.viewer.camera.positionCartographic?.height || 12_000_000;
  const farOnlyEarth = cameraHeight >= 9_000_000;
  globe._labelLayer.classList.toggle('is-far-hidden', farOnlyEarth);
  const hideLabel = (labelEl) => {
    if (!labelEl) return;
    labelEl.classList.remove('is-visible');
    labelEl.style.transform = 'translate3d(-9999px, -9999px, 0)';
  };
  // 远景也保留 VPS/访客信标信息框；只隐藏普通/旧式节点标签。
  if (farOnlyEarth || !cityMode) {
    for (const labelEl of globe._htmlLabels?.values?.() || []) {
      if (!labelEl.classList.contains('is-vps-beacon-node')) hideLabel(labelEl);
    }
  }
  const placeLabel = (entity, labelEl, yOffset = 30) => {
    if (!labelEl) return;
    if (!entity.show) { hideLabel(labelEl); return; }
    const pos = entity.position?.getValue(now);
    if (!pos) { hideLabel(labelEl); return; }
    // Keep beacon labels glued to visible surface points only. Without this front-facing
    // test, labels for points near/behind the globe project to unstable screen positions
    // and look like they are floating around the page.
    const surfaceNormal = Cesium.Cartesian3.normalize(pos, new Cesium.Cartesian3());
    const cameraNormal = Cesium.Cartesian3.normalize(globe.viewer.camera.positionWC, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.dot(surfaceNormal, cameraNormal) < 0.08) {
      hideLabel(labelEl);
      return;
    }
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos);
    if (!win || win.x < -40 || win.x > width + 40 || win.y < -40 || win.y > height + 40) {
      hideLabel(labelEl);
      return;
    }
    labelEl.style.transform = `translate3d(${Math.round(win.x)}px, ${Math.round(win.y - yOffset)}px, 0) translate(-50%, -100%)`;
    labelEl.classList.add('is-visible');
  };
  globe._nodeEntities.forEach((entity) => placeLabel(entity, globe._htmlLabels.get(entity.id), 30));
  const visitorPoint = (globe._visitorEntities || []).find((entity) => String(entity.id) === 'visitor-beacon-point');
  if (visitorPoint && globe._visitorLabel) placeLabel(visitorPoint, globe._visitorLabel, 30);
}

