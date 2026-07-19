import '../globals/dashboardGlobals.js';
/**
 * utils/currency.js
 * 货币换算 + 剩余价值计算
 */
import { state } from '../store/state.js';

/** 将 CNY 金额格式化为当前货币字符串 */
export function toDisplay(cnyAmount) {
  const { currency, exchangeRates } = state;
  const amount = Number(cnyAmount || 0);
  const cnyRate = Number(exchangeRates.CNY || 7.26);
  const eurRate = Number(exchangeRates.EUR || 0.92);
  if (currency === 'CNY') return `¥${amount.toFixed(0)}`;
  if (currency === 'USD') return `$${(amount / cnyRate).toFixed(2)}`;
  if (currency === 'EUR') return `€${(amount / cnyRate * eurRate).toFixed(2)}`;
  return `¥${amount.toFixed(0)}`;
}

export function sourceAmountToCny(amount, symbol = '') {
  const value = Number(amount || 0);
  const { exchangeRates } = state;
  const cnyRate = Number(exchangeRates.CNY || 7.26);
  const eurRate = Number(exchangeRates.EUR || 0.92);
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!Number.isFinite(value)) return 0;
  if (normalized === '$' || normalized === 'USD') return value * cnyRate;
  if (normalized === '€' || normalized === 'EUR') return eurRate > 0 ? value / eurRate * cnyRate : value * cnyRate;
  return value;
}

export function getSourceCurrency(server = {}) {
  return server.currency || server.currency_sym || server.agent_config?.billing?.currency || server.billing?.currency || '¥';
}

/** 计算服务器剩余价值信息 */
export function calcResidualValue(server) {
  const now = new Date();
  const expiry = new Date(server.expiry);
  const msLeft = expiry - now;
  if (msLeft <= 0) return { pct: 0, daysLeft: 0, value: 0, monthsLeft: '0.0' };
  const daysLeft = Math.ceil(msLeft / 86400000);
  const monthsLeft = daysLeft / 30;
  const months = getBillingMonths(server);
  const totalDays = months === 12 ? 365 : months === 6 ? 183 : months === 3 ? 92 : 30;
  const sourcePriceCny = sourceAmountToCny(server.price, getSourceCurrency(server));
  const pct = Math.min(100, Math.max(0, (daysLeft / totalDays) * 100));
  const dailyRate = sourcePriceCny / totalDays;
  const value = dailyRate * Math.min(daysLeft, totalDays);
  return { pct: Math.round(pct), daysLeft, value: Math.round(value), monthsLeft: monthsLeft.toFixed(1) };
}

function getPeriodMonths(period) {
  const normalized = String(period || 'monthly').toLowerCase();
  const map = {
    monthly: 1, month: 1, '1': 1, '月': 1,
    quarterly: 3, quarter: 3, '3': 3, '季': 3,
    semiannual: 6, semi_annually: 6, halfyearly: 6, half_yearly: 6, halfyear: 6, '6': 6, '半年': 6,
    yearly: 12, annual: 12, annually: 12, year: 12, '12': 12, '年': 12,
  };
  return map[normalized] || 1;
}

export function getBillingMonths(server = {}) {
  return getPeriodMonths(server.period || server.agent_config?.billing?.period || server.agent_config?.billing?.period_months);
}

/** 获取服务器月均价格（CNY） */
export function getMonthlyPrice(server) {
  const priceCny = sourceAmountToCny(server.price, getSourceCurrency(server));
  return priceCny / getBillingMonths(server);
}

/** 实时获取汇率：USD 基准，失败时保留默认/上次值 */
export async function refreshExchangeRates() {
  const sources = [
    'https://open.er-api.com/v6/latest/USD',
    'https://api.frankfurter.app/latest?from=USD&to=CNY,EUR',
  ];
  for (const url of sources) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const rates = data?.rates || {};
      const cny = Number(rates.CNY);
      const eur = Number(rates.EUR);
      if (Number.isFinite(cny) && cny > 0 && Number.isFinite(eur) && eur > 0) {
        state.exchangeRates = { USD: 1, CNY: Number(cny.toFixed(4)), EUR: Number(eur.toFixed(4)) };
        state.exchangeRatesUpdatedAt = new Date().toISOString();
        state.exchangeRatesSource = url;
        updateRateDisplay();
        return state.exchangeRates;
      }
    } catch (error) {
      window.__DBG__.EXCHANGE_RATE_ERROR = String(error?.message || error);
    }
  }
  updateRateDisplay();
  return state.exchangeRates;
}

/** 更新导航汇率显示文字 */
export function updateRateDisplay() {
  const el = document.getElementById('rateDisplay');
  if (!el) return;
  const { currency, exchangeRates } = state;
  const cny = Number(exchangeRates.CNY || 0).toFixed(2);
  const eur = Number(exchangeRates.EUR || 0).toFixed(4);
  const map = {
    CNY: `1 USD = ${cny} CNY`,
    USD: `基准货币 USD`,
    EUR: `1 USD = ${eur} EUR`,
  };
  el.textContent = map[currency] || '';
}

/**
 * 本地估值计算（与后端 /estimate 算法保持一致，作为离线 fallback）
 * @param {{
 *   price: number,
 *   period: string,      'monthly'|'quarterly'|'yearly'|'1'|'3'|'12'
 *   buy_date: string,    YYYY-MM-DD
 *   expiry?: string,     YYYY-MM-DD（可选，优先使用）
 *   premium_percent?: number
 * }} params
 * @returns {{
 *   price, period, buy_date, expiry, total_days,
 *   days_used, days_left, daily_rate,
 *   consumed_value, residual_value,
 *   premium_percent, suggested_price, residual_percent
 * }}
 */
export function calcEstimateLocal({ price, period, buy_date, expiry, premium_percent = 0 }) {
  const PERIOD_DAYS = { monthly: 30, quarterly: 92, yearly: 365, '1': 30, '3': 92, '12': 365 };
  const PERIOD_NORM = { '1': 'monthly', '3': 'quarterly', '12': 'yearly' };
  const normPeriod  = PERIOD_NORM[String(period)] || period;
  const totalDays   = PERIOD_DAYS[String(period)] || 30;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buyDate   = new Date(buy_date);
  const expiryDate = expiry ? new Date(expiry) : new Date(buyDate.getTime() + totalDays * 86400000);

  const daysUsed   = Math.max(0, Math.round((today - buyDate) / 86400000));
  const daysLeft   = Math.max(0, Math.round((expiryDate - today) / 86400000));
  const dailyRate  = price / totalDays;
  const consumed   = Math.round(Math.min(price, dailyRate * daysUsed));
  const residual   = Math.round(Math.max(0, dailyRate * daysLeft));
  const suggested  = Math.round(residual * (1 + premium_percent / 100));
  const pct        = totalDays > 0 ? Math.max(0, Math.min(100, Math.round(daysLeft / totalDays * 100))) : 0;

  return {
    price,
    period: normPeriod,
    buy_date,
    expiry: expiryDate.toISOString().split('T')[0],
    total_days: totalDays,
    days_used: daysUsed,
    days_left: daysLeft,
    daily_rate: Math.round(dailyRate * 100) / 100,
    consumed_value: consumed,
    residual_value: residual,
    premium_percent,
    suggested_price: suggested,
    residual_percent: pct,
  };
}
