/**
 * api/telegram.js
 * Telegram 机器人推送接口
 */
import { request } from './base.js';

const TG_ERROR_MESSAGE_MAP = {
  TG_TIMEOUT: 'TG接口超时，请稍后重试',
  NETWORK_ERROR: '网络异常，请检查网络连接',
  TG_TOKEN_INVALID: 'token非法，请检查 Bot Token',
  TG_CHAT_INVALID: 'ChannelID/ChatID 非法，请检查后重试',
};

function mapTelegramError(err) {
  const type = err?.payload?.error_type || err?.payload?.detail?.error_type;
  if (type && TG_ERROR_MESSAGE_MAP[type]) {
    const mapped = new Error(TG_ERROR_MESSAGE_MAP[type]);
    mapped.cause = err;
    return mapped;
  }
  if (err?.status === 0 || /fetch/i.test(err?.message || '')) {
    const mapped = new Error(TG_ERROR_MESSAGE_MAP.NETWORK_ERROR);
    mapped.cause = err;
    return mapped;
  }
  return err;
}

/** 获取当前 bot 配置 */
export async function fetchTgConfig() {
  const data = await request('/telegram/config');
  return data.config || {};
}

/**
 * 保存 bot 配置
 * @param {{ bot_token, chat_id, prefix, enabled }} cfg
 */
export async function saveTgConfig(cfg) {
  try {
    return await request('/telegram/config', { method: 'POST', body: JSON.stringify(cfg) });
  } catch (err) {
    throw mapTelegramError(err);
  }
}

/** 发送测试消息 */
export async function testTg() {
  try {
    return await request('/telegram/test', { method: 'POST' });
  } catch (err) {
    throw mapTelegramError(err);
  }
}

/**
 * 手动推送任意文本
 * @param {string} text
 */
export async function sendTgMessage(text) {
  try {
    return await request('/telegram/send', { method: 'POST', body: JSON.stringify({ text }) });
  } catch (err) {
    throw mapTelegramError(err);
  }
}

/** 导出 Telegram 配置与告警规则 */
export async function exportTgBundle() {
  const token = localStorage.getItem('authToken');
  const res = await fetch('/api/v1/telegram/export', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let payload = {};
    try { payload = await res.json(); } catch (_) { payload = {}; }
    throw mapTelegramError(new Error(payload.msg || `导出失败 (${res.status})`));
  }
  return res.blob();
}
