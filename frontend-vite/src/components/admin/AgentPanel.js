import {
  fetchServers,
  generateAgentKey,
  rotateAgentKey,
  getAgentOverview,
  updateAgentConfig,
  fetchAgentInstallCommand,
} from '../../api/servers.js';
import { getKomariPanelUrl } from '../../config/externalLinks.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[ch]));
}

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
        <div class="admin-card-title">🛰 Komari / Agent 接入总览</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:12px">
          <div class="metric-tile"><div class="metric-k">监控源</div><div class="metric-v">Agent + Komari</div><div class="metric-d">本项目负责星图、告警、资产管理</div></div>
          <div class="metric-tile"><div class="metric-k">192 Komari</div><div class="metric-v"><a href="${getKomariPanelUrl()}" target="_blank" rel="noreferrer">打开面板</a></div><div class="metric-d">端口 25774，适合做探针与节点监控</div></div>
          <div class="metric-tile"><div class="metric-k">控制面</div><div class="metric-v">只读监控</div><div class="metric-d">不接受远程执行、在线终端、文件任务</div></div>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">🔐 密钥与绑定状态</div>
        <div id="ap-overview" style="font-size:13px;line-height:1.8;color:var(--text2)">请选择服务器</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
          <button type="button" id="ap-gen" class="add-btn">生成新密钥</button>
          <button type="button" id="ap-rotate" style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px">轮换密钥</button>
          <button type="button" id="ap-install" style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px">生成安装命令</button>
          <button type="button" id="ap-copy-install" style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px">复制安装命令</button>
        </div>
        <div id="ap-key" style="margin-top:10px;font-size:12px;color:var(--gold);word-break:break-all"></div><textarea id="ap-install-cmd" readonly class="form-input" style="min-height:92px;margin-top:10px;font-family:var(--mono);resize:vertical" placeholder="生成 Agent Key 后，这里会出现安装命令"></textarea>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">⚙ Agent 配置 JSON</div>
        <textarea id="ap-config" class="form-input" style="min-height:180px;font-family:var(--mono);resize:vertical"></textarea>
        <div style="margin-top:10px">
          <button id="ap-save" class="add-btn">保存配置</button>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">🔒 只读监控模式</div>
        <div style="font-size:13px;line-height:1.9;color:var(--text2)">
          当前监控服务已切换为 <b>只读监控模式</b>。<br>
          为避免监控面板/TG 机器人被爆破后反向操控 VPS，<br>
          <b>远程命令下发能力已默认禁用</b>。<br>
          该服务现在只允许：状态采集、告警推送、只读查询。
        </div>
        <button id="ap-send-cmd" class="add-btn" disabled style="opacity:.45;cursor:not-allowed;margin-top:10px">远程命令已禁用</button>
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
    this._el.querySelector('#ap-install').addEventListener('click', () => this._buildInstallCommand());
    this._el.querySelector('#ap-copy-install').addEventListener('click', () => this._copyInstallCommand());
  }

  _renderServerOptions() {
    const sel = this._el.querySelector('#ap-server');
    sel.innerHTML = this._servers.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.flag || '🌐')} ${escapeHtml(s.name)}</option>`).join('');
  }

  async _loadOverview() {
    if (!this._selectedId) return;
    try {
      const data = await getAgentOverview(this._selectedId);
      const komariUrl = getKomariPanelUrl();
      this._el.querySelector('#ap-overview').innerHTML = [
        `UUID: <b>${escapeHtml(data.uuid || '未绑定')}</b>`,
        `密钥创建时间: ${escapeHtml(data.agent_key_created_at || '—')}`,
        `最近使用时间: ${escapeHtml(data.agent_key_last_used || '—')}`,
        `旧密钥重叠到期: ${escapeHtml(data.agent_key_prev_expires_at || '—')}`,
        `模式: <b>只读监控</b>`,
        `能力: <b>exec=禁用 / terminal=禁用 / file_list=禁用</b>`,
        `Komari 面板: <a href="${komariUrl}" target="_blank" rel="noreferrer">${komariUrl}</a>`,
      ].join('<br>');
      const cfg = data.readonly_policy || data.agent_config || {};
      this._el.querySelector('#ap-config').value = JSON.stringify(cfg, null, 2);
      this._msg('已加载 Agent 概览（只读模式）', 'blue');
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


  async _buildInstallCommand() {
    if (!this._selectedId) return;
    try {
      this._msg('正在生成安装命令...', 'blue');
      const keyLine = this._el.querySelector('#ap-key')?.textContent || '';
      let agentKey = keyLine.includes(':') ? keyLine.slice(keyLine.indexOf(':') + 1).trim() : '';
      if (!agentKey) {
        const data = await generateAgentKey(this._selectedId);
        agentKey = data.agent_key || '';
        this._el.querySelector('#ap-key').textContent = `请立即复制并保存密钥: ${agentKey}`;
      }
      const data = await fetchAgentInstallCommand(this._selectedId, agentKey);
      const cmd = data.install_command || data.command || '';
      this._el.querySelector('#ap-install-cmd').value = cmd;
      this._msg(cmd ? '安装命令已生成，可点击复制' : '安装命令为空', cmd ? 'green' : 'red');
    } catch (e) {
      this._msg(`生成安装命令失败: ${e.message}`, 'red');
    }
  }

  async _copyInstallCommand() {
    const text = this._el.querySelector('#ap-install-cmd')?.value || '';
    if (!text.trim()) { this._msg('没有可复制的安装命令', 'red'); return; }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        this._copyWithTextarea(text);
      }
      this._msg('✅ 安装命令已复制', 'green');
    } catch (_) {
      try { this._copyWithTextarea(text); this._msg('✅ 安装命令已复制', 'green'); }
      catch (err) { this._msg('复制失败：请手动选中复制', 'red'); }
    }
  }

  _copyWithTextarea(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('execCommand copy failed');
  }

  _msg(text, type) {
    const el = this._el.querySelector('#ap-status');
    const colors = { green: 'var(--green)', red: 'var(--red)', blue: 'var(--accent)' };
    el.style.color = colors[type] || 'var(--text3)';
    el.textContent = text;
  }
}
