/**
 * components/admin/ServerManager.js
 * 管理后台「服务器管理」面板
 *   - 从 API 加载服务器列表
 *   - 快速导入（点击卡片填充表单）
 *   - 手动添加 / 删除（调用 API）
 */
import { fetchServers, createServer, deleteServer } from '../../api/servers.js';

export class ServerManager {
  /**
   * @param {string} mountId  挂载到的容器 ID（admin-page 区域）
   */
  constructor(mountId) {
    this._el      = document.getElementById(mountId);
    this._servers = [];
    this._render();
    this._bind();
    this._busy = false;
  }

  // ── 公开 ─────────────────────────────────────────────────────────────────

  /** 加载 / 刷新服务器列表 */
  async reload() {
    try {
      this._servers = await fetchServers();
      this._renderMonitorList();
      this._renderExistingTable();
    } catch (e) {
      this._msg(e.message, 'red');
    }
  }

  /** 返回当前服务器列表（供其他面板使用，如 Ping） */
  get servers() { return this._servers; }

  // ── 骨架渲染 ─────────────────────────────────────────────────────────────

  _render() {
    this._el.innerHTML = /* html */`
      <!-- 快速导入 -->
      <div class="admin-card">
        <div class="admin-card-title">🔗 从监控 VPS 快速导入</div>
        <div id="sm-monitor-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-bottom:14px"></div>
        <div style="font-size:12px;color:var(--text3)">点击卡片选中，填写价格信息后保存</div>
      </div>

      <!-- 手动添加 -->
      <div class="admin-card">
        <div class="admin-card-title">✏️ 手动添加 / 编辑</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label class="form-label">服务器名称 *</label><input class="form-input" id="sm-name" placeholder="my-vps-01"></div>
          <div class="form-group"><label class="form-label">分组</label><input class="form-input" id="sm-group" placeholder="生产环境"></div>
          <div class="form-group"><label class="form-label">旗帜 Emoji</label><input class="form-input" id="sm-flag" placeholder="🇺🇸"></div>
          <div class="form-group"><label class="form-label">IP 地址 <span style="color:var(--green);font-size:10px">自动</span></label><input class="form-input" id="sm-ip" placeholder="1.2.3.4"></div>
          <div class="form-group"><label class="form-label">位置 <span style="color:var(--green);font-size:10px">自动</span></label><input class="form-input" id="sm-location" placeholder="美国洛杉矶"></div>
          <div class="form-group"><label class="form-label">带宽 <span style="color:var(--green);font-size:10px">自动</span></label><input class="form-input" id="sm-bw" placeholder="1Gbps不限"></div>
          <div class="form-group"><label class="form-label">CPU (核) <span style="color:var(--green);font-size:10px">自动</span></label><input class="form-input" id="sm-cpu" type="number" placeholder="4"></div>
          <div class="form-group"><label class="form-label">内存 (GB) <span style="color:var(--green);font-size:10px">自动</span></label><input class="form-input" id="sm-ram" type="number" placeholder="8"></div>
          <div class="form-group"><label class="form-label">存储 (GB) <span style="color:var(--green);font-size:10px">自动</span></label><input class="form-input" id="sm-disk" type="number" placeholder="100"></div>
          <div class="form-group"><label class="form-label">价格 (元) *</label><input class="form-input" id="sm-price" type="number" placeholder="99"></div>
          <div class="form-group"><label class="form-label">付费周期</label>
            <select class="form-input" id="sm-period">
              <option value="monthly">月付</option>
              <option value="yearly">年付</option>
              <option value="quarterly">季付</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">到期日期</label><input class="form-input" id="sm-expiry" type="date"></div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">探针 URL</label><input class="form-input" id="sm-probe" placeholder="https://..."></div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">备注</label><input class="form-input" id="sm-note" placeholder="这台机子用于..."></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:1rem">
          <button class="add-btn" id="sm-submit">确认添加</button>
          <button id="sm-clear" style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px">清空</button>
        </div>
        <div id="sm-msg" style="margin-top:8px;font-size:12px;min-height:18px"></div>
      </div>

      <!-- 已有服务器 -->
      <div class="admin-card">
        <div class="admin-card-title">📋 已有服务器</div>
        <div id="sm-existing"></div>
      </div>`;
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────

  _bind() {
    this._el.querySelector('#sm-submit').addEventListener('click', () => this._submit());
    this._el.querySelector('#sm-clear').addEventListener('click',  () => this._clearForm());

    // 已有列表委托删除
    this._el.querySelector('#sm-existing').addEventListener('click', e => {
      const btn = e.target.closest('[data-delete-id]');
      if (btn) this._delete(btn.dataset.deleteId);
    });
  }

  // ── 监控列表（快速导入） ──────────────────────────────────────────────────

  _renderMonitorList() {
    const el = this._el.querySelector('#sm-monitor-list');
    el.innerHTML = this._servers.map(s => /* html */`
      <div class="ping-server-item" data-fill-id="${s.id}" style="cursor:pointer">
        <span style="font-size:18px">${s.flag}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text);font-weight:600">${s.name}</div>
          <div style="font-size:11px;color:var(--text3);font-family:var(--mono)">${s.ip} · ${s.location}</div>
        </div>
        <div style="font-size:10px;padding:2px 8px;border-radius:6px;
          background:${s.status==='online'?'rgba(56,239,125,.12)':s.status==='warn'?'rgba(255,159,67,.12)':'rgba(255,107,107,.12)'};
          color:${s.status==='online'?'var(--green)':s.status==='warn'?'var(--orange)':'var(--red)'}">
          ${s.status==='online'?'在线':s.status==='warn'?'预警':'离线'}
        </div>
      </div>`).join('');

    // 事件委托
    el.addEventListener('click', e => {
      const card = e.target.closest('[data-fill-id]');
      if (card) this._fillFromServer(Number(card.dataset.fillId));
    });
  }

  _fillFromServer(id) {
    const s = this._servers.find(x => x.id === id);
    if (!s) return;
    const map = { 'sm-name': s.name, 'sm-group': s.group, 'sm-flag': s.flag,
      'sm-ip': s.ip, 'sm-location': s.location, 'sm-bw': s.bw,
      'sm-cpu': s.cpu, 'sm-ram': s.ram, 'sm-disk': s.disk,
      'sm-probe': s.probe || '', 'sm-price': s.price || '',
      'sm-expiry': s.expiry || '', 'sm-note': s.note || '' };
    for (const [id, val] of Object.entries(map)) {
      const el = this._el.querySelector(`#${id}`);
      if (el) el.value = val;
    }
    if (s.period) this._el.querySelector('#sm-period').value = s.period;

    // 绿色闪烁提示
    ['sm-ip','sm-location','sm-bw','sm-cpu','sm-ram','sm-disk'].forEach(fid => {
      const el = this._el.querySelector(`#${fid}`);
      if (el) { el.style.borderColor = 'var(--green)'; setTimeout(() => el.style.borderColor = '', 1200); }
    });
    this._el.querySelector('#sm-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── 已有服务器表格 ────────────────────────────────────────────────────────

  _renderExistingTable() {
    const el = this._el.querySelector('#sm-existing');
    if (!this._servers.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px;text-align:center;padding:1.5rem">暂无服务器</div>'; return; }
    el.innerHTML = /* html */`
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          ${['名称','位置','规格','状态','操作'].map(h =>
            `<td style="padding:6px 8px;color:var(--text3)">${h}</td>`).join('')}
        </tr></thead>
        <tbody>
          ${this._servers.map(s => /* html */`
            <tr style="border-bottom:1px solid rgba(255,255,255,.04)">
              <td style="padding:6px 8px;color:var(--text)">${s.flag} ${s.name}</td>
              <td style="padding:6px 8px;color:var(--text2);font-size:12px">${s.location}</td>
              <td style="padding:6px 8px;color:var(--text3);font-family:var(--mono);font-size:11px">${s.cpu}C/${s.ram}G/${s.disk}G</td>
              <td style="padding:6px 8px">
                <span style="font-size:11px;padding:2px 8px;border-radius:6px;
                  background:${s.status==='online'?'rgba(56,239,125,.12)':'rgba(255,107,107,.12)'};
                  color:${s.status==='online'?'var(--green)':'var(--red)'}">
                  ${s.status==='online'?'在线':'离线/预警'}</span>
              </td>
              <td style="padding:6px 8px">
                <button data-delete-id="${s.id}"
                  style="font-size:11px;padding:3px 10px;border-radius:6px;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.2);color:var(--red);cursor:pointer">
                  删除
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── 添加 ─────────────────────────────────────────────────────────────────

  async _submit() {
    if (this._busy) return;
    const v = id => this._el.querySelector(`#${id}`)?.value?.trim();
    if (!v('sm-name')) { this._msg('请填写服务器名称', 'red'); return; }
    if (!v('sm-ip'))   { this._msg('请填写 IP 地址',   'red'); return; }

    try {
      this._busy = true;
      this._toggleSubmit(true);
      const created = await createServer({
        name: v('sm-name'), ip: v('sm-ip'), group: v('sm-group'), flag: v('sm-flag'),
        location: v('sm-location'), bw: v('sm-bw'),
        cpu: v('sm-cpu'), ram: v('sm-ram'), disk: v('sm-disk'),
        price: v('sm-price'), period: this._el.querySelector('#sm-period')?.value,
        expiry: v('sm-expiry'), probe: v('sm-probe'), note: v('sm-note'),
      });
      this._msg(`✅ 已添加 "${v('sm-name')}"`, 'green');
      this._servers.unshift(created);
      this._renderExistingTable();
      this._renderMonitorList();
      this._clearForm();
    } catch (e) {
      this._msg(e.message, 'red');
    } finally {
      this._busy = false;
      this._toggleSubmit(false);
    }
  }

  // ── 删除 ─────────────────────────────────────────────────────────────────

  async _delete(id) {
    if (this._busy) return;
    if (!confirm('确认删除该服务器？')) return;
    try {
      this._busy = true;
      await deleteServer(id);
      this._servers = this._servers.filter(s => String(s.id) !== String(id));
      this._renderExistingTable();
      this._renderMonitorList();
      this._msg('🗑️ 删除成功，列表已更新', 'blue');
    } catch (e) {
      this._msg(e.message, 'red');
    } finally {
      this._busy = false;
    }
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────

  _clearForm() {
    ['sm-name','sm-group','sm-flag','sm-ip','sm-location','sm-bw',
     'sm-cpu','sm-ram','sm-disk','sm-price','sm-probe','sm-note','sm-expiry']
      .forEach(id => { const el = this._el.querySelector(`#${id}`); if (el) el.value = ''; });
  }

  _msg(text, type) {
    const el = this._el.querySelector('#sm-msg');
    if (!el) return;
    const colors = { green: 'var(--green)', red: 'var(--red)', blue: 'var(--accent)' };
    el.style.color = colors[type] || 'var(--text2)';
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3500);
  }

  _toggleSubmit(disabled) {
    const btn = this._el.querySelector('#sm-submit');
    if (!btn) return;
    btn.disabled = disabled;
    btn.textContent = disabled ? '提交中...' : '确认添加';
    btn.style.opacity = disabled ? '0.7' : '1';
  }
}
