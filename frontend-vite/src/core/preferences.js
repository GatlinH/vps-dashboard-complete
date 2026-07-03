export function safeStorageGet(key, fallback = null) {
  try { return window.localStorage?.getItem(key) ?? fallback; } catch { return fallback; }
}
export function safeStorageSet(key, value) {
  try { window.localStorage?.setItem(key, value); } catch {}
}
export function safeStorageRemove(key) {
  try { window.localStorage?.removeItem(key); } catch {}
}


export const LANGUAGE_PACKS = {
  zh: { name:'中文', back:'← 返回星图', bridge:'舰桥', daylight:'日间', themeAria:'切换主题', langAria:'切换语言', overviewTitle:'资产总览', overviewKicker:'FLEET ASSET OVERVIEW', dataUpdated:'数据更新时间', totalNodes:'总节点', online:'在线', warn:'波动', offline:'离线', expiresToday:'今日到期', within3Days:'3 日内', within7Days:'7 日内', monthlyTotalCost:'月付总成本', yearlyTotalCost:'年付总成本', expiringNodes:'到期节点', abnormalNodes:'异常节点', monthlyByRegion:'按地区月均', monthlyByProvider:'按供应商月均', noExpiring:'暂无临近到期', noAbnormal:'暂无异常节点', noData:'暂无数据', noAssets:'暂无资产', unknownNode:'未命名节点', unknownProvider:'未知供应商', unknownRegion:'未知地区', residualValue:'剩余价值', networkDetails:'NETWORK DETAILS', nodeNetworkDetails:'节点网络详情表', tableNodeId:'节点ID', geoLocation:'地理位置', operator:'运营商', monthlyTraffic:'月流量', packetLoss:'包丢失率', noNetworkData:'暂无节点网络数据', nodeTelemetry:'节点遥测', allocation:'分配', resources:'资源', bandwidth:'带宽', errorLog:'错误日志', fatalCodes:'故障码', nodeId:'节点 ID:', sector:'区段', systemCore:'系统核心', runtime:'运行时间', expiry:'到期', onlineSecure:'量子安全', ip:'IP', arch:'架构', memory:'内存', disk:'磁盘', geoCoords:'地理坐标', uuid:'UUID', swap:'交换', cpu:'CPU', mem:'内存', load:'负载', cores:'核心', uplink:'上行', downlink:'下行', traffic:'流量', liveTransfer:'实时传输', totalTraffic:'累计流量', fleetDb:'舰队资产数据库', identity:'身份', supplier:'供应商', city:'城市', multiNode:'多节点探针', probeLatency:'探针延迟', probe:'探针', loss:'丢包', telegramRules:'Telegram 规则', assetIndex:'资产向量索引', asset:'资产', node:'节点', vector:'向量', state:'状态', dataFreshness:'数据新鲜度', latestSample:'最新采样', sampleInterval:'采样间隔' },
  en: { name:'English', back:'← Starmap', bridge:'Bridge', daylight:'Daylight', themeAria:'Switch theme', langAria:'Switch language', overviewTitle:'Asset Overview', overviewKicker:'FLEET ASSET OVERVIEW', dataUpdated:'Updated', totalNodes:'Total Nodes', online:'Online', warn:'Degraded', offline:'Offline', expiresToday:'Due Today', within3Days:'Within 3 Days', within7Days:'Within 7 Days', monthlyTotalCost:'Monthly Total Cost', yearlyTotalCost:'Yearly Total Cost', expiringNodes:'Expiring Nodes', abnormalNodes:'Abnormal Nodes', monthlyByRegion:'Monthly by Region', monthlyByProvider:'Monthly by Provider', noExpiring:'No upcoming expiry', noAbnormal:'No abnormal nodes', noData:'No data', noAssets:'No assets', unknownNode:'Unnamed Node', unknownProvider:'Unknown Provider', unknownRegion:'Unknown Region', residualValue:'Residual Value', networkDetails:'NETWORK DETAILS', nodeNetworkDetails:'Node Network Details', tableNodeId:'Node ID', geoLocation:'Location', operator:'Operator', monthlyTraffic:'Monthly Traffic', packetLoss:'Packet Loss', noNetworkData:'No network data', nodeTelemetry:'Node Telemetry', allocation:'Allocation', resources:'Resources', bandwidth:'Bandwidth', errorLog:'Error Log', fatalCodes:'Fatal codes', nodeId:'Node ID:', sector:'Sector', systemCore:'System Core', runtime:'Runtime', expiry:'Expiry', onlineSecure:'Quantum Secure', ip:'IP', arch:'Arch', memory:'Memory', disk:'Disk', geoCoords:'Geo-Coords', uuid:'UUID', swap:'Swap', cpu:'CPU', mem:'Mem', load:'Load', cores:'cores', uplink:'Uplink', downlink:'Downlink', traffic:'Traffic', liveTransfer:'Live Transfer', totalTraffic:'Total Traffic', fleetDb:'Fleet Asset Database', identity:'Identity', supplier:'Supplier', city:'City', multiNode:'Multi-Node Probes', probeLatency:'Probe Latency', probe:'Probe', loss:'loss', telegramRules:'Telegram Rules', assetIndex:'Asset Vector Index', asset:'Asset', node:'Node', vector:'Vector', state:'State', dataFreshness:'Data Freshness', latestSample:'Latest Sample', sampleInterval:'Sample Interval' },
  ja: { name:'日本語', back:'← 星図へ', bridge:'艦橋', daylight:'昼間', themeAria:'テーマ切替', langAria:'言語切替', nodeTelemetry:'ノード遠隔測定', allocation:'割当', resources:'リソース', bandwidth:'帯域幅', errorLog:'エラーログ', fatalCodes:'致命コード', nodeId:'ノード ID:', sector:'セクター', systemCore:'システム中枢', runtime:'稼働時間', expiry:'期限', onlineSecure:'量子安全', ip:'IP', arch:'構成', memory:'メモリ', disk:'ディスク', geoCoords:'座標', uuid:'UUID', swap:'スワップ', cpu:'CPU', mem:'メモリ', load:'負荷', cores:'コア', uplink:'上り', downlink:'下り', traffic:'通信量', liveTransfer:'リアルタイム転送', totalTraffic:'累計通信量', fleetDb:'艦隊資産DB', identity:'識別', supplier:'供給元', city:'都市', multiNode:'多ノード探査', probeLatency:'探査遅延', probe:'探査', loss:'損失', telegramRules:'Telegram 规则', assetIndex:'資産ベクトル', asset:'資産', node:'ノード', vector:'ベクトル', state:'状態' },
  ko: { name:'한국어', back:'← 성도', bridge:'함교', daylight:'주간', themeAria:'테마 전환', langAria:'언어 전환', nodeTelemetry:'노드 텔레메트리', allocation:'할당', resources:'리소스', bandwidth:'대역폭', errorLog:'오류 로그', fatalCodes:'치명 코드', nodeId:'노드 ID:', sector:'섹터', systemCore:'시스템 코어', runtime:'가동 시간', expiry:'만료', onlineSecure:'양자 보안', ip:'IP', arch:'아키텍처', memory:'메모리', disk:'디스크', geoCoords:'좌표', uuid:'UUID', swap:'스왑', cpu:'CPU', mem:'메모리', load:'부하', cores:'코어', uplink:'업링크', downlink:'다운링크', traffic:'트래픽', liveTransfer:'실시간 전송', totalTraffic:'누적 트래픽', fleetDb:'함대 자산 DB', identity:'ID', supplier:'공급자', city:'도시', multiNode:'다중 노드 프로브', probeLatency:'프로브 지연', probe:'프로브', loss:'손실', telegramRules:'Telegram 규칙', assetIndex:'자산 벡터', asset:'자산', node:'노드', vector:'벡터', state:'상태' },
  es: { name:'Español', back:'← Mapa estelar', bridge:'Puente', daylight:'Día', themeAria:'Cambiar tema', langAria:'Cambiar idioma', nodeTelemetry:'Telemetría', allocation:'Asignación', resources:'Recursos', bandwidth:'Ancho de banda', errorLog:'Registro de errores', fatalCodes:'Códigos fatales', nodeId:'ID de nodo:', sector:'Sector', systemCore:'Núcleo', runtime:'Tiempo activo', expiry:'Vencimiento', onlineSecure:'Seguro cuántico', ip:'IP', arch:'Arquitectura', memory:'Memoria', disk:'Disco', geoCoords:'Coordenadas', uuid:'UUID', swap:'Swap', cpu:'CPU', mem:'Mem', load:'Carga', cores:'núcleos', uplink:'Subida', downlink:'Bajada', traffic:'Tráfico', liveTransfer:'Transferencia en vivo', totalTraffic:'Tráfico total', fleetDb:'Base de activos', identity:'Identidad', supplier:'Proveedor', city:'Ciudad', multiNode:'Sondas multi-nodo', probeLatency:'Latencia', probe:'Sonda', loss:'pérdida', telegramRules:'Reglas Telegram', assetIndex:'Índice vectorial', asset:'Activo', node:'Nodo', vector:'Vector', state:'Estado' },
  fr: { name:'Français', back:'← Carte stellaire', bridge:'Passerelle', daylight:'Jour', themeAria:'Changer le thème', langAria:'Changer de langue', nodeTelemetry:'Télémétrie', allocation:'Allocation', resources:'Ressources', bandwidth:'Bande passante', errorLog:'Journal erreurs', fatalCodes:'Codes fatals', nodeId:'ID nœud :', sector:'Secteur', systemCore:'Cœur système', runtime:'Durée', expiry:'Expiration', onlineSecure:'Sécurité quantique', ip:'IP', arch:'Arch', memory:'Mémoire', disk:'Disque', geoCoords:'Coordonnées', uuid:'UUID', swap:'Swap', cpu:'CPU', mem:'Mémoire', load:'Charge', cores:'cœurs', uplink:'Montant', downlink:'Descendant', traffic:'Trafic', liveTransfer:'Transfert direct', totalTraffic:'Trafic total', fleetDb:'Base des actifs', identity:'Identité', supplier:'Fournisseur', city:'Ville', multiNode:'Sondes multi-nœuds', probeLatency:'Latence', probe:'Sonde', loss:'perte', telegramRules:'Règles Telegram', assetIndex:'Index vectoriel', asset:'Actif', node:'Nœud', vector:'Vecteur', state:'État' },
  de: { name:'Deutsch', back:'← Sternkarte', bridge:'Brücke', daylight:'Tageslicht', themeAria:'Theme wechseln', langAria:'Sprache wechseln', nodeTelemetry:'Node-Telemetrie', allocation:'Zuweisung', resources:'Ressourcen', bandwidth:'Bandbreite', errorLog:'Fehlerprotokoll', fatalCodes:'Fatale Codes', nodeId:'Knoten-ID:', sector:'Sektor', systemCore:'Systemkern', runtime:'Laufzeit', expiry:'Ablauf', onlineSecure:'Quantensicher', ip:'IP', arch:'Arch', memory:'Speicher', disk:'Datenträger', geoCoords:'Koordinaten', uuid:'UUID', swap:'Swap', cpu:'CPU', mem:'Speicher', load:'Last', cores:'Kerne', uplink:'Upload', downlink:'Download', traffic:'Traffic', liveTransfer:'Live-Transfer', totalTraffic:'Gesamttraffic', fleetDb:'Flotten-DB', identity:'Identität', supplier:'Anbieter', city:'Stadt', multiNode:'Multi-Node-Probes', probeLatency:'Probe-Latenz', probe:'Probe', loss:'Verlust', telegramRules:'Telegram-Regeln', assetIndex:'Asset-Vektorindex', asset:'Asset', node:'Node', vector:'Vektor', state:'Status' },
  ru: { name:'Русский', back:'← Звёздная карта', bridge:'Мостик', daylight:'День', themeAria:'Сменить тему', langAria:'Сменить язык', nodeTelemetry:'Телеметрия', allocation:'Распределение', resources:'Ресурсы', bandwidth:'Канал', errorLog:'Журнал ошибок', fatalCodes:'Критические коды', nodeId:'ID узла:', sector:'Сектор', systemCore:'Ядро системы', runtime:'Время работы', expiry:'Срок', onlineSecure:'Квантовая защита', ip:'IP', arch:'Арх', memory:'Память', disk:'Диск', geoCoords:'Координаты', uuid:'UUID', swap:'Swap', cpu:'CPU', mem:'Память', load:'Нагрузка', cores:'ядра', uplink:'Исходящий', downlink:'Входящий', traffic:'Трафик', liveTransfer:'Живая передача', totalTraffic:'Всего трафика', fleetDb:'База активов', identity:'Идентификатор', supplier:'Поставщик', city:'Город', multiNode:'Мульти-пробы', probeLatency:'Задержка', probe:'Проба', loss:'потери', telegramRules:'Правила Telegram', assetIndex:'Векторный индекс', asset:'Актив', node:'Узел', vector:'Вектор', state:'Состояние' },
};
export let currentLanguage = safeStorageGet('display_language', 'zh') || 'zh';
export function t(key) { return (LANGUAGE_PACKS[currentLanguage] || LANGUAGE_PACKS.zh)[key] || LANGUAGE_PACKS.zh[key] || key; }
export function applyLanguage() {
  document.documentElement.setAttribute('lang', currentLanguage);
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  const lang = document.getElementById('languageSelect');
  if (lang) lang.value = currentLanguage;
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const label = document.getElementById('themeLabel');
  if (label) label.textContent = theme === 'dark' ? t('bridge') : t('daylight');
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.setAttribute('aria-label', t('themeAria'));
}
let languageSwitcherCallbacks = {
  isOverviewMode: () => false,
  getSelectedServerId: () => null,
  renderOverview: () => {},
  renderDetail: () => {},
};

export function configureLanguageSwitcher(callbacks = {}) {
  languageSwitcherCallbacks = { ...languageSwitcherCallbacks, ...callbacks };
}

export function setLanguage(lang) {
  currentLanguage = LANGUAGE_PACKS[lang] ? lang : 'zh';
  safeStorageSet('display_language', currentLanguage);
  applyLanguage();
  if (languageSwitcherCallbacks.isOverviewMode()) languageSwitcherCallbacks.renderOverview();
  else {
    const serverId = languageSwitcherCallbacks.getSelectedServerId();
    if (serverId) languageSwitcherCallbacks.renderDetail(serverId);
  }
}


export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  safeStorageSet('display_theme', theme);
  const icon = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (icon) icon.textContent = theme === 'dark' ? '☾' : '☀';
  if (label) label.textContent = theme === 'dark' ? t('bridge') : t('daylight');
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  setTheme(current === 'dark' ? 'light' : 'dark');
}
