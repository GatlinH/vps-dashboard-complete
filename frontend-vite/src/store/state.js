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
  serversUpdatedAt: null,
  serversSource: '',

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
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return [];
}

function _defaultAffCards() {
  return [
    {
      provider: 'RackNerd', flag: '🇺🇸', location: '美国多机房',
      cpu: 2, ram: 2.5, disk: 40, bandwidth: '4TB/月',
      price: 10.98, period: '年', currency_sym: '$', stock: 'avail', stock_label: '有货',
      note: 'AMD EPYC，年付不到 $11，超高性价比，洛杉矶/圣何塞可选',
      buy_url: '#', review_url: '#',
      group_name: '入门推荐', sort_order: 10, i18n: {},
    },
    {
      provider: 'BandwagonHost', flag: '🇺🇸🇯🇵🇭🇰', location: '多节点可选',
      cpu: 2, ram: 1, disk: 20, bandwidth: '1TB/月',
      price: 49.99, period: '年', currency_sym: '$', stock: 'low', stock_label: '剩余少量',
      note: '搬瓦工经典款，CN2 GIA线路，延迟低，限购注意使用规则',
      buy_url: '#', review_url: '#',
      group_name: 'CN2线路', sort_order: 20, i18n: {},
    },
    {
      provider: 'Vultr', flag: '🌍', location: '全球32机房',
      cpu: 1, ram: 1, disk: 25, bandwidth: '1TB/月',
      price: 3.50, period: '月', currency_sym: '$', stock: 'avail', stock_label: '有货',
      note: '按小时计费，全球节点随意切换，新用户可领$100赠金',
      buy_url: '#', review_url: '#',
      group_name: '云厂商', sort_order: 30, i18n: {},
    },
    {
      provider: 'Hetzner', flag: '🇩🇪🇫🇮', location: '欧洲德国/芬兰',
      cpu: 2, ram: 4, disk: 40, bandwidth: '20TB/月',
      price: 4.51, period: '月', currency_sym: '€', stock: 'avail', stock_label: '有货',
      note: '欧洲性价比之王，ARM架构价格更低，机器质量稳定',
      buy_url: '#', review_url: '#',
      group_name: '欧洲推荐', sort_order: 40, i18n: {},
    },
    {
      provider: 'Bandwagon Special', flag: '🇭🇰', location: '香港 CN2 GIA',
      cpu: 2, ram: 2, disk: 40, bandwidth: '500GB/月',
      price: 299.99, period: '年', currency_sym: '$', stock: 'out', stock_label: '已售罄',
      note: '香港CN2 GIA顶级线路，延迟<5ms，库存长期缺货',
      buy_url: '#', review_url: '#',
      group_name: 'CN2线路', sort_order: 50, i18n: {},
    },
    {
      provider: 'DMIT', flag: '🇺🇸🇯🇵🇭🇰', location: 'CN2 GIA多节点',
      cpu: 1, ram: 1.5, disk: 20, bandwidth: '500GB/月',
      price: 28.88, period: '季', currency_sym: '$', stock: 'avail', stock_label: '有货',
      note: 'CN2 GIA Premium套餐，三网直连，iplc中继可选',
      buy_url: '#', review_url: '#',
      group_name: 'CN2线路', sort_order: 60, i18n: {},
    },
  ];
}

/** 持久化 servers 到 localStorage */
export function persistServers() {
  localStorage.setItem('vps_servers', JSON.stringify(state.servers));
}
