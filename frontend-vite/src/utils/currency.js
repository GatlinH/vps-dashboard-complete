/**
 * utils/currency.js
 * 货币换算 + 剩余价值计算
 */
import { state } from '../store/state.js';

/** 将 CNY 金额格式化为当前货币字符串 */
export function toDisplay(cnyAmount) {
  const { currency, exchangeRates } = state;
  if (currency === 'CNY') return `¥${Number(cnyAmount).toFixed(0)}`;
  if (currency === 'USD') return `$${(cnyAmount / exchangeRates.CNY).toFixed(2)}`;
  if (currency === 'EUR') return `€${(cnyAmount / exchangeRates.CNY * exchangeRates.EUR).toFixed(2)}`;
  return `¥${Number(cnyAmount).toFixed(0)}`;
}

/** 计算服务器剩余价值信息 */
export function calcResidualValue(server) {
  const now    = new Date();
  const expiry = new Date(server.expiry);
  const msLeft = expiry - now;
  if (msLeft <= 0) return { pct: 0, daysLeft: 0, value: 0, monthsLeft: '0.0' };
  const daysLeft   = Math.ceil(msLeft / 86400000);
  const monthsLeft = daysLeft / 30;
  const totalDays  = server.period === 'yearly' ? 365 : server.period === 'quarterly' ? 92 : 30;
  const pct        = Math.min(100, Math.max(0, (daysLeft / totalDays) * 100));
  const dailyRate  = server.price / totalDays;
  const value      = dailyRate * daysLeft;
  return { pct: Math.round(pct), daysLeft, value: Math.round(value), monthsLeft: monthsLeft.toFixed(1) };
}

/** 获取服务器月均价格（CNY） */
export function getMonthlyPrice(server) {
  if (server.period === 'monthly')   return server.price;
  if (server.period === 'yearly')    return server.price / 12;
  if (server.period === 'quarterly') return server.price / 3;
  return server.price;
}

/** 更新导航汇率显示文字 */
export function updateRateDisplay() {
  const el = document.getElementById('rateDisplay');
  if (!el) return;
  const { currency, exchangeRates } = state;
  const map = {
    CNY: `1 USD = ${exchangeRates.CNY} CNY`,
    USD: `基准货币 USD`,
    EUR: `1 USD = ${exchangeRates.EUR} EUR`,
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
