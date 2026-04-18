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
