/**
 * store/state.js
 * 轻量级响应式状态管理，替代原来散落的全局变量
 * 用法：
 *   import { state, subscribe } from './state.js'
 *   state.currency = 'USD'          // 直接赋值触发订阅
 *   subscribe('currency', cb)       // 监听单字段变化
 *   subscribe('*', cb)              // 监听所有变化
 */

const _listeners = new Map(); // field → Set<callback>

const _raw = {
  currency:    'CNY',
  exchangeRates: { USD: 1, CNY: 7.26, EUR: 0.92 },
  activeGroup: '全部',
  trafficActiveGroup: '全部',

  /** @type {Server[]} */
  servers: _defaultServers(),

  /** @type {AffCard[]} */
  affCards: _defaultAffCards(),
};

export const state = new Proxy(_raw, {
  set(target, key, value) {
    const prev = target[key];
    target[key] = value;
    if (prev !== value) _emit(key, value, prev);
    return true;
  },
});

/** 订阅字段变化；field 传 '*' 可监听所有 */
export function subscribe(field, cb) {
  if (!_listeners.has(field)) _listeners.set(field, new Set());
  _listeners.get(field).add(cb);
  return () => _listeners.get(field).delete(cb); // 返回取消订阅函数
}

function _emit(field, value, prev) {
  _listeners.get(field)?.forEach(cb => cb(value, prev));
  _listeners.get('*')?.forEach(cb => cb(field, value, prev));
}

// ─── 默认数据 ───────────────────────────────────────────────────────────────

function _defaultServers() {
  const saved = localStorage.getItem('vps_servers');
  if (saved) {
    try { return JSON.parse(saved); } catch (_) { /* fall through */ }
  }
  return [
    {
      id: 1, name: 'LA-Pro-01', group: '生产环境', flag: '🇺🇸',
      location: '美国洛杉矶', ip: '104.21.45.67',
      cpu: 4, ram: 8, disk: 100, bw: '1Gbps不限',
      cpu_use: 34, ram_use: 62, disk_use: 45, net_up: 12.4, net_down: 89.2,
      status: 'online', uptime: '99.98%',
      price: 99, period: 'yearly', expiry: '2026-06-15',
      note: '主力生产服务器，运行主站业务',
      probe: 'https://probe.example.com/1',
      traffic_limit_gb: 0, traffic_used_gb: 0,
      traffic_up_gb: 342.5, traffic_down_gb: 1820.3, traffic_reset_day: 1,
    },
    {
      id: 2, name: 'HK-Node-02', group: '香港节点', flag: '🇭🇰',
      location: '香港 CMI', ip: '43.155.88.12',
      cpu: 2, ram: 2, disk: 40, bw: '200GB/月',
      cpu_use: 78, ram_use: 88, disk_use: 72, net_up: 45.1, net_down: 120.5,
      status: 'warn', uptime: '99.1%',
      price: 68, period: 'monthly', expiry: '2026-04-10',
      note: '香港中转节点，流量较高需注意',
      probe: 'https://probe.example.com/2',
      traffic_limit_gb: 200, traffic_used_gb: 187.4,
      traffic_up_gb: 62.1, traffic_down_gb: 125.3, traffic_reset_day: 1,
    },
    {
      id: 3, name: 'JP-Sakura-03', group: '日本节点', flag: '🇯🇵',
      location: '日本东京 SoftBank', ip: '27.0.234.55',
      cpu: 8, ram: 16, disk: 200, bw: '10Gbps共享',
      cpu_use: 22, ram_use: 41, disk_use: 38, net_up: 8.9, net_down: 56.3,
      status: 'online', uptime: '100%',
      price: 288, period: 'yearly', expiry: '2026-12-01',
      note: 'Sakura云，延迟极低',
      probe: 'https://probe.example.com/3',
      traffic_limit_gb: 0, traffic_used_gb: 0,
      traffic_up_gb: 128.7, traffic_down_gb: 534.2, traffic_reset_day: 1,
    },
    {
      id: 4, name: 'DE-Hetzner-04', group: '欧洲节点', flag: '🇩🇪',
      location: '德国法兰克福', ip: '95.216.12.88',
      cpu: 6, ram: 12, disk: 240, bw: '不限',
      cpu_use: 15, ram_use: 33, disk_use: 61, net_up: 5.2, net_down: 30.1,
      status: 'online', uptime: '99.99%',
      price: 45, period: 'monthly', expiry: '2026-05-20',
      note: 'Hetzner性价比神机',
      probe: 'https://probe.example.com/4',
      traffic_limit_gb: 0, traffic_used_gb: 0,
      traffic_up_gb: 89.3, traffic_down_gb: 412.6, traffic_reset_day: 1,
    },
    {
      id: 5, name: 'SG-Linode-05', group: '东南亚', flag: '🇸🇬',
      location: '新加坡', ip: '172.104.55.99',
      cpu: 1, ram: 1, disk: 25, bw: '1TB/月',
      cpu_use: 5, ram_use: 55, disk_use: 20, net_up: 2.1, net_down: 18.5,
      status: 'offline', uptime: '95.2%',
      price: 30, period: 'monthly', expiry: '2026-04-05',
      note: '已到期，待续费', probe: '',
      traffic_limit_gb: 1024, traffic_used_gb: 634.8,
      traffic_up_gb: 201.3, traffic_down_gb: 433.5, traffic_reset_day: 15,
    },
    {
      id: 6, name: 'US-OVH-06', group: '生产环境', flag: '🇺🇸',
      location: '美国纽约 OVH', ip: '51.81.22.44',
      cpu: 4, ram: 4, disk: 80, bw: '不限',
      cpu_use: 48, ram_use: 71, disk_use: 55, net_up: 25.0, net_down: 180.0,
      status: 'online', uptime: '99.5%',
      price: 159, period: 'yearly', expiry: '2027-01-15',
      note: 'OVH备份节点', probe: 'https://probe.example.com/6',
      traffic_limit_gb: 0, traffic_used_gb: 0,
      traffic_up_gb: 445.2, traffic_down_gb: 2301.8, traffic_reset_day: 1,
    },
  ];
}

