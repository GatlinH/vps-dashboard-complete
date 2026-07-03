import { fetchServers } from '../../api/servers.js';
import { getKomariPanelUrl } from '../../config/externalLinks.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[ch]));
}


export class OverviewPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._renderShell();
  }

  async load() {
    const rows = await fetchServers();
    const total = rows.length;
    const online = rows.filter(s => s.status === 'online').length;
    const warn = rows.filter(s => s.status === 'warn').length;
    const offline = rows.filter(s => s.status !== 'online' && s.status !== 'warn').length;
    this._el.querySelector('#ov-metrics').innerHTML = [
      ['接入节点', total, '资产库中的全部 VPS', 'all'],
      ['在线节点', online, '来自 Agent / Ping 的在线状态', 'online'],
      ['预警节点', warn, '高负载或异常波动', 'warn'],
      ['离线节点', offline, '不可达或探测失败', 'offline'],
    ].map(([k,v,d,tone]) => `<div class="metric-tile admin-overview-metric is-${tone}"><div class="metric-k">${k}</div><div class="metric-v">${v}</div><div class="metric-d">${d}</div></div>`).join('');
    this._el.querySelector('#ov-list').innerHTML = rows.slice(0,8).map(s => `<div class="ping-server-item"><span style="font-size:16px">${escapeHtml(s.flag || '🌐')}</span><div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text);font-weight:600">${escapeHtml(s.name)}</div><div style="font-size:11px;color:var(--text3);font-family:var(--mono)">${escapeHtml(s.ip)} · ${escapeHtml(s.location || '未知位置')}</div></div><span class="ping-badge-ms" style="background:${s.status==='online'?'rgba(56,239,125,.1)':s.status==='warn'?'rgba(255,159,67,.12)':'rgba(255,107,107,.12)'};color:${s.status==='online'?'var(--green)':s.status==='warn'?'var(--orange)':'var(--red)'}">${s.status==='online'?'在线':s.status==='warn'?'预警':'离线'}</span></div>`).join('');
  }

  _renderShell() {
    this._el.innerHTML = `
      <div class="admin-overview-hero">
        <div>
          <span class="admin-overview-kicker">MISSION CONTROL</span>
          <h2>监控总览</h2>
          <p>统一查看资产状态、Agent 采集、TCP Ping 与告警出口，后台与前台星图保持同一套运行数据。</p>
        </div>
        <a class="admin-overview-live" href="/" target="_blank" rel="noreferrer">打开前台星图 ↗</a>
      </div>
      <div class="admin-card admin-overview-card">
        <div class="admin-card-title">🧭 监控信息架构</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          <div class="metric-tile"><div class="metric-k">Komari</div><div class="metric-v"><a href="${getKomariPanelUrl()}" target="_blank" rel="noreferrer">探针面板</a></div><div class="metric-d">负责节点监控与传统探针视角</div></div>
          <div class="metric-tile"><div class="metric-k">Agent</div><div class="metric-v">只读采集</div><div class="metric-d">负责硬件信息、配置同步、状态上报，不执行远程命令</div></div>
          <div class="metric-tile"><div class="metric-k">TCP Ping</div><div class="metric-v">连通性补充</div><div class="metric-d">对外探测网络质量与可达性</div></div>
          <div class="metric-tile"><div class="metric-k">Telegram</div><div class="metric-v">告警出口</div><div class="metric-d">负责只读查询、测试消息与告警通知</div></div>
        </div>
      </div>
      <div class="admin-card">
        <div class="admin-card-title">📊 节点状态看板</div>
        <div id="ov-metrics" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px"></div>
      </div>
      <div class="admin-card">
        <div class="admin-card-title">🌐 最近节点</div>
        <div id="ov-list" class="admin-overview-node-grid"></div>
      </div>`;
  }
}
