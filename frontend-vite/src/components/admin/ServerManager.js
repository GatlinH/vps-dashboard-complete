/**
 * components/admin/ServerManager.js
 * Komari-like VPS / Agent node manager.
 */
import {
  fetchServers,
  createServer,
  updateServer,
  deleteServer,
  updateAgentConfig,
  generateAgentKey,
  rotateAgentKey,
  getAgentOverview,
  fetchAgentInstallCommand,
} from '../../api/servers.js';
import { createServerGroup, deleteServerGroup, fetchServerGroups, updateServerGroup } from '../../api/serverGroups.js';

export class ServerManager {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._servers = [];
    this._groups = [];
    this._editingGroupId = null;
    this._busy = false;
    this._editingId = null;
    this._selectedIds = new Set();
    this._query = '';
    this._statusFilter = 'all'; // all | online | warn | offline
    this._groupFilter = 'all';
    this._view = 'nodes'; // nodes | groups
    this._serversChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vps-servers') : null;
    this._render();
    this._bind();
  }

  _groupOptions(selectedId) {
    if (!this._groups.length) {
      return '<option value="">请先「管理分组」创建</option>';
    }
    return this._groups.map(group => {
      const purpose = group.purpose ? ` · ${group.purpose}` : '';
      return `<option value="${group.id}" ${String(group.id) === String(selectedId) ? 'selected' : ''}>${this._escape(group.name)}${this._escape(purpose)}</option>`;
    }).join('');
  }
  _updateGroupPurposeHint() {
    const group = this._groups.find(item => String(item.id) === this._val('sm-info-group'));
    const hint = this._el.querySelector('#sm-info-group-purpose');
    if (!hint) return;
    if (!this._groups.length) {
      hint.textContent = '暂无分组：请点「管理分组」添加（名称/用途/颜色）';
      return;
    }
    const bits = [];
    if (group?.purpose) bits.push(group.purpose);
    if (group?.color) bits.push(group.color);
    hint.textContent = bits.join(' · ') || '分组定义来自后台 server_groups';
  }
  _setView(view) {
    this._view = view === 'groups' ? 'groups' : 'nodes';
    this._el.querySelectorAll('[data-sm-view]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.smView === this._view);
    });
    const nodes = this._el.querySelector('#sm-nodes-view');
    const groups = this._el.querySelector('#sm-groups-view');
    if (nodes) nodes.hidden = this._view !== 'nodes';
    if (groups) groups.hidden = this._view !== 'groups';
    if (this._view === 'groups') this._renderGroupsPage();
    else this._renderTable();
  }

  _renderGroupsPage() {
    this._editingGroupId = null;
    const body = this._el.querySelector('#sm-groups-tbody');
    const formTitle = this._el.querySelector('#sm-group-form-title');
    const saveBtn = this._el.querySelector('#sm-group-save');
    if (!body) return;
    if (formTitle) formTitle.textContent = '新建分组';
    if (saveBtn) saveBtn.textContent = '添加分组';
    ['sm-group-name', 'sm-group-purpose', 'sm-group-color'].forEach((id) => {
      const el = this._el.querySelector(`#${id}`);
      if (el) el.value = '';
    });
    const sortEl = this._el.querySelector('#sm-group-sort');
    if (sortEl) sortEl.value = '0';
    body.innerHTML = this._groups.length
      ? this._groups.map((group) => {
          const color = group.color
            ? `<span class="sm-group-color-dot" style="background:${this._attr(group.color)}"></span>${this._escape(group.color)}`
            : '—';
          const members = this._servers.filter((s) => String(s.group_info?.id || s.group_id) === String(group.id)).length;
          return `<tr>
            <td><strong>${this._escape(group.name)}</strong></td>
            <td>${this._escape(group.purpose || '—')}</td>
            <td>${color}</td>
            <td>${Number(group.sort_order || 0)}</td>
            <td>${members}</td>
            <td class="komari-row-actions">
              <button class="sm-row-menu-btn" title="操作" data-menu-trigger data-menu-kind="group" data-id="${group.id}" aria-haspopup="true" aria-expanded="false">⋯</button>
            </td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="6" class="komari-empty">暂无分组，请在上方添加（节点下拉 / 资产总览会同步）</td></tr>';
  }

  async _saveGroup(id = null) {
    const payload = {
      name: this._val('sm-group-name'),
      purpose: this._val('sm-group-purpose'),
      color: this._val('sm-group-color'),
      sort_order: Number(this._val('sm-group-sort') || 0),
    };
    if (!payload.name.trim()) return this._toast('分组名称不能为空', 'red');
    try {
      id ? await updateServerGroup(id, payload) : await createServerGroup(payload);
      this._groups = await fetchServerGroups();
      this._fillGroupFilter();
      this._renderGroupsPage();
      this._renderTable();
      this._toast(id ? '分组已更新' : '分组已创建', 'green');
    } catch (error) {
      this._toast(error.message, 'red');
    }
  }

  _editGroup(id) {
    const group = this._groups.find((item) => String(item.id) === String(id));
    if (!group) return;
    this._setView('groups');
    this._editingGroupId = group.id;
    this._el.querySelector('#sm-group-name').value = group.name;
    this._el.querySelector('#sm-group-purpose').value = group.purpose || '';
    this._el.querySelector('#sm-group-color').value = group.color || '';
    this._el.querySelector('#sm-group-sort').value = group.sort_order || 0;
    const formTitle = this._el.querySelector('#sm-group-form-title');
    const saveBtn = this._el.querySelector('#sm-group-save');
    if (formTitle) formTitle.textContent = `编辑分组 · ${group.name}`;
    if (saveBtn) saveBtn.textContent = '保存分组';
  }

  async _deleteGroup(id) {
    if (!confirm('确认删除该分组？节点会回到默认分组逻辑。')) return;
    try {
      await deleteServerGroup(id);
      this._groups = await fetchServerGroups();
      this._fillGroupFilter();
      this._renderGroupsPage();
      this._renderTable();
      this._toast('分组已删除', 'green');
    } catch (error) {
      this._toast(error.message, 'red');
    }
  }

  _fillGroupFilter() {
    const sel = this._el.querySelector('#sm-filter-group');
    if (!sel) return;
    const current = this._groupFilter || 'all';
    sel.innerHTML = [
      '<option value="all">全部分组</option>',
      ...this._groups.map((g) => `<option value="${this._attr(g.id)}">${this._escape(g.name)}</option>`),
      '<option value="none">未分组</option>',
    ].join('');
    sel.value = [...sel.options].some((o) => o.value === String(current)) ? String(current) : 'all';
    this._groupFilter = sel.value;
  }

  _statusBucket(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'online' || s === 'healthy' || s === 'ok' || s === 'up') return 'online';
    if (s === 'warn' || s === 'warning' || s === 'degraded') return 'warn';
    return 'offline';
  }

  _statusLabel(bucket) {
    return { online: '在线', warn: '波动', offline: '离线' }[bucket] || '离线';
  }

  _formatHeartbeat(server) {
    const raw = server.agent_key_last_used || server.updated_at || '';
    if (!raw) return { text: '无心跳', ageMs: Infinity };
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return { text: String(raw).slice(0, 19), ageMs: Infinity };
    const ageMs = Date.now() - ts;
    const sec = Math.max(0, Math.round(ageMs / 1000));
    let text;
    if (sec < 60) text = `${sec}s 前`;
    else if (sec < 3600) text = `${Math.floor(sec / 60)}m 前`;
    else if (sec < 86400) text = `${Math.floor(sec / 3600)}h 前`;
    else text = `${Math.floor(sec / 86400)}d 前`;
    return { text, ageMs, iso: new Date(ts).toISOString() };
  }

  async reload() {
    try {
      [this._servers, this._groups] = await Promise.all([fetchServers(), fetchServerGroups()]);
      this._fillGroupFilter();
      if (this._view === 'groups') this._renderGroupsPage();
      else this._renderTable();
    } catch (e) { this._toast(e.message, 'red'); }
  }

  get servers() { return this._servers; }

  openEditById(id) { this._openInfoModal(id); }

  _render() {
    this._el.innerHTML = /* html */`
      <div class="komari-node-page">
        <div class="komari-node-toolbar">
          <div class="sm-toolbar-left">
            <h2>节点管理</h2>
            <div class="sm-view-switch" role="tablist" aria-label="节点管理视图">
              <button type="button" class="is-active" data-sm-view="nodes">节点列表</button>
              <button type="button" data-sm-view="groups">分组管理</button>
            </div>
          </div>
          <div class="komari-node-actions">
            <button id="sm-add-node" class="add-btn">＋ 添加节点</button>
          </div>
        </div>

        <div id="sm-nodes-view">
          <div class="sm-filter-bar">
            <input id="sm-search" class="form-input" type="search" placeholder="搜索名称 / IP / 备注 / 地区 / 分组" autocomplete="off">
            <select id="sm-filter-status" class="form-input" aria-label="按状态筛选">
              <option value="all">全部状态</option>
              <option value="online">在线</option>
              <option value="warn">波动</option>
              <option value="offline">离线</option>
            </select>
            <select id="sm-filter-group" class="form-input" aria-label="按分组筛选">
              <option value="all">全部分组</option>
            </select>
            <span id="sm-filter-count" class="sm-filter-count">0 台</span>
          </div>
          <div class="komari-table-wrap">
            <table class="komari-node-table">
              <colgroup>
                <col class="col-drag">
                <col class="col-check">
                <col class="col-name">
                <col class="col-ip">
                <col class="col-version">
                <col class="col-package">
                <col class="col-note">
                <col class="col-billing">
                <col class="col-actions">
              </colgroup>
              <thead>
                <tr>
                  <th></th>
                  <th><input id="sm-check-all" type="checkbox"></th>
                  <th>名称 / 状态</th>
                  <th>IP地址</th>
                  <th>客户端版本</th>
                  <th>分组</th>
                  <th>位置 / 地区</th>
                  <th>账单</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="sm-existing"></tbody>
            </table>
          </div>
        </div>

        <div id="sm-groups-view" hidden>
          <div class="sm-groups-head">
            <button id="sm-groups-back" type="button" class="komari-secondary">← 返回节点列表</button>
          </div>
          <p class="komari-note">分组保存在后台 <code>server_groups</code>。节点编辑下拉、资产总览 Tab/分区都读这里；与地球「同地点聚合」无关。</p>
          <div class="sm-groups-layout">
            <section class="komari-panel sm-group-form-panel">
              <div class="komari-panel-title"><span id="sm-group-form-title">新建分组</span><small>名称 / 用途 / 颜色 / 排序</small></div>
              <div class="komari-form-grid one">
                <label>名称<input class="form-input" id="sm-group-name" placeholder="如 CN2 / 亚洲 / 测试"></label>
                <label>用途<input class="form-input" id="sm-group-purpose" placeholder="用途说明（可选）"></label>
                <label>颜色<input class="form-input" id="sm-group-color" placeholder="#RRGGBB（可选）"></label>
                <label>排序<input class="form-input" id="sm-group-sort" type="number" value="0"></label>
                <div class="komari-action-row">
                  <button class="add-btn" id="sm-group-save" type="button">添加分组</button>
                  <button class="komari-secondary" id="sm-group-reset" type="button">清空表单</button>
                </div>
              </div>
            </section>
            <section class="komari-panel sm-group-list-panel">
              <div class="komari-panel-title"><span>已有分组</span><small>点击编辑 / 删除</small></div>
              <div class="komari-table-wrap">
                <table class="komari-node-table">
                  <thead><tr><th>名称</th><th>用途</th><th>颜色</th><th>排序</th><th>节点</th><th>操作</th></tr></thead>
                  <tbody id="sm-groups-tbody"></tbody>
                </table>
              </div>
            </section>
          </div>
        </div>

        <div id="sm-msg" class="komari-msg"></div>
      </div>
      <div id="sm-modal-root"></div>`;
  }

  _bind() {
    this._el.querySelector('#sm-add-node').addEventListener('click', () => this._openAddModal());
    this._el.querySelector('#sm-groups-back')?.addEventListener('click', () => this._setView('nodes'));
    this._el.querySelectorAll('[data-sm-view]').forEach((btn) => {
      btn.addEventListener('click', () => this._setView(btn.dataset.smView));
    });
    this._el.querySelector('#sm-search')?.addEventListener('input', (e) => {
      this._query = e.target.value.trim().toLowerCase();
      this._renderTable();
    });
    this._el.querySelector('#sm-filter-status')?.addEventListener('change', (e) => {
      this._statusFilter = e.target.value || 'all';
      this._renderTable();
    });
    this._el.querySelector('#sm-filter-group')?.addEventListener('change', (e) => {
      this._groupFilter = e.target.value || 'all';
      this._renderTable();
    });
    this._el.querySelector('#sm-group-save')?.addEventListener('click', () => this._saveGroup(this._editingGroupId));
    this._el.querySelector('#sm-group-reset')?.addEventListener('click', () => this._renderGroupsPage());
    this._el.querySelector('#sm-groups-tbody')?.addEventListener('click', (e) => {
      // Group rows now use the same ⋯ aggregate menu as node rows.
      const trigger = e.target.closest('[data-menu-trigger]');
      if (trigger) {
        e.stopPropagation();
        return this._toggleRowMenu(trigger);
      }
    });
    this._el.querySelector('#sm-check-all').addEventListener('change', (e) => {
      const rows = this._filteredServers();
      this._selectedIds = e.target.checked ? new Set(rows.map((s) => String(s.id))) : new Set();
      this._renderTable();
    });
    this._el.querySelector('#sm-existing').addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-menu-trigger]');
      const btn = e.target.closest('[data-action]');
      const check = e.target.closest('[data-row-check]');
      if (check) {
        const id = check.dataset.rowCheck;
        check.checked ? this._selectedIds.add(id) : this._selectedIds.delete(id);
        return;
      }
      if (trigger) {
        e.stopPropagation();
        return this._toggleRowMenu(trigger);
      }
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      this._closeRowMenu();
      if (action === 'install') return this._openInstallModal(id);
      if (action === 'terminal') return this._openAgentModal(id);
      if (action === 'edit') return this._openInfoModal(id);
      if (action === 'billing') return this._openBillingModal(id);
      if (action === 'delete') return this._delete(id);
    });
    this._el.querySelector('#sm-modal-root').addEventListener('click', (e) => {
      // Only the X button closes the dialog. Clicking the dimmed backdrop must NOT
      // discard edits (Komari-style sticky modal for install/edit cards).
      if (e.target.matches('[data-modal-close]')) this._closeModal();
    });
  }

  _filteredServers() {
    return this._servers.filter((s) => {
      if (this._statusFilter && this._statusFilter !== 'all') {
        if (this._statusBucket(s.status) !== this._statusFilter) return false;
      }
      if (this._groupFilter && this._groupFilter !== 'all') {
        const gid = String(s.group_info?.id || s.group_id || '');
        if (this._groupFilter === 'none') {
          if (gid) return false;
        } else if (gid !== String(this._groupFilter)) {
          return false;
        }
      }
      if (!this._query) return true;
      return [s.name, s.ip, s.location, s.note, s.provider, s.bw, s.group, s.group_name, s.group_info?.name, (s.tags || []).join(',')]
        .some((v) => String(v || '').toLowerCase().includes(this._query));
    });
  }

  _renderTable() {
    const el = this._el.querySelector('#sm-existing');
    if (!el) return;
    const rows = this._filteredServers();
    const countEl = this._el.querySelector('#sm-filter-count');
    if (countEl) {
      countEl.textContent = `${rows.length} / ${this._servers.length} 台`;
    }
    if (!rows.length) {
      el.innerHTML = `<tr><td colspan="9" class="komari-empty">没有匹配的节点</td></tr>`;
      return;
    }
    el.innerHTML = rows.map((s) => {
      const id = String(s.id);
      const price = Number(s.price || 0);
      const currency = this._billingCurrency(s);
      const billing = price < 0 ? '免费' : price === 0 ? '—' : `${currency}${price.toFixed(2)} / ${this._periodLabel(s.period)}`;
      const clientVersion = this._agentVersion(s) || '—';
      const pkg = s.group_info?.name || s.group || s.group_name || '默认分组';
      const purpose = s.group_info?.purpose || '';
      const bucket = this._statusBucket(s.status);
      const hb = this._formatHeartbeat(s);
      return /* html */`
        <tr data-status="${bucket}">
          <td class="komari-drag" title="拖拽排序" aria-label="拖拽排序"><span class="komari-drag-grip" aria-hidden="true"></span></td>
          <td><input type="checkbox" data-row-check="${id}" ${this._selectedIds.has(id) ? 'checked' : ''}></td>
          <td class="komari-node-name">
            <div class="komari-node-name-inner">
              <span class="sm-status-dot is-${bucket}" title="${this._escape(this._statusLabel(bucket))}"></span>
              <span class="komari-node-badge">${this._escape((s.flag || 'V').slice(0, 2))}</span>
              <div>
                <strong>${this._escape(s.name || s.ip || '未命名节点')}</strong>
                <small class="sm-node-meta">
                  <span class="sm-status-text is-${bucket}">${this._escape(this._statusLabel(bucket))}</span>
                  <span class="sm-heartbeat" title="${this._attr(hb.iso || '')}">心跳 ${this._escape(hb.text)}</span>
                </small>
              </div>
            </div>
          </td>
          <td>${this._escape(s.ip || '—')}</td>
          <td>${this._escape(clientVersion)}</td>
          <td title="${this._attr(purpose)}">${this._escape(pkg)}</td>
          <td>${this._escape(s.note || s.location || '—')}</td>
          <td>${this._escape(billing)}<br><small>${this._escape(s.expiry || '长期')}</small></td>
          <td class="komari-row-actions">
            <button class="sm-row-menu-btn" title="操作" data-menu-trigger data-menu-kind="node" data-id="${id}" aria-haspopup="true" aria-expanded="false">⋯</button>
          </td>
        </tr>`;
    }).join('');
  }

  _rowMenuItems(kind = 'node') {
    if (kind === 'group') {
      return [
        { action: 'group-edit', icon: '✎', label: '编辑' },
        { action: 'group-delete', icon: '🗑', label: '删除', danger: true },
      ];
    }
    return [
      { action: 'install', icon: '⬇', label: '下载' },
      { action: 'terminal', icon: '⌘', label: '控制台' },
      { action: 'edit', icon: '✎', label: '编辑' },
      { action: 'billing', icon: '¤', label: '账单' },
      { action: 'delete', icon: '🗑', label: '删除', danger: true },
    ];
  }

  _closeRowMenu() {
    // Menu is appended to document.body so a transformed/positioned ancestor of
    // this._el cannot break its position:fixed coordinates.
    document.querySelector('.sm-row-menu')?.remove();
    this._el.querySelectorAll('[data-menu-trigger][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (this._rowMenuDismiss) {
      document.removeEventListener('click', this._rowMenuDismiss, true);
      window.removeEventListener('resize', this._rowMenuDismiss);
      this._el.querySelector('.komari-table-wrap')?.removeEventListener('scroll', this._rowMenuDismiss);
      this._rowMenuDismiss = null;
    }
  }

  _toggleRowMenu(trigger) {
    const id = trigger.dataset.id;
    const kind = trigger.dataset.menuKind || 'node';
    const open = trigger.getAttribute('aria-expanded') === 'true';
    this._closeRowMenu();
    if (open) return;
    trigger.setAttribute('aria-expanded', 'true');
    const menu = document.createElement('div');
    menu.className = 'sm-row-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = this._rowMenuItems(kind).map((it) => `
      <button type="button" role="menuitem" class="sm-row-menu-item${it.danger ? ' danger' : ''}" data-action="${it.action}" data-id="${id}">
        <span class="sm-row-menu-ico" aria-hidden="true">${it.icon}</span>${this._escape(it.label)}
      </button>`).join('');
    // Append to body (not this._el) so position:fixed coordinates are relative
    // to the viewport, not to any transformed/positioned admin-shell ancestor.
    document.body.appendChild(menu);
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      const act = item.dataset.action;
      const rid = item.dataset.id;
      this._closeRowMenu();
      if (act === 'install') return this._openInstallModal(rid);
      if (act === 'terminal') return this._openAgentModal(rid);
      if (act === 'edit') return this._openInfoModal(rid);
      if (act === 'billing') return this._openBillingModal(rid);
      if (act === 'delete') return this._delete(rid);
      if (act === 'group-edit') return this._editGroup(rid);
      if (act === 'group-delete') return this._deleteGroup(rid);
    });
    // Position under the trigger, right-aligned; flip up if near viewport bottom.
    // CRITICAL: set position:fixed BEFORE measuring offsetWidth. Appended to
    // body as a static block, the menu stretches to the full body width (~1265px),
    // so measuring first gives left = trigger.right - 1265 ≈ 0 (clamped to the
    // far left). Making it fixed first lets it collapse to its natural ~168px so
    // the right-aligned math anchors it under the trigger.
    menu.style.position = 'fixed';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth || 168;
    const mh = menu.offsetHeight || 200;
    let left = r.right - mw;
    let top = r.bottom + 6;
    if (left < 8) left = 8;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    this._rowMenuDismiss = (ev) => {
      if (ev && ev.type === 'click' && menu.contains(ev.target)) return;
      this._closeRowMenu();
    };
    document.addEventListener('click', this._rowMenuDismiss, true);
    window.addEventListener('resize', this._rowMenuDismiss);
    this._el.querySelector('.komari-table-wrap')?.addEventListener('scroll', this._rowMenuDismiss);
  }

  _openAddModal() {
    this._editingId = null;
    this._modal('添加节点', /* html */`
      <div class="komari-form-grid one">
        <input class="form-input" id="sm-add-name" placeholder="名称（可选）">
        <input class="form-input" id="sm-add-ip" placeholder="IP地址 / 主机名（必填）">
      </div>
      <div class="komari-modal-actions"><button class="add-btn" id="sm-add-save">添加节点</button></div>`);
    this._el.querySelector('#sm-add-save').addEventListener('click', () => this._createFromModal());
  }

  async _createFromModal() {
    if (this._busy) return;
    const ip = this._val('sm-add-ip');
    const name = this._val('sm-add-name') || ip;
    if (!ip) return this._modalMsg('请填写 IP 地址 / 主机名', 'red');
    try {
      this._busy = true;
      const saved = await createServer({ name, ip, price: 0, period: 'monthly', provisionAgent: true });
      this._servers.unshift(saved);
      this._notifyServersChanged('created', saved.id);
      this._renderTable();
      this._closeModal();
      this._toast(`✅ 已添加 ${name}`, 'green');
      if (saved._agent) this._showInstallPayload(saved, saved._agent);
    } catch (e) { this._modalMsg(e.message, 'red'); }
    finally { this._busy = false; }
  }

  _openInfoModal(id) {
    const s = this._find(id); if (!s) return;
    this._editingId = s.id;
    this._modal('编辑信息', /* html */`
      <div class="komari-form-grid one">
        <label>名称<input class="form-input" id="sm-info-name" value="${this._attr(s.name || '')}"></label>
        <label>IP 地址<input class="form-input" id="sm-info-ip" value="${this._attr(s.ip || '')}"></label>
        <label>标签 <small>多个标签用逗号分隔</small><input class="form-input" id="sm-info-tags" value="${this._attr((s.tags || []).join(', '))}"></label>
        <label>分组<select class="form-input" id="sm-info-group">${this._groupOptions(s.group_info?.id)}</select><small id="sm-info-group-purpose"></small></label>
        <label>外形备注<textarea class="form-input" id="sm-info-note" placeholder="请输入内部备注">${this._escape(s.note || '')}</textarea></label>
        <label>公开备注<textarea class="form-input" id="sm-info-location" placeholder="请输入公开备注 / 地理位置">${this._escape(s.location || '')}</textarea></label>
        <div class="komari-form-grid two">
          <label>月流量 <small>单位 GB；0 表示不限/不显示</small><input class="form-input" id="sm-info-traffic-limit" type="number" min="0" step="0.01" value="${this._attr(s.traffic_limit_gb ?? 0)}"></label>
          <label>流量重置日 <small>每月 1-31 日</small><input class="form-input" id="sm-info-traffic-reset" type="number" min="1" max="31" step="1" value="${this._attr(s.traffic_reset_day ?? 1)}"></label>
        </div>
        <div class="komari-toggle-row"><div><strong>隐藏节点</strong><small>在未到期的情况下隐藏该节点（当前仅保存为标签 hidden）</small></div><input id="sm-info-hidden" type="checkbox" ${(s.tags || []).includes('hidden') ? 'checked' : ''}></div>
      </div>
      <div id="sm-modal-msg" class="komari-msg"></div>
      <div class="komari-modal-actions"><button class="add-btn" id="sm-info-save">保存</button></div>`);
    this._el.querySelector('#sm-info-save').addEventListener('click', () => this._saveInfoModal(id));
    this._el.querySelector('#sm-info-group').addEventListener('change', () => this._updateGroupPurposeHint());
    this._updateGroupPurposeHint();
  }

  async _saveInfoModal(id) {
    if (this._busy) return;
    const tags = this._val('sm-info-tags').split(',').map(x => x.trim()).filter(Boolean);
    const hidden = this._el.querySelector('#sm-info-hidden')?.checked;
    const finalTags = hidden ? Array.from(new Set([...tags, 'hidden'])) : tags.filter(x => x !== 'hidden');
    const trafficLimitGb = Number(this._val('sm-info-traffic-limit') || 0);
    const trafficResetDay = Number(this._val('sm-info-traffic-reset') || 1);
    const payload = { name: this._val('sm-info-name'), ip: this._val('sm-info-ip'), group_id: Number(this._val('sm-info-group')), note: this._val('sm-info-note'), location: this._val('sm-info-location'), tags: finalTags, traffic_limit_gb: trafficLimitGb, traffic_reset_day: trafficResetDay };
    if (!payload.name || !payload.ip) return this._modalMsg('名称和 IP 不能为空', 'red');
    if (!Number.isFinite(trafficLimitGb) || trafficLimitGb < 0) return this._modalMsg('月流量必须是 0 或更大的数字', 'red');
    if (!Number.isInteger(trafficResetDay) || trafficResetDay < 1 || trafficResetDay > 31) return this._modalMsg('流量重置日必须是 1-31 的整数', 'red');
    try {
      this._busy = true;
      const saved = await updateServer(id, payload);
      this._servers = this._servers.map(x => String(x.id) === String(id) ? { ...x, ...saved, tags: finalTags } : x);
      this._notifyServersChanged('updated', id);
      this._renderTable();
      this._closeModal();
      this._toast('✅ 信息已保存', 'green');
    } catch(e) { this._modalMsg(e.message, 'red'); }
    finally { this._busy = false; }
  }

  _openBillingModal(id) {
    const s = this._find(id); if (!s) return;
    const cfg = s.agent_config && typeof s.agent_config === 'object' ? s.agent_config : {};
    const billing = cfg.billing && typeof cfg.billing === 'object' ? cfg.billing : {};
    const periodDays = billing.period_days ?? this._periodDays(s.period);
    const expiryText = s.expiry || billing.expiry_text || '0001-01-01';
    this._modal('账单', /* html */`
      <div class="komari-form-grid one komari-billing-form">
        <label>价格 <small>0不显示，-1表示免费</small><input class="form-input" id="sm-bill-price" type="number" step="0.01" value="${this._attr(s.price ?? 0)}"></label>
        <label>货币 <small>¥-人民币，$-美元，€-欧元，£-英镑，₽-卢布，₣-法郎，₩-韩元，₺-土耳其，฿-泰铢</small><input class="form-input" id="sm-bill-currency" value="${this._attr(this._billingCurrency(s))}"></label>
        <label class="komari-period-label"><span>周期护理 <button type="button" id="sm-bill-info" class="komari-info-dot" aria-label="周期规则">i</button></span><input class="form-input" id="sm-bill-period-days" type="number" min="-1" step="1" value="${this._attr(periodDays ?? '')}"></label>
        <div class="komari-expiry-row">
          <label>接近时间<input class="form-input" id="sm-bill-expiry" type="date" value="${this._attr(expiryText)}"></label>
          <button type="button" id="sm-bill-long" class="komari-text-btn">设定为长期</button>
        </div>
        <div class="komari-toggle-row komari-renew-row"><div><strong>自动续费</strong><small>如果服务器超时时且当前在线，Komari 将自动将超时时间设置为下个自然月（年）。</small></div><label class="komari-switch"><input id="sm-bill-renew" type="checkbox" ${billing.auto_renew ? 'checked' : ''}><span></span></label></div>
      </div>
      <div id="sm-period-popover" class="komari-period-popover" hidden>
        <strong>周期规则</strong>
        <b>按预设周期（日历续费）</b>
        <p>当输入的天数与预设方案（如月付、季付、年付）的数值相近时，将转换为对应的日历周期续费。</p>
        <p>常用数值：30（月）、92（季）、365（年）、730（二年）等。</p>
        <p>示例：输入 30，服务从 3 月 15 日续费，新的账单日为 4 月 15 日。</p>
        <b>按自定义天数</b>
        <p>输入其他天数时（如 7、45、100），将严格按天数续费。</p>
        <p>示例：输入45，服务从3月15日续费，新的账单日为4月29日（45天后）。</p>
        <b>立即</b>
        <p>输入付费 -1 表示一次性付费。</p>
      </div>
      <div id="sm-modal-msg" class="komari-msg"></div>
      <div class="komari-modal-actions"><button class="add-btn komari-wide-save" id="sm-bill-save">保存</button></div>`);
    this._el.querySelector('#sm-bill-long').addEventListener('click', () => { this._el.querySelector('#sm-bill-expiry').value = '0001-01-01'; });
    this._el.querySelector('#sm-bill-info').addEventListener('click', e => {
      e.preventDefault();
      const pop = this._el.querySelector('#sm-period-popover');
      pop.hidden = !pop.hidden;
    });
    this._el.querySelector('#sm-bill-save').addEventListener('click', () => this._saveBillingModal(id));
  }

  async _saveBillingModal(id) {
    if (this._busy) return;
    const s = this._find(id); if (!s) return;
    const price = Number(this._val('sm-bill-price') || 0);
    const periodDays = Number(this._val('sm-bill-period-days') || 0);
    if (Number.isNaN(price) || price < -1) return this._modalMsg('价格只能为 -1 或更大的数字', 'red');
    if (Number.isNaN(periodDays) || periodDays < -1) return this._modalMsg('周期天数只能为 -1 或更大的整数', 'red');
    const period = this._periodFromDays(periodDays);
    const prevCfg = s.agent_config && typeof s.agent_config === 'object' ? s.agent_config : {};
    const billing = {
      ...(prevCfg.billing || {}),
      currency: this._val('sm-bill-currency') || '$',
      period_days: periodDays,
      auto_renew: !!this._el.querySelector('#sm-bill-renew')?.checked,
      expiry_text: this._val('sm-bill-expiry') || '0001-01-01',
    };
    const agentConfig = { ...prevCfg, billing };
    const expiryVal = this._val('sm-bill-expiry');
    const payload = { name: s.name, ip: s.ip, price, period, expiry: expiryVal && expiryVal !== '0001-01-01' ? expiryVal : null };
    try {
      this._busy = true;
      const saved = await updateServer(id, payload);
      try { await updateAgentConfig(id, agentConfig); } catch (_) {}
      this._servers = this._servers.map(x => String(x.id) === String(id) ? { ...x, ...saved, price, period: payload.period, expiry: payload.expiry, agent_config: agentConfig } : x);
      this._notifyServersChanged('updated', id);
      this._renderTable();
      this._closeModal();
      this._toast('✅ 账单已保存', 'green');
    } catch(e) { this._modalMsg(e.message, 'red'); }
    finally { this._busy = false; }
  }

  async _openInstallModal(id) {
    const s = this._find(id); if (!s) return;
    this._modal('一键配置命令', `<div class="komari-loading">正在生成安装命令...</div>`);
    try {
      const agent = await generateAgentKey(id);
      let payload = { ...agent };
      try {
        const res = await fetchAgentInstallCommand(id, agent.agent_key);
        payload = { ...agent, ...res };
      } catch (_) {}
      this._showInstallPayload(s, payload);
    } catch (e) { this._modal('一键配置命令', `<div class="komari-error">${this._escape(e.message)}</div>`); }
  }

  _validateInstallPayload(agent = {}) {
    const issues = [];
    const url = String(agent.install_url || agent.api_root || '');
    const cmd = String(agent.install_command || agent.command || '');
    const page = window.location || {};
    const pagePort = String(page.port || (page.protocol === 'https:' ? '443' : '80'));
    if (!url) issues.push('缺少 Install URL / api_root');
    if (!cmd) issues.push('安装命令为空');
    try {
      const u = new URL(url, page.origin || 'http://localhost');
      if (page.protocol === 'http:' && u.protocol === 'https:') {
        issues.push('安装地址是 HTTPS，但当前面板是 HTTP：Agent 容易 TLS 握手超时');
      }
      if (page.hostname && u.hostname === page.hostname) {
        const needPort = pagePort && pagePort !== '80' && pagePort !== '443';
        if (needPort && !u.port) {
          issues.push(`安装地址缺少端口 :${pagePort}（会误连 :80）`);
        }
        if (needPort && u.port && u.port !== pagePort) {
          issues.push(`安装端口 :${u.port} 与面板端口 :${pagePort} 不一致`);
        }
      }
      if (u.pathname && !u.pathname.includes('/api/v1/agent/install.sh') && cmd.includes('install.sh') === false) {
        // soft: ignore
      }
    } catch (_) {
      issues.push('Install URL 无法解析');
    }
    if (cmd && !cmd.includes('--api-root')) issues.push('安装命令缺少 --api-root');
    if (cmd && !cmd.includes('--agent-key')) issues.push('安装命令缺少 --agent-key');
    if (cmd && !cmd.includes('--uuid')) issues.push('安装命令缺少 --uuid');
    return issues;
  }

  _showInstallPayload(server, agent) {
    const cmd = agent?.install_command || agent?.command || '';
    const url = agent?.install_url || '';
    const apiRoot = agent?.api_root || '';
    const issues = this._validateInstallPayload({ ...agent, install_command: cmd, install_url: url || apiRoot });
    const blocked = issues.length > 0;
    const warnHtml = blocked
      ? `<div class="komari-install-warn"><b>安装命令不可直接复制</b><ul>${issues.map((x) => `<li>${this._escape(x)}</li>`).join('')}</ul><p>请确认 PUBLIC_API_ROOT / FRONTEND_URL 含正确端口；纯 HTTP 面板需 AGENT_REQUIRE_TLS=0。</p></div>`
      : `<div class="komari-install-ok">校验通过：远程 Agent 将回连 <code>${this._escape(apiRoot || url || location.origin)}</code></div>`;
    this._modal('一键配置命令', /* html */`
      <div class="komari-form-grid one">
        <label>节点<div class="form-input" style="background:transparent">${this._escape(server?.name || '')} · #${this._escape(server?.id || '')}</div></label>
        <label>Agent Key<textarea readonly class="form-input komari-code" id="sm-copy-key">${this._escape(agent?.agent_key || '')}</textarea></label>
        <label>API Root / Install URL<textarea readonly class="form-input komari-code" id="sm-copy-url">${this._escape(url || apiRoot || '')}</textarea></label>
        <label>Install Command<textarea readonly class="form-input komari-code" id="sm-copy-cmd">${this._escape(cmd)}</textarea></label>
      </div>
      ${warnHtml}
      <div id="sm-modal-msg" class="komari-msg"></div>
      <div class="komari-modal-actions">
        <button type="button" class="add-btn" id="sm-copy-install" ${blocked ? 'disabled style="opacity:.45;cursor:not-allowed"' : ''}>${blocked ? '已禁止复制' : '复制命令'}</button>
      </div>`);
    this._el.querySelector('#sm-copy-install')?.addEventListener('click', () => {
      if (blocked) return this._modalMsg('请先修复上方标红问题', 'red');
      this._copy(this._el.querySelector('#sm-copy-cmd').value);
    });
  }

  async _openAgentModal(id) {
    const s = this._find(id); if (!s) return;
    this._modal('Agent 状态', `<div class="komari-loading">加载中...</div>`);
    try {
      const data = await getAgentOverview(id);
      this._modal('Agent 状态', /* html */`
        <div class="komari-agent-state">
          <div><b>节点</b><span>${this._escape(s.name)}</span></div>
          <div><b>UUID</b><span>${this._escape(data.uuid || '未绑定')}</span></div>
          <div><b>密钥创建</b><span>${this._escape(data.agent_key_created_at || '—')}</span></div>
          <div><b>最近使用</b><span>${this._escape(data.agent_key_last_used || '—')}</span></div>
          <div><b>能力策略</b><span>只读监控 / exec 禁用 / terminal 禁用 / file_list 禁用</span></div>
        </div>
        <div class="komari-modal-actions"><button class="add-btn" id="sm-agent-rotate">轮换密钥</button></div>`);
      this._el.querySelector('#sm-agent-rotate').addEventListener('click', async () => {
        const agent = await rotateAgentKey(id);
        this._showInstallPayload(s, agent);
      });
    } catch(e) { this._modal('Agent 状态', `<div class="komari-error">${this._escape(e.message)}</div>`); }
  }

  async _delete(id) {
    if (this._busy || !confirm('确认删除该节点？')) return;
    try {
      this._busy = true;
      await deleteServer(id);
      this._servers = this._servers.filter(s => String(s.id) !== String(id));
      this._notifyServersChanged('deleted', id);
      this._renderTable();
      this._toast('🗑️ 删除成功', 'blue');
    } catch(e){ this._toast(e.message,'red'); }
    finally { this._busy=false; }
  }

  _modal(title, body) {
    this._el.querySelector('#sm-modal-root').innerHTML = /* html */`
      <div class="komari-modal-backdrop">
        <div class="komari-modal" role="dialog" aria-modal="true">
          <div class="komari-modal-title"><span>${this._escape(title)}</span><button data-modal-close>×</button></div>
          <div class="komari-modal-body">${body}</div>
        </div>
      </div>`;
  }
  _closeModal(){ this._el.querySelector('#sm-modal-root').replaceChildren(); }
  _find(id){ return this._servers.find(x => String(x.id) === String(id)); }
  _val(id){ return this._el.querySelector(`#${id}`)?.value?.trim() || ''; }
  _periodLabel(p){ return {monthly:'月付', quarterly:'季付', yearly:'年付', biennial:'二年付', one_time:'一次性', custom:'自定义'}[p] || p || 'monthly'; }
  _periodDays(p){ return {monthly:30, quarterly:92, yearly:365, biennial:730, one_time:-1}[p] ?? ''; }
  _periodFromDays(days){ if (days === -1) return 'one_time'; if (days >= 27 && days <= 33) return 'monthly'; if (days >= 86 && days <= 98) return 'quarterly'; if (days >= 350 && days <= 380) return 'yearly'; if (days >= 710 && days <= 750) return 'biennial'; return 'custom'; }
  _billingCurrency(s){ const cfg=s.agent_config&&typeof s.agent_config==='object'?s.agent_config:{}; const billing=cfg.billing&&typeof cfg.billing==='object'?cfg.billing:{}; return billing.currency || s.currency || '¥'; }
  _agentVersion(s){ const m=s.agent_config?.inventory_meta || {}; return m.agent_version || s.agent_version || ''; }
  _escape(v){ return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  _attr(v){ return this._escape(v).replace(/`/g, '&#96;'); }
  _modalMsg(text,type){ const el=this._el.querySelector('#sm-modal-msg'); if(el){ el.style.color=type==='red'?'var(--red)':type==='green'?'var(--green)':'var(--accent)'; el.textContent=text; } }
  _toast(text,type){ const el=this._el.querySelector('#sm-msg'); if(!el)return; const colors={green:'var(--green)',red:'var(--red)',blue:'var(--accent)'}; el.style.color=colors[type]||'var(--text2)'; el.textContent=text; setTimeout(()=>{ if(el.textContent===text) el.textContent=''; }, 5000); }
  async _copy(text){
    const value = String(text || '');
    if (!value.trim()) { this._modalMsg('没有可复制的内容', 'red'); return; }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        this._copyWithTextarea(value);
      }
      this._modalMsg('✅ 已复制', 'green');
    } catch (_) {
      try { this._copyWithTextarea(value); this._modalMsg('✅ 已复制', 'green'); }
      catch (err) { this._modalMsg('复制失败：请手动选中复制', 'red'); }
    }
  }
  _copyWithTextarea(text){
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
  _notifyServersChanged(action,id){ window.dispatchEvent(new CustomEvent('servers-changed',{detail:{action,id}})); localStorage.setItem('vps-servers-version',String(Date.now())); this._serversChannel?.postMessage({action,id,at:Date.now()}); }
}
