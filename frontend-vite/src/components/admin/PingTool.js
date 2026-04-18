/**
 * components/admin/PingTool.js
 * TCP Ping & IP 查询工具面板
 */

export class PingTool {
  /**
   * @param {string} mountId  挂载容器 ID
   */
  constructor(mountId) {
    this._el      = document.getElementById(mountId);
    this._servers = [];
    this._targets = new Set(); // 选中的 IP
    this._render();
    this._bind();
  }

  // ── 公开 ─────────────────────────────────────────────────────────────────

  /** 注入服务器列表（由父级 AdminApp 传入） */
  setServers(servers) {
    this._servers = servers;
    this._renderServerGrid();
  }

  // ── 骨架渲染 ─────────────────────────────────────────────────────────────

  _render() {
    this._el.innerHTML = /* html */`
      <div class="admin-section-title">TCP Ping &amp; IPv4 探测</div>

      <div class="admin-card">
        <div class="admin-card-title">🎯 选择探测目标</div>
        <div class="ping-server-grid" id="pt-server-grid"></div>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <label class="form-label">自定义 Host / IP</label>
            <input class="form-input" id="pt-custom" placeholder="8.8.8.8 或 example.com">
          </div>
          <div style="width:100px">
            <label class="form-label">端口</label>
            <input class="form-input" id="pt-port" value="80" placeholder="80">
          </div>
          <div style="width:80px">
            <label class="form-label">次数</label>
            <input class="form-input" id="pt-count" value="5" type="number" min="1" max="20">
          </div>
          <button class="add-btn" id="pt-run">▶ 开始探测</button>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title" style="justify-content:space-between">
          <span>📊 探测结果</span>
          <button id="pt-clear" style="font-size:11px;color:var(--text3);background:none;border:none;cursor:pointer">清空</button>
        </div>
        <div id="pt-results">
          <div style="color:var(--text3);font-size:13px;text-align:center;padding:2rem 0">选择目标后点击开始探测</div>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">🔍 IP 地址信息查询</div>
        <div style="display:flex;gap:10px;margin-bottom:12px">
          <input class="form-input" id="pt-ip-input" placeholder="输入 IP 地址，留空则查询本机" style="flex:1">
          <button class="add-btn" id="pt-ip-lookup">查询</button>
        </div>
        <div id="pt-ip-result" style="font-size:13px;color:var(--text3);text-align:center;padding:1rem 0">等待查询...</div>
      </div>`;
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────

  _bind() {
    this._el.querySelector('#pt-run').addEventListener('click',      () => this._runPing());
    this._el.querySelector('#pt-clear').addEventListener('click',    () => this._clearResults());
    this._el.querySelector('#pt-ip-lookup').addEventListener('click',() => this._lookupIP());
  }

  // ── 服务器网格 ────────────────────────────────────────────────────────────

  _renderServerGrid() {
    const grid = this._el.querySelector('#pt-server-grid');
    grid.innerHTML = this._servers.map(s => /* html */`
      <div class="ping-server-item" data-ping-ip="${s.ip}" data-ping-id="${s.id}">
        <span style="font-size:16px">${s.flag}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--text);font-weight:600">${s.name}</div>
          <div style="font-size:11px;color:var(--text3);font-family:var(--mono)">${s.ip}</div>
        </div>
        <span id="pt-badge-${s.id}" class="ping-badge-ms" style="background:var(--bg);color:var(--text3)">—</span>
      </div>`).join('');

    grid.addEventListener('click', e => {
      const item = e.target.closest('[data-ping-ip]');
      if (!item) return;
      const ip = item.dataset.pingIp;
      if (this._targets.has(ip)) { this._targets.delete(ip); item.classList.remove('selected'); }
      else                       { this._targets.add(ip);    item.classList.add('selected'); }
    });
  }

  // ── Ping 逻辑 ─────────────────────────────────────────────────────────────

  async _runPing() {
    const custom = this._el.querySelector('#pt-custom').value.trim();
    const port   = parseInt(this._el.querySelector('#pt-port').value) || 80;
    const count  = Math.min(20, parseInt(this._el.querySelector('#pt-count').value) || 5);
    const targets = [...this._targets];
    if (custom) targets.push(custom);
    if (!targets.length) { this._appendLine('请先选择服务器或输入自定义 Host', 'warn'); return; }

    const btn = this._el.querySelector('#pt-run');
    btn.textContent = '⏳ 探测中...'; btn.disabled = true;
    this._clearResults();

    for (const host of targets) {
      this._appendLine(`──── 开始探测 ${host}:${port} ────`, 'info');
      const rtts = [];

      for (let i = 0; i < count; i++) {
        const t0 = performance.now();
        try {
          await fetch(`https://${host}`, {
            mode: 'no-cors', cache: 'no-store',
            signal: AbortSignal.timeout(3000),
          });
          const rtt = Math.round(performance.now() - t0);
          rtts.push(rtt);
          this._appendLine(`  ${i+1}/${count}  ${host}  rtt=${rtt}ms  port=${port}`, rtt < 100 ? 'ok' : rtt < 300 ? 'warn' : 'fail');
        } catch (_) {
          const rtt = Math.round(performance.now() - t0);
          if (rtt < 3000) {
            rtts.push(rtt);
            this._appendLine(`  ${i+1}/${count}  ${host}  rtt≈${rtt}ms  (opaque)`, rtt < 150 ? 'ok' : 'warn');
          } else {
            this._appendLine(`  ${i+1}/${count}  ${host}  超时/无法访问`, 'fail');
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }

      if (rtts.length) {
        const avg  = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
        const loss = Math.round((count - rtts.length) / count * 100);
        this._appendLine(`  统计: avg=${avg}ms  min=${Math.min(...rtts)}ms  max=${Math.max(...rtts)}ms  丢包${loss}%`,
          avg < 100 ? 'ok' : 'warn');
        // 更新服务器卡片上的 badge
        const sid = this._servers.find(s => s.ip === host);
        if (sid) {
          const badge = document.getElementById(`pt-badge-${sid.id}`);
          if (badge) {
            badge.textContent = avg + 'ms';
            badge.style.color      = avg < 100 ? 'var(--green)' : avg < 300 ? 'var(--orange)' : 'var(--red)';
            badge.style.background = avg < 100 ? 'rgba(56,239,125,.1)' : avg < 300 ? 'rgba(255,159,67,.1)' : 'rgba(255,107,107,.1)';
          }
        }
      } else {
        this._appendLine(`  ${host} 全部超时，无法探测`, 'fail');
      }
      this._appendLine('', 'info');
    }

    btn.textContent = '▶ 开始探测'; btn.disabled = false;
  }

  _appendLine(text, type = 'info') {
    const container = this._el.querySelector('#pt-results');
    let out = container.querySelector('.ping-result');
    if (!out) {
      out = document.createElement('div');
      out.className = 'ping-result';
      container.innerHTML = '';
      container.appendChild(out);
    }
    const line = document.createElement('div');
    line.className = `ping-line ping-${type}`;
    line.textContent = text || '\u00A0';
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }

  _clearResults() {
    this._el.querySelector('#pt-results').innerHTML =
      '<div style="color:var(--text3);font-size:13px;text-align:center;padding:2rem 0">选择目标后点击开始探测</div>';
  }

  // ── IP 查询 ───────────────────────────────────────────────────────────────

  async _lookupIP() {
    const ip  = this._el.querySelector('#pt-ip-input').value.trim();
    const out = this._el.querySelector('#pt-ip-result');
    out.innerHTML = '<div style="color:var(--accent)">查询中...</div>';
    try {
      const url = ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/';
      const d   = await fetch(url).then(r => r.json());
      const rows = [
        ['IP', d.ip], ['城市', d.city], ['地区', d.region], ['国家', d.country_name],
        ['ISP/ASN', d.org], ['经纬度', `${d.latitude}, ${d.longitude}`], ['时区', d.timezone],
      ];
      out.innerHTML = /* html */`
        <table style="width:100%;border-collapse:collapse;font-size:13px;text-align:left">
          ${rows.map(([k, v]) => /* html */`
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 8px;color:var(--text3);width:35%">${k}</td>
              <td style="padding:5px 8px;color:var(--text);font-family:var(--mono)">${v || '—'}</td>
            </tr>`).join('')}
        </table>`;
    } catch (e) {
      out.innerHTML = `<div style="color:var(--red)">查询失败: ${e.message}</div>`;
    }
  }
}
