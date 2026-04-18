/**
 * components/admin/TelegramPanel.js
 * Telegram 机器人推送配置面板
 */
import { fetchTgConfig, saveTgConfig, testTg, sendTgMessage } from '../../api/telegram.js';

export class TelegramPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._render();
    this._bind();
  }

  // ── 公开 ─────────────────────────────────────────────────────────────────

  async load() {
    try {
      const cfg = await fetchTgConfig();
      if (cfg.bot_token) this._q('#tp-token').value  = cfg.bot_token;
      if (cfg.chat_id)   this._q('#tp-chat').value   = cfg.chat_id;
      if (cfg.prefix)    this._q('#tp-prefix').value = cfg.prefix;
      this._updateStatus();
    } catch (_) { /* 未配置时静默忽略 */ }
  }

  // ── 骨架渲染 ─────────────────────────────────────────────────────────────

  _render() {
    this._el.innerHTML = /* html */`
      <div class="admin-section-title">Telegram 机器人推送</div>

      <!-- Bot 配置 -->
      <div class="admin-card">
        <div class="admin-card-title">🔑 机器人配置</div>
        <div id="tp-status" class="tg-status tg-disconnected">
          <span>●</span> 未连接 — 请填写 Bot Token 和 Chat ID
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="grid-column:1/-1">
            <label class="form-label">Bot Token</label>
            <input class="form-input" id="tp-token" placeholder="1234567890:ABCDEFGabcdefg..." type="password">
          </div>
          <div class="form-group">
            <label class="form-label">Chat ID</label>
            <input class="form-input" id="tp-chat" placeholder="-100123456789 或 @username">
          </div>
          <div class="form-group">
            <label class="form-label">消息模板前缀</label>
            <input class="form-input" id="tp-prefix" value="【VPS星图】">
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="add-btn" id="tp-save">保存配置</button>
          <button id="tp-test" style="padding:8px 18px;border-radius:8px;background:rgba(99,179,237,.1);border:1px solid var(--border2);color:var(--accent);cursor:pointer;font-size:13px">发送测试消息</button>
        </div>
        <div id="tp-msg" style="margin-top:8px;font-size:12px;min-height:18px"></div>
      </div>

      <!-- 告警规则 -->
      <div class="admin-card">
        <div class="admin-card-title">🔔 告警规则配置</div>
        <div class="tg-alert-list">
          <div class="tg-alert-item">
            <span>CPU 使用率超过阈值</span>
            <div style="display:flex;align-items:center;gap:8px">
              <input class="form-input" id="tp-cpu-val" value="90" type="number" style="width:60px;padding:4px 8px">
              <span style="font-size:12px;color:var(--text3)">%</span>
              <label class="toggle-switch"><input type="checkbox" id="tp-cpu-on" checked><span class="toggle-slider"></span></label>
            </div>
          </div>
          <div class="tg-alert-item">
            <span>内存使用率超过阈值</span>
            <div style="display:flex;align-items:center;gap:8px">
              <input class="form-input" id="tp-ram-val" value="90" type="number" style="width:60px;padding:4px 8px">
              <span style="font-size:12px;color:var(--text3)">%</span>
              <label class="toggle-switch"><input type="checkbox" id="tp-ram-on" checked><span class="toggle-slider"></span></label>
            </div>
          </div>
          <div class="tg-alert-item">
            <span>服务器离线检测</span>
            <label class="toggle-switch" style="margin-left:auto"><input type="checkbox" id="tp-offline-on" checked><span class="toggle-slider"></span></label>
          </div>
          <div class="tg-alert-item">
            <span>到期前 7 天提醒</span>
            <label class="toggle-switch" style="margin-left:auto"><input type="checkbox" id="tp-expiry-on" checked><span class="toggle-slider"></span></label>
          </div>
        </div>
        <button class="add-btn" style="margin-top:12px" id="tp-save-rules">保存告警规则</button>
        <div id="tp-alert-msg" style="margin-top:8px;font-size:12px;min-height:18px"></div>
      </div>

      <!-- 手动推送 -->
      <div class="admin-card">
        <div class="admin-card-title">📤 手动推送</div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px">
          <textarea class="form-input" id="tp-manual" style="resize:vertical;min-height:80px;font-family:var(--sans)" placeholder="输入要推送的消息内容..."></textarea>
          <button class="add-btn" id="tp-manual-send" style="align-self:flex-end">推送</button>
        </div>
      </div>`;
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────

  _bind() {
    this._q('#tp-save').addEventListener('click',        () => this._save());
    this._q('#tp-test').addEventListener('click',        () => this._test());
    this._q('#tp-save-rules').addEventListener('click',  () => this._saveRules());
    this._q('#tp-manual-send').addEventListener('click', () => this._manualSend());
  }

  // ── 状态显示 ─────────────────────────────────────────────────────────────

  _updateStatus() {
    const el    = this._q('#tp-status');
    const token = this._q('#tp-token').value.trim();
    const chat  = this._q('#tp-chat').value.trim();
    if (token && chat) {
      el.className = 'tg-status tg-connected';
      el.innerHTML = `<span>●</span> 已配置 — Chat ID: ${chat}`;
    } else {
      el.className = 'tg-status tg-disconnected';
      el.innerHTML = '<span>●</span> 未连接 — 请填写 Bot Token 和 Chat ID';
    }
  }

  // ── 保存配置 ─────────────────────────────────────────────────────────────

  async _save() {
    try {
      await saveTgConfig({
        bot_token: this._q('#tp-token').value.trim(),
        chat_id:   this._q('#tp-chat').value.trim(),
        prefix:    this._q('#tp-prefix').value.trim() || '【VPS星图】',
        enabled:   true,
      });
      this._msg('tp-msg', '✅ 配置已保存', 'green');
      this._updateStatus();
    } catch (e) { this._msg('tp-msg', e.message, 'red'); }
  }

  // ── 测试 ─────────────────────────────────────────────────────────────────

  async _test() {
    this._msg('tp-msg', '发送中...', 'blue');
    try {
      await testTg();
      this._msg('tp-msg', '✅ 测试消息已发送', 'green');
    } catch (e) { this._msg('tp-msg', e.message, 'red'); }
  }

  // ── 告警规则 ─────────────────────────────────────────────────────────────

  _saveRules() {
    const rules = {
      cpuThreshold: parseInt(this._q('#tp-cpu-val').value) || 90,
      cpuOn:        this._q('#tp-cpu-on').checked,
      ramThreshold: parseInt(this._q('#tp-ram-val').value) || 90,
      ramOn:        this._q('#tp-ram-on').checked,
      offlineOn:    this._q('#tp-offline-on').checked,
      expiryOn:     this._q('#tp-expiry-on').checked,
    };
    localStorage.setItem('vps_alerts', JSON.stringify(rules));
    this._msg('tp-alert-msg', '✅ 告警规则已保存', 'green');
  }

  // ── 手动推送 ─────────────────────────────────────────────────────────────

  async _manualSend() {
    const text = this._q('#tp-manual').value.trim();
    if (!text) { this._msg('tp-msg', '消息不能为空', 'red'); return; }
    try {
      await sendTgMessage(text);
      this._q('#tp-manual').value = '';
      this._msg('tp-msg', '✅ 已推送', 'green');
    } catch (e) { this._msg('tp-msg', e.message, 'red'); }
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────

  _q(sel) { return this._el.querySelector(sel); }

  _msg(elId, text, type) {
    const el = this._el.querySelector(`#${elId}`);
    if (!el) return;
    const colors = { green: 'var(--green)', red: 'var(--red)', blue: 'var(--accent)' };
    el.style.color = colors[type] || 'var(--text2)';
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3500);
  }
}
