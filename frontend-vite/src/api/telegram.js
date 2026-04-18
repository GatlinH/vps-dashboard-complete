/**
 * api/telegram.js
 * Telegram 机器人推送接口
 */
import { request } from './base.js';

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
  return request('/telegram/config', { method: 'POST', body: JSON.stringify(cfg) });
}

/** 发送测试消息 */
export async function testTg() {
  return request('/telegram/test', { method: 'POST' });
}

/**
 * 手动推送任意文本
 * @param {string} text
 */
export async function sendTgMessage(text) {
  return request('/telegram/send', { method: 'POST', body: JSON.stringify({ text }) });
}
