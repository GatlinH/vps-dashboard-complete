import { tcpPing } from '../../api/admin.js';
import { getIPInfo } from '../../api/public.js';
import { getAgentOverview, updateAgentConfig } from '../../api/servers.js';
import {
  ALL_REGIONS, UNGROUPED_REGION, normalizeRegion, isValidRegion, isExternalPingTarget,
  listTargetRegions, filterRegionalTargets, encodeRegionSelection, decodeRegionSelection,
  restoreRegionSelection,
} from '../../services/regionalPing.js';

/** Komari-inspired 延迟监测：仅管理 agent_config.ping_targets（external），
 *  与详情页「全球 VPS 探针」（peer / source=agent）无关。 */
export class PingTool {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._servers = [];
    this._selectedServerId = null;
    this._targets = [];
    this._agentConfig = null;
    this._loadSeq = 0;
    this._activeServerId = null;
    this._configState = 'idle';
    this._regionSelection = ALL_REGIONS;
    this._regionSelections = new Map();
    this._lastResults = [];
    this._render();
    this._bind();
    this._setConfigState('idle', '请先选择 VPS，再读取受保护的目标配置。');
  }

  setServers(servers) {
    this._servers = servers || [];
    const serverIds = new Set(this._servers.map(server => String(server.id)));
    for (const serverId of this._regionSelections.keys()) {
      if (!serverIds.has(serverId)) this._regionSelections.delete(serverId);
    }
    if (!serverIds.has(String(this._selectedServerId))) this._selectedServerId = this._servers[0]?.id ?? null;
    this._renderServerOptions();
    return this._loadTargetsFromServer();
  }

  _render() {
    this._el.innerHTML = /* html */`
      <div class="komari-settings-page ping-tool-page">
        <div class="komari-page-head ping-tool-head">
          <div>
            <h2>延迟监测</h2>
            <p>配置详情页 <b>PING 延迟</b> 的 external 目标（<code>agent_config.ping_targets</code>）。支持 TCP / ICMP / HTTP。</p>
          </div>
          <div class="pt-head-actions" aria-label="延迟探测操作">
            <button class="komari-primary" id="pt-run">开始探测</button>
            <button class="komari-secondary" id="pt-run-node">探测当前节点 IP</button>
          </div>
        </div>
        <div class="komari-install-ok" style="margin-bottom:12px">
          <b>与「全球 VPS 探针」不同：</b>
          延迟监测 = 你手动配置的公网目标；全球探针 = 当前节点 Agent 互探其它 VPS（自动 peer，不在此页配置）。
        </div>
        <div class="komari-settings-grid two">
          <section class="komari-panel">
            <div class="komari-panel-title"><span>探测配置</span><small>agent_config.ping_targets · 仅 PING 图</small></div>
            <div class="komari-form-grid one">
              <label><span>绑定节点</span><select class="form-input" id="pt-server-select"></select></label>
              <label class="pt-region-filter"><span>目标地区</span><select class="form-input" id="pt-region-select"></select></label>
            </div>
            <div id="pt-source-note" class="komari-note">从受保护接口读取当前 VPS 的 agent_config.ping_targets。</div>
            <div id="pt-target-editor" class="komari-target-editor"></div>
            <div class="komari-action-row">
              <button class="komari-secondary" id="pt-load">重新载入</button>
              <button class="komari-secondary" id="pt-add-row">添加目标</button>
              <button class="komari-primary" id="pt-save">保存到当前 VPS</button>
              <button class="komari-secondary" id="pt-clear">清空当前 VPS</button>
              <button class="komari-secondary" id="pt-export">复制 JSON</button>
            </div>
          </section>
          <section class="komari-panel">
            <div class="komari-panel-title"><span>实时质量</span><small>本轮多协议探测（不写全球探针）</small></div>
            <div class="komari-metric-strip" id="pt-summary">
              <div><b>—</b><span>平均延迟</span></div><div><b>—</b><span>丢包</span></div><div><b>—</b><span>目标数</span></div>
            </div>
            <div id="pt-results" class="komari-console"><div class="ping-empty-state">暂无探测数据，请点击“开始探测”。</div></div>
          </section>
        </div>
        <section class="komari-panel">
          <div class="komari-panel-title"><span>IP 信息查询</span><small>辅助确认节点地理与 ASN</small></div>
          <div class="komari-inline-form"><input class="form-input" id="pt-ip-input" placeholder="输入 IP 地址，留空则查询本机"><button class="komari-primary" id="pt-ip-lookup">查询</button></div>
          <div id="pt-ip-result" class="komari-kv-box">等待查询...</div>
        </section>
      </div>`;
  }

  _bind() {
    this._el.querySelector('#pt-server-select').addEventListener('change', e => { this._selectedServerId = Number(e.target.value) || null; return this._loadTargetsFromServer(); });
    this._el.querySelector('#pt-region-select').addEventListener('change', event => this._setRegionSelection(event.target.value));
    this._el.querySelector('#pt-load').addEventListener('click', () => this._loadTargetsFromServer());
    this._el.querySelector('#pt-add-row').addEventListener('click', () => this._addTarget());
    this._el.querySelector('#pt-run').addEventListener('click', () => this._runPing());
    this._el.querySelector('#pt-run-node').addEventListener('click', () => this._runCurrentNode());
    this._el.querySelector('#pt-save').addEventListener('click', () => this._saveTargets());
    this._el.querySelector('#pt-clear').addEventListener('click', () => this._clearSavedTargets());
    this._el.querySelector('#pt-export').addEventListener('click', () => this._exportJson());
    this._el.querySelector('#pt-ip-lookup').addEventListener('click', () => this._lookupIP());
    this._el.querySelector('#pt-target-editor').addEventListener('input', () => this._collectTargets());
    this._el.querySelector('#pt-target-editor').addEventListener('change', event => {
      if (event.target?.dataset?.f === 'protocol' && this._collectTargets()) this._renderTargetEditor();
    });
    this._el.querySelector('#pt-target-editor').addEventListener('click', event => {
      const button = event.target.closest('[data-remove-target]');
      if (button) this._removeTarget(button.dataset.removeTarget);
    });
  }

  _renderServerOptions() {
    const sel = this._el.querySelector('#pt-server-select');
    sel.innerHTML = this._servers.map(s => `<option value="${this._esc(s.id)}">${this._esc(s.flag || '🌐')} ${this._esc(s.name || s.ip)} · ${this._esc(s.ip || '')}</option>`).join('');
    if (this._selectedServerId) sel.value = String(this._selectedServerId);
  }
  _defaultTargets() { return [
    { key:'hk', label:'香港 CMI', protocol:'tcp', host:'43.155.88.12', port:443 },
    { key:'jp', label:'日本东京 SoftBank', protocol:'tcp', host:'27.0.234.55', port:443 },
    { key:'sg', label:'新加坡', protocol:'tcp', host:'172.104.55.99', port:443 },
    { key:'us', label:'美国西岸', protocol:'tcp', host:'1.1.1.1', port:443 },
  ]; }
  _setConfigState(state, note) {
    this._configState = state;
    const locked = state !== 'ready';
    for (const selector of ['#pt-region-select', '#pt-add-row', '#pt-save', '#pt-clear', '#pt-export', '#pt-run', '#pt-run-node']) {
      this._el.querySelector(selector).disabled = locked;
    }
    for (const control of this._el.querySelectorAll('#pt-target-editor input, #pt-target-editor select, #pt-target-editor button')) {
      control.disabled = locked || (control.dataset.f === 'port' && !!control.closest('[data-protocol="icmp"]'));
    }
    if (note != null) this._el.querySelector('#pt-source-note').textContent = note;
  }
  _isCurrentLoad(seq, serverId) {
    return seq === this._loadSeq && String(serverId) === String(this._selectedServerId)
      && String(serverId) === String(this._activeServerId);
  }
  async _loadTargetsFromServer() {
    const seq = ++this._loadSeq;
    const server = this._selectedServer();
    const serverId = server?.id ?? null;
    this._activeServerId = serverId;
    this._agentConfig = null;
    this._targets = [];
    this._el.querySelector('#pt-target-editor').innerHTML = '';
    this._el.querySelector('#pt-region-select').innerHTML = '';
    this._el.querySelector('#pt-save').textContent = '保存到当前 VPS';
    this._el.querySelector('#pt-clear').textContent = '清空当前 VPS';
    this._setConfigState(server ? 'loading' : 'idle', server ? '读取中：正在读取当前 VPS 的受保护目标配置，暂不可编辑或保存。' : '请先选择 VPS，再读取受保护的目标配置。');
    if (!server) return;
    try {
      const data = await getAgentOverview(serverId);
      if (!this._isCurrentLoad(seq, serverId)) return;
      const cfg = data?.agent_config;
      if (!data || Array.isArray(data) || String(data.server_id) !== String(serverId)
        || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('受保护配置响应无效。');
      const hasSavedTargets = Object.prototype.hasOwnProperty.call(cfg, 'ping_targets');
      if (hasSavedTargets && (!Array.isArray(cfg.ping_targets)
        || cfg.ping_targets.some(target => !target || typeof target !== 'object' || Array.isArray(target)))) {
        throw new Error('受保护 ping_targets 响应无效。');
      }
      this._agentConfig = structuredClone(cfg);
      const targets = hasSavedTargets ? this._agentConfig.ping_targets : this._defaultTargets();
      this._targets = targets.filter(isExternalPingTarget).map((target, index) => this._normalizeTarget(target, index));
      this._regionSelection = this._regionSelections.get(String(serverId)) || ALL_REGIONS;
      this._renderTargetEditor();
      this._setConfigState('ready', hasSavedTargets ? (targets.length ? '当前使用该节点已保存的 agent_config.ping_targets。' : '当前节点已保存为空：详情页 PING 显示 0 目标，不再回退默认目标。') : '该节点未配置 ping_targets，当前显示全局默认多协议目标；点击保存后才写入该 VPS。');
    } catch (error) {
      if (!this._isCurrentLoad(seq, serverId)) return;
      this._agentConfig = null;
      this._targets = [];
      this._el.querySelector('#pt-target-editor').innerHTML = '';
      this._el.querySelector('#pt-region-select').innerHTML = '';
      const message = `读取失败：${error.message || '无法读取受保护配置'} 请重新载入；禁止保存或清空，以免覆盖已有目标。`;
      this._setConfigState('error', message);
      this._appendLine(message, 'fail');
    }
  }
  _normalizeTarget(t = {}, i = 0) {
    const protocol = String(t.protocol || 'tcp').toLowerCase();
    const safeProtocol = ['tcp', 'icmp', 'http'].includes(protocol) ? protocol : 'tcp';
    const fallbackPort = safeProtocol === 'http' ? 80 : 443;
    return {
      key: t.key || `target-${i + 1}`,
      label: t.label || t.host || `目标 ${i + 1}`,
      region: normalizeRegion(t.region),
      protocol: safeProtocol,
      host: t.host || '',
      port: t.port === '' || t.port == null ? '' : Number(t.port || fallbackPort),
    };
  }
  _portPlaceholder(protocol) {
    if (protocol === 'icmp') return 'ICMP 无端口';
    if (protocol === 'http') return '选填：80/443/自定义';
    return '必填，如 443';
  }
  _portHelp(protocol) {
    if (protocol === 'icmp') return 'ICMP 不使用端口';
    if (protocol === 'http') return 'HTTP 端口选填；完整 URL 自带端口优先';
    return 'TCP 必须指定端口';
  }
  _targetDisplayPort(t) {
    const protocol = t.protocol || 'tcp';
    if (protocol === 'icmp') return '';
    if (t.port === '' || t.port == null) return protocol === 'http' ? '' : ':443';
    return `:${Number(t.port)}`;
  }
  _targetApiPort(t) {
    const protocol = t.protocol || 'tcp';
    if (protocol === 'icmp') return 0;
    if (t.port === '' || t.port == null) return protocol === 'http' ? 80 : 443;
    return Number(t.port);
  }
  _exportTarget(t) {
    const protocol = t.protocol || 'tcp';
    const out = { key: t.key, label: t.label, protocol, host: t.host, region: normalizeRegion(t.region) };
    if (protocol === 'tcp') out.port = this._targetApiPort(t);
    if (protocol === 'http' && t.port !== '' && t.port != null) out.port = Number(t.port);
    return out;
  }
  _renderRegionOptions() {
    this._regionSelection = restoreRegionSelection(this._regionSelection, this._targets);
    if (this._selectedServerId != null) this._regionSelections.set(String(this._selectedServerId), this._regionSelection);
    const select = this._el.querySelector('#pt-region-select');
    select.innerHTML = `<option value="${encodeRegionSelection(ALL_REGIONS)}">全部地区</option><option value="${encodeRegionSelection(UNGROUPED_REGION)}">未分组</option>`
      + listTargetRegions(this._targets).filter(group => !group.ungrouped).map(group =>
        `<option value="${this._esc(encodeRegionSelection({ kind: 'region', region: group.region }))}">${this._esc(group.region)}</option>`).join('');
    select.value = encodeRegionSelection(this._regionSelection);
  }
  _setRegionSelection(encoded) {
    if (!this._collectTargets()) {
      this._el.querySelector('#pt-region-select').value = encodeRegionSelection(this._regionSelection);
      return false;
    }
    this._regionSelection = decodeRegionSelection(encoded);
    this._renderTargetEditor();
    return true;
  }
  _addTarget() {
    if (!this._collectTargets()) return;
    const keys = new Set(this._targets.map(target => String(target.key)));
    let nextIndex = this._targets.length + 1;
    while (keys.has(`target-${nextIndex}`)) nextIndex += 1;
    this._targets.push({
      key: `target-${nextIndex}`, label: '新目标', protocol: 'tcp', host: '', port: 443,
      region: this._regionSelection.kind === 'region' ? this._regionSelection.region : '',
    });
    this._renderTargetEditor();
  }
  _removeTarget(key) {
    if (!this._collectTargets()) return;
    const targetIndex = this._targets.findIndex(target => String(target.key) === String(key));
    if (targetIndex < 0) return;
    this._targets.splice(targetIndex, 1);
    this._renderTargetEditor();
  }
  _renderTargetEditor() {
    this._renderRegionOptions();
    const visibleTargets = new Set(filterRegionalTargets(this._targets, this._regionSelection));
    const editor = this._el.querySelector('#pt-target-editor');
    editor.innerHTML = this._targets.map((raw, index) => {
      if (!visibleTargets.has(raw)) return '';
      const target = this._normalizeTarget(raw, index);
      const portDisabled = target.protocol === 'icmp' ? 'disabled' : '';
      const portClass = target.protocol === 'icmp' ? ' is-disabled' : (target.protocol === 'http' ? ' is-optional' : ' is-required');
      return `<div class="komari-target-row pt-target-row" data-key="${this._esc(target.key)}" data-protocol="${this._esc(target.protocol)}"><input class="form-input" data-f="key" data-i="${index}" value="${this._esc(target.key)}" placeholder="key" readonly aria-label="目标 key（固定）"><input class="form-input" data-f="label" data-i="${index}" value="${this._esc(target.label)}" placeholder="显示名"><input class="form-input pt-region-input" data-f="region" data-i="${index}" value="${this._esc(target.region)}" placeholder="地区（留空为未分组）" aria-label="目标地区"><select class="form-input" data-f="protocol" data-i="${index}"><option value="tcp" ${target.protocol==='tcp'?'selected':''}>TCP</option><option value="icmp" ${target.protocol==='icmp'?'selected':''}>ICMP</option><option value="http" ${target.protocol==='http'?'selected':''}>HTTP</option></select><input class="form-input" data-f="host" data-i="${index}" value="${this._esc(target.host)}" placeholder="host / IP / URL"><label class="pt-port-field${portClass}"><input class="form-input" data-f="port" data-i="${index}" value="${this._esc(target.protocol==='icmp'?'':target.port)}" placeholder="${this._esc(this._portPlaceholder(target.protocol))}" ${portDisabled}><small>${this._esc(this._portHelp(target.protocol))}</small></label><button data-remove-target="${this._esc(target.key)}" class="komari-icon-danger">🗑</button></div>`;
    }).join('') || '<div class="komari-empty-small">暂无目标</div>';
  }
  _collectTargets() {
    if (this._configState !== 'ready') return false;
    const pendingTargets = this._targets.map(target => ({ ...target }));
    let invalidInput = null;
    let validationMessage = '';
    for (const input of this._el.querySelectorAll('#pt-target-editor [data-i]')) {
      const targetIndex = Number(input.dataset.i);
      const field = input.dataset.f;
      if (!pendingTargets[targetIndex] || !['label', 'region', 'protocol', 'host', 'port'].includes(field)) continue;
      input.setCustomValidity?.('');
      let message = '';
      if (typeof input.value !== 'string') message = '目标字段必须为文本。';
      else if (field === 'region' && !isValidRegion(input.value)) message = '地区最多 32 个 Unicode 字符 / 128 UTF-8 字节，不能包含换行。';
      else if (field === 'port' && !input.disabled && input.value.trim() !== ''
        && (!Number.isInteger(Number(input.value)) || Number(input.value) < 1 || Number(input.value) > 65535)) message = '端口须为 1–65535 的整数或留空。';
      else if (field === 'protocol' && !['tcp', 'icmp', 'http'].includes(input.value.trim())) message = '请选择 TCP / ICMP / HTTP 协议。';
      if (message) input.setCustomValidity?.(message);
      if (message || input.checkValidity?.() === false) {
        if (!invalidInput) { invalidInput = input; validationMessage = message || input.validationMessage; }
        continue;
      }
      pendingTargets[targetIndex][field] = field === 'port'
        ? (input.disabled || input.value.trim() === '' ? '' : Number(input.value)) : input.value.trim();
    }
    if (invalidInput) {
      invalidInput.reportValidity?.();
      alert(validationMessage);
      return false;
    }
    this._targets = pendingTargets.map((target, index) => this._normalizeTarget(target, index));
    return true;
  }
  async _runCurrentNode() {
    const server = this._servers.find(s => String(s.id) === String(this._selectedServerId));
    if (!server?.ip) return this._appendLine('当前节点没有 IP', 'warn');
    if (!this._collectTargets()) return;
    const old = this._targets;
    const oldSelection = this._regionSelection;
    this._targets = [{ key:'node', label:server.name || server.ip, protocol:'tcp', host:server.ip, port:80, region:'' }];
    this._regionSelection = ALL_REGIONS;
    this._renderTargetEditor();
    try { await this._runPing(); }
    finally { this._targets = old; this._regionSelection = oldSelection; this._renderTargetEditor(); }
  }

  _quality(avg, loss) {
    if (!Number.isFinite(avg)) return '未知';
    if (loss >= 50) return '不可用';
    if (avg < 80 && loss === 0) return '优秀';
    if (avg < 180 && loss < 10) return '良好';
    if (avg < 320 && loss < 25) return '一般';
    return '较差';
  }

  async _runPing() {
    if (!this._collectTargets()) return;
    const targets = this._targets.filter(target => isExternalPingTarget(target) && target.host);
    if (!targets.length) { this._setEmptyState('暂无有效目标，请先配置 host。'); return; }
    const btn=this._el.querySelector('#pt-run'); btn.textContent='探测中...'; btn.disabled=true; this._clearResults(); this._lastResults=[];
    for (const t of targets) {
      this._appendLine(`──── [${(t.protocol || 'tcp').toUpperCase()}] ${t.label} ${t.host}${this._targetDisplayPort(t)} ────`, 'info');
      try { const data=await tcpPing(t.host,this._targetApiPort(t),4,t.protocol||'tcp'); const stats=data.stats||{}; const results=data.results||[]; this._lastResults.push({target:t,stats}); results.forEach(item=>this._appendLine(item.success ? `${item.seq}/4 rtt=${item.latency_ms}ms` : `${item.seq}/4 ${item.error || 'fail'}`, item.success?'ok':'warn')); this._appendLine(`统计 avg=${stats.avg_ms ?? '—'}ms min=${stats.min_ms ?? '—'}ms max=${stats.max_ms ?? '—'}ms 丢包${stats.loss_pct ?? 0}%`, (stats.avg_ms ?? 999)<180?'ok':'warn'); }
      catch(e){ this._appendLine(`服务异常：${e.message}`, 'fail'); }
    }
    this._renderSummary(); btn.textContent='开始探测'; btn.disabled=false;
  }
  _renderSummary(){ const rows=this._lastResults; const avgs=rows.map(r=>Number(r.stats?.avg_ms)).filter(Number.isFinite); const avg=avgs.length?Math.round(avgs.reduce((a,b)=>a+b,0)/avgs.length):'—'; const loss=rows.length?Math.round(rows.reduce((a,r)=>a+Number(r.stats?.loss_pct||0),0)/rows.length):'—'; const quality=this._quality(Number(avg), Number(loss)); this._el.querySelector('#pt-summary').innerHTML=`<div><b>${avg}${avg==='—'?'':'ms'}</b><span>平均延迟</span></div><div><b>${loss}${loss==='—'?'':'%'}</b><span>平均丢包</span></div><div><b>${quality}</b><span>质量等级</span></div>`; }

  _selectedServer(){ return this._servers.find(s => String(s.id) === String(this._selectedServerId)); }
  _savedPayload(targets){ return { ping_targets: targets.filter(isExternalPingTarget) }; }
  async _saveTargets(){
    if (!this._collectTargets()) return;
    const server=this._selectedServer();
    if(!server?.id) return this._appendLine('请先选择 VPS', 'warn');
    const targets=this._targets.filter(target=>isExternalPingTarget(target) && target.host).map(target=>this._exportTarget(target));
    const payload = this._savedPayload(targets);
    const seq = this._loadSeq;
    this._setConfigState('saving');
    const btn=this._el.querySelector('#pt-save'); const old=btn.textContent; btn.disabled=true; btn.textContent='保存中...';
    try{
      const data=await updateAgentConfig(server.id, payload);
      if (!this._isCurrentLoad(seq, server.id)) return;
      const savedTargets = Array.isArray(data.agent_config?.ping_targets) ? data.agent_config.ping_targets.filter(isExternalPingTarget) : targets;
      this._agentConfig = { ...this._agentConfig, ...data.agent_config, ping_targets: savedTargets };
      this._targets = savedTargets.map((target,index)=>this._normalizeTarget(target,index));
      this._renderTargetEditor();
      this._el.querySelector('#pt-source-note').textContent = targets.length ? '已保存：当前使用该节点的 agent_config.ping_targets。' : '已保存为空：详情页 PING 显示 0 目标。';
      this._appendLine(`已保存 ${targets.length} 个目标到 VPS #${server.id}。`, 'ok');
    }catch(e){ if (this._isCurrentLoad(seq, server.id)) this._appendLine(`保存失败：${e.message}`, 'fail'); }
    finally{ if (this._isCurrentLoad(seq, server.id)) { this._renderTargetEditor(); this._setConfigState('ready'); btn.textContent=old; } }
  }
  async _clearSavedTargets(){
    if (!this._collectTargets()) return;
    const server=this._selectedServer();
    if(!server?.id) return this._appendLine('请先选择 VPS', 'warn');
    const payload = this._savedPayload([]);
    const seq = this._loadSeq;
    this._setConfigState('saving');
    const btn=this._el.querySelector('#pt-clear'); const old=btn.textContent; btn.disabled=true; btn.textContent='清空中...';
    try{
      const data=await updateAgentConfig(server.id, payload);
      if (!this._isCurrentLoad(seq, server.id)) return;
      this._agentConfig = { ...this._agentConfig, ...data.agent_config, ping_targets: [] };
      this._targets=[];
      this._renderTargetEditor();
      this._el.querySelector('#pt-source-note').textContent = '已清空并保存：详情页 PING 显示 0 目标，不再回退默认目标。';
      this._appendLine(`已清空 VPS #${server.id} 的 ping_targets。`, 'ok');
    }catch(e){ if (this._isCurrentLoad(seq, server.id)) this._appendLine(`清空失败：${e.message}`, 'fail'); }
    finally{ if (this._isCurrentLoad(seq, server.id)) { this._renderTargetEditor(); this._setConfigState('ready'); btn.textContent=old; } }
  }
  _exportJson(){ if (!this._collectTargets()) return; const out=JSON.stringify({ ping_targets:this._targets.filter(target=>isExternalPingTarget(target) && target.host).map(target=>this._exportTarget(target)) },null,2); navigator.clipboard?.writeText(out); this._appendLine('已复制 ping_targets JSON。', 'ok'); }
  _setEmptyState(text){ this._el.querySelector('#pt-results').innerHTML=`<div class="ping-empty-state">${this._esc(text)}</div>`; }
  _appendLine(text,type='info'){ const c=this._el.querySelector('#pt-results'); let out=c.querySelector('.ping-result'); if(!out){out=document.createElement('div');out.className='ping-result';c.replaceChildren();c.appendChild(out);} const line=document.createElement('div'); line.className=`ping-line ping-${type}`; line.textContent=text||'\u00A0'; out.appendChild(line); out.scrollTop=out.scrollHeight; }
  _clearResults(){ this._el.querySelector('#pt-results').innerHTML='<div class="ping-empty-state">正在探测中...</div>'; }
  async _lookupIP(){ const ip=this._el.querySelector('#pt-ip-input').value.trim(); const out=this._el.querySelector('#pt-ip-result'); out.textContent='查询中...'; try{ const d=await getIPInfo(ip); const rows=[['IP',d.query],['城市',d.city],['地区',d.regionName],['国家',d.country],['ISP/ASN',`${d.isp||'—'} / ${d.as||'—'}`],['经纬度',`${d.lat}, ${d.lon}`],['组织',d.org]]; out.innerHTML=rows.map(([k,v])=>`<div><span>${this._esc(k)}</span><b>${this._esc(v||'—')}</b></div>`).join(''); }catch(e){ out.innerHTML=`<em>查询失败：${this._esc(e.message)}</em>`; }}
  _esc(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
}
