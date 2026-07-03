/**
 * components/admin/TelegramPanel.js
 * Telegram 机器人推送配置面板
 */
import { fetchTgConfig, saveTgConfig, testTg, sendTgMessage, exportTgBundle, fetchTgAlerts, saveTgAlerts, createTgAlertRule, updateTgAlertRule, toggleTgAlertRule, deleteTgAlertRule } from '../../api/telegram.js';
import { getNotificationSettings } from '../../api/admin.js';

export class TelegramPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._maskedToken = '';
    this._bots = [];
    this._activeBotId = '';
    this._rules = [];
    this._notifySettings = {};
    this._render();
    this._bind();
  }

  // ── 公开 ─────────────────────────────────────────────────────────────────

  prefillRule({ serverId = '', ruleType = '' } = {}) {
    if (serverId) this._q('#tp-rule-server-id').value = String(serverId);
    if (ruleType) this._q('#tp-rule-type').value = ruleType;
    const nameEl = this._q('#tp-rule-name');
    if (nameEl && !nameEl.value.trim()) {
      const typeLabel = this._q('#tp-rule-type')?.selectedOptions?.[0]?.textContent || ruleType || '规则';
      nameEl.value = `${serverId ? `节点 ${serverId} · ` : ''}${typeLabel}`;
    }
    this._q('#tp-rule-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async load() {
    try {
      const payload = await fetchTgConfig();
      const cfg = payload.config || payload || {};
      this._bots = payload.bots || (cfg.id ? [cfg] : []);
      this._activeBotId = String(cfg.id || this._bots[0]?.id || '');
      this._renderBotOptions();
      this._fillBotForm(cfg);
      this._updateStatus();
      const [alertsPayload, notifySettings] = await Promise.all([fetchTgAlerts(), getNotificationSettings().catch(() => ({}))]);
      this._bots = alertsPayload.bots || this._bots;
      this._notifySettings = notifySettings || {};
      this._renderBotOptions();
      this._applyRules(alertsPayload.rules || alertsPayload);
    } catch (_) { /* 未配置时静默忽略 */ }
  }

  // ── 骨架渲染 ─────────────────────────────────────────────────────────────

  _render() {
    this._el.innerHTML = /* html */`
      <!-- 告警规则 -->
      <div class="admin-card">
        <div class="admin-card-title">🔔 告警规则中心</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px">支持全局 / 节点级规则、冷却时间、重复通知、到期提醒、延迟与连续失败。</div>
        <div class="tp-rule-form-grid">
          <div class="form-group"><label class="form-label">规则名称</label><input class="form-input" id="tp-rule-name" placeholder="如：全局 CPU 90%"></div>
          <div class="form-group"><label class="form-label">规则类型</label><select class="form-input" id="tp-rule-type"><option value="cpu">CPU</option><option value="ram">RAM</option><option value="disk">磁盘</option><option value="offline">离线</option><option value="latency">延迟</option><option value="consecutive_failures">连续失败</option><option value="expiry">到期提醒</option></select></div>
          <div class="form-group"><label class="form-label">阈值</label><input class="form-input" id="tp-rule-threshold" type="number" value="90"></div>
          <div class="form-group"><label class="form-label">冷却秒数</label><input class="form-input" id="tp-rule-cooldown" type="number" value="300"></div>
          <div class="form-group"><label class="form-label">节点 ID</label><input class="form-input" id="tp-rule-server-id" placeholder="留空=全局"></div>
          <div class="form-group tp-rule-channel-field"><label class="form-label">渠道</label><select class="form-input" id="tp-rule-bot"></select></div>
          <div class="form-group tp-rule-target-field"><label class="form-label">目标</label><select class="form-input" id="tp-rule-chat"></select></div>
          <div class="form-group"><label class="form-label">规则备注</label><input class="form-input" id="tp-rule-note" placeholder="如：生产节点更敏感"></div>
        </div>
        <div style="display:flex;gap:14px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2)"><input type="checkbox" id="tp-rule-enabled" checked> 启用规则</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2)"><input type="checkbox" id="tp-rule-repeat" checked> 允许重复通知</label>
          <button class="add-btn" id="tp-rule-create">新增规则</button>
          <button id="tp-rule-cancel" style="display:none;padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px">取消编辑</button>
        </div>
        <div id="tp-alert-msg" style="margin-top:8px;font-size:12px;min-height:18px"></div>
        <div id="tp-rules-list" style="display:grid;gap:10px;margin-top:12px"></div>
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
    this._q('#tp-rule-create').addEventListener('click', () => this._upsertRule());
    this._q('#tp-rule-cancel').addEventListener('click', () => this._resetRuleForm());
    this._q('#tp-rule-bot').addEventListener('change', () => this._renderRuleTargetOptions());
    this._q('#tp-rules-list').addEventListener('click', (e) => this._handleRuleListClick(e));
    this._q('#tp-manual-send').addEventListener('click', () => this._manualSend());
  }

  _renderBotOptions() {
    const opts = (this._bots || []).map(b => `<option value="${b.id}">${this._escapeHtml(b.name || `Telegram 机器人 ${b.id}`)}</option>`).join('');
    const html = opts || '<option value="">Telegram</option>';
    if (this._q('#tp-rule-bot')) {
      this._q('#tp-rule-bot').innerHTML = this._ruleChannelOptionsHtml();
      this._renderRuleTargetOptions();
    }
  }

  _ruleChannelOptionsHtml() {
    const settings = this._notifySettings || {};
    const channels = settings.channels || {};
    const rows = [];
    const order = ['Javascript', 'Server酱·Turbo', 'Server酱³', 'Server酱', 'bark', 'email', 'empty', 'telegram', 'webhook'];
    const canonicalKey = (label) => ({ 'Server酱·Turbo': 'Server酱Turbo' }[label] || label);
    const seen = new Set();
    const add = (key, label) => { if (!seen.has(key)) { seen.add(key); rows.push({ value: `notify:${key}`, label }); } };
    order.forEach(label => {
      const key = canonicalKey(label);
      if (Object.prototype.hasOwnProperty.call(channels, key)) add(key, label);
    });
    Object.keys(channels).forEach(key => add(key, this._channelLabel(key)));
    /* rule-channel-dedup-20260611: 渠道下拉只列通知渠道，不再列具体 bot 实例（避免与 telegram 选项重合，去掉“默认机器人”重复项） */
    if (!rows.length) rows.push({ value: 'notify:telegram', label: 'telegram' });
    return rows.map(r => `<option value="${this._escapeHtml(r.value)}">${this._escapeHtml(r.label)}</option>`).join('');
  }

  _channelLabel(name) {
    const map = { telegram: 'telegram', webhook: 'webhook', email: 'email', Javascript: 'Javascript', 'Server酱Turbo': 'Server酱·Turbo', 'Server酱³': 'Server酱³', 'Server酱': 'Server酱', bark: 'bark', empty: 'empty' };
    return map[name] || name;
  }

  _fillBotForm(cfg = {}) {
    this._hasStoredToken = !!cfg.has_token;
    this._maskedToken = cfg.bot_token_masked || '';
    const botName = this._q('#tp-bot-name');
    const token = this._q('#tp-token');
    const chat = this._q('#tp-chat');
    const prefix = this._q('#tp-prefix');
    if (botName) botName.value = cfg.name || '';
    if (token) {
      token.value = '';
      token.placeholder = this._maskedToken || (this._hasStoredToken ? '已保存 Bot Token（留空不修改）' : '');
    }
    if (chat) chat.value = cfg.chat_id || '';
    if (prefix) prefix.value = cfg.prefix || '【VPS星图】';
  }

  _selectBot() {
    const select = this._q('#tp-bot-select');
    this._activeBotId = select?.value || '';
    const cfg = this._bots.find(b => String(b.id) === String(this._activeBotId)) || {};
    this._fillBotForm(cfg);
    this._updateStatus();
  }

  _newBot() {
    this._activeBotId = '';
    this._fillBotForm({ name: '', prefix: '【VPS星图】' });
    const select = this._q('#tp-bot-select');
    if (select) select.value = '';
    this._updateStatus();
  }

  // ── 状态显示 ─────────────────────────────────────────────────────────────

  _updateStatus() {
    const el = this._q('#tp-status');
    if (!el) return;
    const tokenInput = this._q('#tp-token');
    const chatInput = this._q('#tp-chat');
    const token = (tokenInput?.value || '').trim() || (this._hasStoredToken ? '__stored__' : '');
    const chat = (chatInput?.value || '').trim();
    if (token && chat) {
      el.className = 'tg-status tg-connected';
      el.innerHTML = '<span>●</span> 已配置 — Chat ID: ';
      el.appendChild(document.createTextNode(chat));
    } else {
      el.className = 'tg-status tg-disconnected';
      el.innerHTML = '<span>●</span> 未连接 — 请填写 Bot Token 和 Chat ID';
    }
  }

  // ── 保存配置 ─────────────────────────────────────────────────────────────

  async _save() {
    const valid = this._validateConfig({ allowStoredToken: true });
    if (!valid.ok) return this._msg('tp-msg', valid.message, 'red');
    try {
      await saveTgConfig({
        ...(this._activeBotId ? { id: this._activeBotId } : {}),
        name:      this._q('#tp-bot-name').value.trim() || '默认机器人',
        ...(valid.token ? { bot_token: valid.token } : {}),
        chat_id:   valid.chatId,
        prefix:    this._q('#tp-prefix').value.trim() || '【VPS星图】',
        enabled:   true,
        is_default: !this._bots.length,
      });
      this._msg('tp-msg', '✅ 配置已保存', 'green');
      await this.load();
    } catch (e) { this._msg('tp-msg', e.message, 'red'); }
  }

  // ── 测试 ─────────────────────────────────────────────────────────────────

  async _test() {
    const valid = this._validateConfig({ allowStoredToken: true });
    if (!valid.ok) return this._msg('tp-msg', valid.message, 'red');
    this._msg('tp-msg', '发送中...', 'blue');
    try {
      await testTg(this._activeBotId);
      this._msg('tp-msg', '✅ 测试消息已发送', 'green');
    } catch (e) { this._msg('tp-msg', e.message, 'red'); }
  }

  async _exportBundle() {
    try {
      const blob = await exportTgBundle();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `telegram-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this._msg('tp-msg', '✅ 已导出配置与规则', 'green');
    } catch (e) {
      this._msg('tp-msg', e.message || '导出失败', 'red');
    }
  }

  // ── 告警规则 ─────────────────────────────────────────────────────────────

  _rulePayloadFromForm() {
    return {
      name: this._q('#tp-rule-name').value.trim(),
      rule_type: this._q('#tp-rule-type').value,
      threshold: Number(this._q('#tp-rule-threshold').value || 0),
      cool_down_s: Number(this._q('#tp-rule-cooldown').value || 0),
      server_id: this._q('#tp-rule-server-id').value.trim() || null,
      bot_id: String(this._q('#tp-rule-bot').value || '').startsWith('notify:') ? null : (this._q('#tp-rule-bot').value || null),
      target_chat_id: this._q('#tp-rule-chat').value.trim(),
      note: this._q('#tp-rule-note').value.trim(),
      enabled: this._q('#tp-rule-enabled').checked,
      notify_repeat: this._q('#tp-rule-repeat').checked,
    };
  }

  async _upsertRule() {
    try {
      const payload = this._rulePayloadFromForm();
      if (this._editingRuleId) {
        await updateTgAlertRule(this._editingRuleId, payload);
        this._msg('tp-alert-msg', '✅ 规则已更新', 'green');
      } else {
        await createTgAlertRule(payload);
        this._msg('tp-alert-msg', '✅ 规则已创建', 'green');
      }
      const fresh = await fetchTgAlerts();
      if (fresh.bots) { this._bots = fresh.bots; this._renderBotOptions(); }
      this._applyRules(fresh.rules || fresh);
      this._resetRuleForm();
    } catch (e) {
      this._msg('tp-alert-msg', e.message || '保存失败', 'red');
    }
  }

  _applyRules(rules = []) {
    this._rules = Array.isArray(rules) ? rules : [];
    this._renderRuleList();
  }

  _escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  _renderRuleList() {
    const el = this._q('#tp-rules-list');
    if (!el) return;
    if (!this._rules.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:10px 0">暂无规则，先创建一条。</div>';
      return;
    }
    el.innerHTML = this._rules.map((r) => {
      const id = Number(r.id) || 0;
      const name = this._escapeHtml(r.name || r.rule_type || '规则');
      const ruleType = this._escapeHtml(r.rule_type || 'unknown');
      const scope = r.scope === 'server' ? `节点 ${this._escapeHtml(r.server_id || '')}` : '全局';
      const threshold = this._escapeHtml(r.threshold ?? '—');
      const cooldown = this._escapeHtml(r.cool_down_s ?? '—');
      const botName = this._escapeHtml(this._ruleChannelDisplay(r));
      const target = this._escapeHtml(this._ruleTargetDisplay(r));
      const note = this._escapeHtml(r.note || '—');
      return `
      <div class="ping-server-item" style="align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <strong style="font-size:13px;color:var(--text)">${name}</strong>
            <span style="font-size:10px;padding:2px 6px;border-radius:999px;background:rgba(91,141,239,.12);color:var(--accent)">${scope}</span>
            <span style="font-size:10px;padding:2px 6px;border-radius:999px;background:${r.enabled ? 'rgba(56,239,125,.12)' : 'rgba(255,107,107,.12)'};color:${r.enabled ? 'var(--green)' : 'var(--red)'}">${r.enabled ? '启用' : '停用'}</span>
          </div>
          <div style="font-size:12px;color:var(--text2);margin-top:4px">类型：${ruleType} · 阈值：${threshold} · 冷却：${cooldown}s · 重复通知：${r.notify_repeat ? '允许' : '禁止'}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:3px">渠道：${botName} · 目标：${target} · 备注：${note}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button data-rule-edit="${id}" style="font-size:11px;padding:4px 10px;border-radius:6px;background:rgba(91,141,239,.1);border:1px solid rgba(91,141,239,.2);color:var(--accent);cursor:pointer">编辑</button>
          <button data-rule-toggle="${id}" data-enabled="${r.enabled ? '1' : '0'}" style="font-size:11px;padding:4px 10px;border-radius:6px;background:rgba(255,159,67,.12);border:1px solid rgba(255,159,67,.25);color:var(--orange);cursor:pointer">${r.enabled ? '停用' : '启用'}</button>
          <button data-rule-delete="${id}" style="font-size:11px;padding:4px 10px;border-radius:6px;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.2);color:var(--red);cursor:pointer">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  async _handleRuleListClick(e) {
    const editId = e.target.closest('[data-rule-edit]')?.dataset.ruleEdit;
    const toggleBtn = e.target.closest('[data-rule-toggle]');
    const deleteId = e.target.closest('[data-rule-delete]')?.dataset.ruleDelete;
    if (editId) return this._editRule(editId);
    if (toggleBtn) {
      await toggleTgAlertRule(toggleBtn.dataset.ruleToggle, toggleBtn.dataset.enabled !== '1');
      const fresh = await fetchTgAlerts();
      if (fresh.bots) { this._bots = fresh.bots; this._renderBotOptions(); }
      this._applyRules(fresh.rules || fresh);
      return;
    }
    if (deleteId) {
      await deleteTgAlertRule(deleteId);
      const fresh = await fetchTgAlerts();
      this._applyRules(fresh.rules || fresh);
    }
  }

  _editRule(ruleId) {
    const rule = this._rules.find((r) => String(r.id) === String(ruleId));
    if (!rule) return;
    this._editingRuleId = rule.id;
    this._q('#tp-rule-name').value = rule.name || '';
    this._q('#tp-rule-type').value = rule.rule_type || 'cpu';
    this._q('#tp-rule-threshold').value = rule.threshold ?? 90;
    this._q('#tp-rule-cooldown').value = rule.cool_down_s ?? 300;
    this._q('#tp-rule-server-id').value = rule.server_id || '';
    const selectedChannel = this._selectionFromRule(rule);
    this._q('#tp-rule-bot').value = selectedChannel;
    this._renderRuleTargetOptions(selectedChannel, rule.target_chat_id || '');
    this._q('#tp-rule-note').value = rule.note || '';
    this._q('#tp-rule-enabled').checked = rule.enabled ?? true;
    this._q('#tp-rule-repeat').checked = rule.notify_repeat ?? true;
    this._q('#tp-rule-create').textContent = '保存修改';
    this._q('#tp-rule-cancel').style.display = 'inline-block';
  }

  _resetRuleForm() {
    this._editingRuleId = null;
    this._q('#tp-rule-name').value = '';
    this._q('#tp-rule-type').value = 'cpu';
    this._q('#tp-rule-threshold').value = 90;
    this._q('#tp-rule-cooldown').value = 300;
    this._q('#tp-rule-server-id').value = '';
    this._q('#tp-rule-bot').value = '';
    this._renderRuleTargetOptions();
    this._q('#tp-rule-note').value = '';
    this._q('#tp-rule-enabled').checked = true;
    this._q('#tp-rule-repeat').checked = true;
    this._q('#tp-rule-create').textContent = '新增规则';
    this._q('#tp-rule-cancel').style.display = 'none';
  }

  _selectedRuleBotId() {
    const v = this._q('#tp-rule-bot')?.value || '';
    return v && !v.startsWith('notify:') ? v : null;
  }

  _selectionFromRule(rule = {}) {
    if (rule.target_chat_id && String(rule.target_chat_id).startsWith('notify:')) {
      const parts = String(rule.target_chat_id).split(':');
      return parts.length >= 2 ? `notify:${parts[1]}` : '';
    }
    return rule.bot_id ? String(rule.bot_id) : '';
  }

  _renderRuleTargetOptions(channelValue = null, selected = null) {
    const el = this._q('#tp-rule-chat');
    if (!el) return;
    const v = channelValue ?? this._q('#tp-rule-bot')?.value ?? '';
    const targets = this._targetsForRuleChannel(v);
    el.innerHTML = targets.map(t => `<option value="${this._escapeHtml(t.value)}">${this._escapeHtml(t.label)}</option>`).join('');
    const wanted = selected || targets[0]?.value || '';
    el.value = targets.some(t => t.value === wanted) ? wanted : (targets[0]?.value || '');
  }

  _targetsForRuleChannel(value = '') {
    const fallback = [{ value: '', label: '渠道默认目标' }];
    if (!value) return fallback;
    if (!String(value).startsWith('notify:')) {
      const bot = (this._bots || []).find(b => String(b.id) === String(value)) || {};
      return [{ value: '', label: '默认目标' }].concat(bot.chat_id ? [{ value: bot.chat_id, label: `${bot.name || 'Telegram'} · ${bot.chat_id}` }] : []);
    }
    const name = String(value).slice('notify:'.length);
    const cfg = ((this._notifySettings || {}).channels || {})[name] || {};
    if (name === 'telegram') {
      const rows = [];
      if (cfg.chat_id) rows.push({ value: cfg.chat_id, label: `Telegram · ${cfg.chat_id}` });
      (this._bots || []).forEach(b => { if (b.chat_id) rows.push({ value: b.chat_id, label: `${b.name || 'Telegram 机器人'} · ${b.chat_id}` }); });
      return rows.length ? rows : fallback;
    }
    if (name === 'email') {
      const rows = (cfg.to || '').replace(/\n/g, ';').split(';').flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean).map(v => ({ value: `notify:email:${v}`, label: `Email · ${v}` }));
      return rows.length ? rows : fallback;
    }
    if (name === 'webhook') { const target = cfg.url || cfg.webhook_url || cfg.endpoint || ''; return target ? [{ value: `notify:webhook:${target}`, label: `webhook · ${target}` }] : [{ value: 'notify:webhook:default', label: 'webhook 默认目标' }]; }
    if (name === 'bark') return cfg.device_key ? [{ value: `notify:bark:${cfg.device_key}`, label: `bark · ${cfg.device_key}` }] : [{ value: 'notify:bark:default', label: 'bark 默认目标' }];
    if (name === 'Javascript') return [{ value: 'notify:Javascript:code', label: cfg.code ? 'Javascript · 已配置脚本' : 'Javascript 默认目标' }];
    if (name === 'Server酱Turbo' || name === 'Server酱³' || name === 'Server酱') {
      const target = cfg.api_url || cfg.target || '';
      return target ? [{ value: `notify:${name}:${target}`, label: `${this._channelLabel(name)} · ${target}` }] : [{ value: `notify:${name}:default`, label: `${this._channelLabel(name)} 默认目标` }];
    }
    return [{ value: `notify:${name}:default`, label: `${this._channelLabel(name)} 默认目标` }];
  }

  _ruleChannelDisplay(rule = {}) {
    if (rule.target_chat_id && String(rule.target_chat_id).startsWith('notify:')) return this._channelLabel(String(rule.target_chat_id).split(':')[1] || '通知渠道');
    return (this._bots || []).find(b => String(b.id) === String(rule.bot_id))?.name || '默认渠道';
  }

  _ruleTargetDisplay(rule = {}) {
    if (!rule.target_chat_id) return '渠道默认目标';
    if (String(rule.target_chat_id).startsWith('notify:')) {
      const parts = String(rule.target_chat_id).split(':');
      return parts.slice(2).join(':') || this._channelLabel(parts[1] || '通知渠道');
    }
    return rule.target_chat_id;
  }

  // ── 手动推送 ─────────────────────────────────────────────────────────────

  async _manualSend() {
    const text = this._q('#tp-manual').value.trim();
    if (!text) { this._msg('tp-msg', '消息不能为空', 'red'); return; }
    try {
      await sendTgMessage(text, this._activeBotId);
      this._q('#tp-manual').value = '';
      this._msg('tp-msg', '✅ 已推送', 'green');
    } catch (e) { this._msg('tp-msg', e.message, 'red'); }
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────

  _q(sel) { return this._el.querySelector(sel); }

  _validateConfig(options = {}) {
    const token = this._q('#tp-token').value.trim();
    const chatId = this._q('#tp-chat').value.trim();
    const tokenPattern = /^\d{6,12}:[A-Za-z0-9_-]{20,80}$/;
    const chatPattern = /^(-\d{5,20}|@[A-Za-z0-9_]{5,32})$/;

    const effectiveToken = token || (options.allowStoredToken && this._hasStoredToken ? '__stored__' : '');
    if (!effectiveToken) return { ok: false, message: 'BotToken 为必填项' };
    if (!chatId) return { ok: false, message: 'ChannelID/ChatID 为必填项' };
    if (token && token.length > 128) return { ok: false, message: 'BotToken 长度不能超过 128' };
    if (chatId.length > 64) return { ok: false, message: 'ChannelID/ChatID 长度不能超过 64' };
    if (token && !tokenPattern.test(token)) return { ok: false, message: 'BotToken 格式不正确（示例：123456789:AA...）' };
    if (!chatPattern.test(chatId)) return { ok: false, message: 'ChannelID/ChatID 格式不正确（示例：-100123456789 或 @channel）' };

    return { ok: true, token, chatId };
  }

  _msg(elId, text, type) {
    const el = this._el.querySelector(`#${elId}`) || this._el.querySelector('#tp-alert-msg');
    if (!el) return;
    const colors = { green: 'var(--green)', red: 'var(--red)', blue: 'var(--accent)' };
    el.style.color = colors[type] || 'var(--text2)';
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3500);
  }
}
