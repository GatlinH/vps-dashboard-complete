import {
  fetchServers,
  generateAgentKey,
  rotateAgentKey,
  getAgentOverview,
  updateAgentConfig,
  enqueueAgentCommand,
} from '../../api/servers.js';

export class AgentPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._servers = [];
    this._selectedId = null;
    this._render();
    this._bind();
  }

  async load() {
    this._servers = await fetchServers();
    this._renderServerOptions();
    if (!this._selectedId && this._servers.length) {
      this._selectedId = this._servers[0].id;
      this._el.querySelector('#ap-server').value = String(this._selectedId);
    }
    if (this._selectedId) await this._loadOverview();
  }

  _render() {
    this._el.innerHTML = /* html */`
      <div class="admin-card">
        <div class="admin-card-title">🤖 Agent 管理</div>
        <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:end">
          <div class="form-group" style="margin:0">
            <label class="form-label">服务器</label>
            <select id="ap-server" class="form-input"></select>
          </div>
          <button id="ap-refresh" class="add-btn">刷新概览</button>
          <div id="ap-status" style="font-size:12px;color:var(--text3);min-width:180px"></div>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">🔐 密钥与绑定状态</div>
        <div id="ap-overview" style="font-size:13px;line-height:1.8;color:var(--text2)">请选择服务器</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
          <button id="ap-gen" class="add-btn">生成新密钥</button>
          <button id="ap-rotate" style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px">轮换密钥</button>
        </div>
        <div id="ap-key" style="margin-top:10px;font-size:12px;color:var(--gold);word-break:break-all"></div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">⚙ Agent 配置 JSON</div>
        <textarea id="ap-config" class="form-input" style="min-height:180px;font-family:var(--mono);resize:vertical"></textarea>
        <div style="margin-top:10px">
          <button id="ap-save" class="add-btn">保存配置</button>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">📨 下发命令</div>
        <div style="display:grid;grid-template-columns:1fr 160px;gap:10px">
          <div class="form-group" style="margin:0">
            <label class="form-label">命令类型</label>
            <input id="ap-cmd-type" class="form-input" placeholder="如 sync / restart_service">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">TTL(秒)</label>
            <input id="ap-cmd-ttl" class="form-input" type="number" value="300" min="1" max="86400">
          </div>
        </div>
        <div class="form-group" style="margin-top:10px">
          <label class="form-label">payload (JSON 对象)</label>
          <textarea id="ap-cmd-payload" class="form-input" style="min-height:120px;font-family:var(--mono);resize:vertical">{}</textarea>
        </div>
        <button id="ap-send-cmd" class="add-btn">发送命令</button>
      </div>`;
  }

  _bind() {
    this._el.querySelector('#ap-server').addEventListener('change', async (e) => {
      this._selectedId = Number(e.target.value) || null;
      await this._loadOverview();
    });
    this._el.querySelector('#ap-refresh').addEventListener('click', () => this._loadOverview());
    this._el.querySelector('#ap-gen').addEventListener('click', () => this._createKey(false));
    this._el.querySelector('#ap-rotate').addEventListener('click', () => this._createKey(true));
    this._el.querySelector('#ap-save').addEventListener('click', () => this._saveConfig());
    this._el.querySelector('#ap-send-cmd').addEventListener('click', () => this._sendCommand());
  }

  _renderServerOptions() {
    const sel = this._el.querySelector('#ap-server');
    sel.innerHTML = this._servers.map(s => `<option value="${s.id}">${s.flag || '🌐'} ${s.name}</option>`).join('');
  }

  async _loadOverview() {
    if (!this._selectedId) return;
    try {
      const data = await getAgentOverview(this._selectedId);
      this._el.querySelector('#ap-overview').innerHTML = [
        `UUID: <b>${data.uuid || '未绑定'}</b>`,
        `密钥创建时间: ${data.agent_key_created_at || '—'}`,
        `最近使用时间: ${data.agent_key_last_used || '—'}`,
        `旧密钥重叠到期: ${data.agent_key_prev_expires_at || '—'}`,
        `待执行命令: <b>${data.pending_commands}</b>`,
      ].join('<br>');
      this._el.querySelector('#ap-config').value = JSON.stringify(data.agent_config || {}, null, 2);
      this._msg('已加载 Agent 概览', 'blue');
    } catch (e) {
      this._msg(e.message, 'red');
    }
  }

  async _createKey(rotate) {
    if (!this._selectedId) return;
    try {
      const data = rotate ? await rotateAgentKey(this._selectedId) : await generateAgentKey(this._selectedId);
      this._el.querySelector('#ap-key').textContent = `请立即复制并保存密钥: ${data.agent_key}`;
      await this._loadOverview();
      this._msg(rotate ? '密钥已轮换' : '密钥已生成', 'green');
    } catch (e) {
      this._msg(e.message, 'red');
    }
  }

  async _saveConfig() {
    if (!this._selectedId) return;
    try {
      const text = this._el.querySelector('#ap-config').value.trim() || '{}';
      const cfg = JSON.parse(text);
      await updateAgentConfig(this._selectedId, cfg);
      this._msg('Agent 配置已保存', 'green');
      await this._loadOverview();
    } catch (e) {
      this._msg(`配置保存失败: ${e.message}`, 'red');
    }
  }

  async _sendCommand() {
    if (!this._selectedId) return;
    const type = this._el.querySelector('#ap-cmd-type').value.trim();
    if (!type) return this._msg('请填写命令类型', 'red');
    try {
      const ttl = Number(this._el.querySelector('#ap-cmd-ttl').value || 300);
      const payload = JSON.parse(this._el.querySelector('#ap-cmd-payload').value || '{}');
      await enqueueAgentCommand(this._selectedId, { command_type: type, payload, ttl_seconds: ttl });
      this._msg(`命令已下发: ${type}`, 'green');
      await this._loadOverview();
    } catch (e) {
      this._msg(`下发失败: ${e.message}`, 'red');
    }
  }

  _msg(text, type) {
    const el = this._el.querySelector('#ap-status');
    const colors = { green: 'var(--green)', red: 'var(--red)', blue: 'var(--accent)' };
    el.style.color = colors[type] || 'var(--text3)';
    el.textContent = text;
  }
}