function _defaultAffCards() {
  return [
    {
      provider: 'RackNerd', flag: '🇺🇸', location: '美国多机房',
      cpu: 2, ram: 2.5, disk: 40, bw: '4TB/月', ip_count: 1,
      price: 10.98, period: '年', currency_sym: '$', stock: 'avail', stock_label: '有货',
      note: 'AMD EPYC，年付不到 $11，超高性价比，洛杉矶/圣何塞可选',
      buy_url: '#', review_url: '#',
    },
    {
      provider: 'BandwagonHost', flag: '🇺🇸🇯🇵🇭🇰', location: '多节点可选',
      cpu: 2, ram: 1, disk: 20, bw: '1TB/月', ip_count: 1,
      price: 49.99, period: '年', currency_sym: '$', stock: 'low', stock_label: '剩余少量',
      note: '搬瓦工经典款，CN2 GIA线路，延迟低，限购注意使用规则',
      buy_url: '#', review_url: '#',
    },
    {
      provider: 'Vultr', flag: '🌍', location: '全球32机房',
      cpu: 1, ram: 1, disk: 25, bw: '1TB/月', ip_count: 1,
      price: 3.50, period: '月', currency_sym: '$', stock: 'avail', stock_label: '有货',
      note: '按小时计费，全球节点随意切换，新用户可领$100赠金',
      buy_url: '#', review_url: '#',
    },
    {
      provider: 'Hetzner', flag: '🇩🇪🇫🇮', location: '欧洲德国/芬兰',
      cpu: 2, ram: 4, disk: 40, bw: '20TB/月', ip_count: 1,
      price: 4.51, period: '月', currency_sym: '€', stock: 'avail', stock_label: '有货',
      note: '欧洲性价比之王，ARM架构价格更低，机器质量稳定',
      buy_url: '#', review_url: '#',
    },
    {
      provider: 'Bandwagon Special', flag: '🇭🇰', location: '香港 CN2 GIA',
      cpu: 2, ram: 2, disk: 40, bw: '500GB/月', ip_count: 1,
      price: 299.99, period: '年', currency_sym: '$', stock: 'out', stock_label: '已售罄',
      note: '香港CN2 GIA顶级线路，延迟<5ms，库存长期缺货',
      buy_url: '#', review_url: '#',
    },
    {
      provider: 'DMIT', flag: '🇺🇸🇯🇵🇭🇰', location: 'CN2 GIA多节点',
      cpu: 1, ram: 1.5, disk: 20, bw: '500GB/月', ip_count: 1,
      price: 28.88, period: '季', currency_sym: '$', stock: 'avail', stock_label: '有货',
      note: 'CN2 GIA Premium套餐，三网直连，iplc中继可选',
      buy_url: '#', review_url: '#',
    },
  ];
}

/** 持久化 servers 到 localStorage */
export function persistServers() {
  localStorage.setItem('vps_servers', JSON.stringify(state.servers));
}
