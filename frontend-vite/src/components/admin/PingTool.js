import { tcpPing } from '../../api/admin.js';
import { getIPInfo } from '../../api/public.js';
import { updateAgentConfig } from '../../api/servers.js';

/** Komari-inspired 延迟监控：结合本项目 agent_config.ping_targets + 后端 TCPing */
export class PingTool {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._servers = [];
    this._selectedServerId = null;
    this._targets = [];
    this._lastResults = [];
    this._render();
    this._bind();
  }

  setServers(servers) {
    this._servers = servers || [];
    if (!this._selectedServerId && this._servers.length) this._selectedServerId = this._servers[0].id;
    this._renderServerOptions();
    this._loadTargetsFromServer();
  }

  _render() {
    this._el.innerHTML = /* html */`
      <div class="komari-settings-page">
        <div class="komari-page-head">
          <div><h2>延迟监控</h2><p>支持 TCP / ICMP / HTTP 三种探测；目标可写入 VPS 的 Agent 配置 JSON；TCP 需要端口，ICMP 无端口，HTTP 端口选填。</p></div>
          <button class="komari-primary" id="pt-run">开始探测</button><button class="komari-secondary" id="pt-run-node">探测当前节点 IP</button>
        </div>
        <div class="komari-settings-grid two">
          <section class="komari-panel">
            <div class="komari-panel-title"><span>探测配置</span><small>agent_config.ping_targets</small></div>
            <div class="komari-form-grid one">
              <label><span>绑定节点</span><select class="form-input" id="pt-server-select"></select></label>
            </div>
            <div id="pt-source-note" class="komari-note">优先读取该 VPS 的 agent_config.ping_targets；为空则使用全局默认 TCPing 目标。</div>
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
            <div class="komari-panel-title"><span>实时质量</span><small>本轮多协议探测</small></div>
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
    this._el.querySelector('#pt-server-select').addEventListener('change', e => { this._selectedServerId = Number(e.target.value) || null; this._loadTargetsFromServer(); });
    this._el.querySelector('#pt-load').addEventListener('click', () => this._loadTargetsFromServer());
    this._el.querySelector('#pt-add-row').addEventListener('click', () => { this._targets.push({ key:`target-${this._targets.length+1}`, label:'新目标', protocol:'tcp', host:'', port:443 }); this._renderTargetEditor(); });
    this._el.querySelector('#pt-run').addEventListener('click', () => this._runPing());
    this._el.querySelector('#pt-run-node').addEventListener('click', () => this._runCurrentNode());
    this._el.querySelector('#pt-save').addEventListener('click', () => this._saveTargets());
    this._el.querySelector('#pt-clear').addEventListener('click', () => this._clearSavedTargets());
    this._el.querySelector('#pt-export').addEventListener('click', () => this._exportJson());
    this._el.querySelector('#pt-ip-lookup').addEventListener('click', () => this._lookupIP());
    this._el.querySelector('#pt-target-editor').addEventListener('input', () => this._collectTargets());
    this._el.querySelector('#pt-target-editor').addEventListener('change', e => { if (e.target?.dataset?.f === 'protocol') { this._collectTargets(); this._renderTargetEditor(); } });
    this._el.querySelector('#pt-target-editor').addEventListener('click', e => { const btn=e.target.closest('[data-remove-target]'); if(!btn)return; this._targets.splice(Number(btn.dataset.removeTarget),1); this._renderTargetEditor(); });
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
  _loadTargetsFromServer() {
    const server = this._servers.find(s => String(s.id) === String(this._selectedServerId));
    const cfg = server?.agent_config && typeof server.agent_config === 'object' ? server.agent_config : {};
    const hasSavedTargets = Object.prototype.hasOwnProperty.call(cfg, 'ping_targets');
    const targets = hasSavedTargets ? (Array.isArray(cfg.ping_targets) ? cfg.ping_targets : []) : this._defaultTargets();
    this._targets = targets.map((t,i) => this._normalizeTarget(t, i));
    this._el.querySelector('#pt-source-note').textContent = hasSavedTargets ? (targets.length ? '当前使用该节点已保存的 agent_config.ping_targets。' : '当前节点已保存为空：详情页 PING 显示 0 目标，不再回退默认目标。') : '该节点未配置 ping_targets，当前显示全局默认多协议目标；点击保存后才写入该 VPS。';
    this._renderTargetEditor();
  }
  _normalizeTarget(t = {}, i = 0) {
    const protocol = String(t.protocol || 'tcp').toLowerCase();
    const safeProtocol = ['tcp', 'icmp', 'http'].includes(protocol) ? protocol : 'tcp';
    const fallbackPort = safeProtocol === 'http' ? 80 : 443;
    return {
      key: t.key || `target-${i + 1}`,
      label: t.label || t.host || `目标 ${i + 1}`,
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
    const out = { key: t.key, label: t.label, protocol, host: t.host };
    if (protocol === 'tcp') out.port = this._targetApiPort(t);
    if (protocol === 'http' && t.port !== '' && t.port != null) out.port = Number(t.port);
    return out;
  }
  _renderTargetEditor() {
    const el = this._el.querySelector('#pt-target-editor');
    el.innerHTML = this._targets.map((raw,i) => {
      const t = this._normalizeTarget(raw, i);
      const portDisabled = t.protocol === 'icmp' ? 'disabled' : '';
      const portClass = t.protocol === 'icmp' ? ' is-disabled' : (t.protocol === 'http' ? ' is-optional' : ' is-required');
      return `<div class="komari-target-row" data-protocol="${this._esc(t.protocol)}"><input class="form-input" data-f="key" data-i="${i}" value="${this._esc(t.key)}" placeholder="key"><input class="form-input" data-f="label" data-i="${i}" value="${this._esc(t.label)}" placeholder="显示名"><select class="form-input" data-f="protocol" data-i="${i}"><option value="tcp" ${t.protocol==='tcp'?'selected':''}>TCP</option><option value="icmp" ${t.protocol==='icmp'?'selected':''}>ICMP</option><option value="http" ${t.protocol==='http'?'selected':''}>HTTP</option></select><input class="form-input" data-f="host" data-i="${i}" value="${this._esc(t.host)}" placeholder="host / IP / URL"><label class="pt-port-field${portClass}"><input class="form-input" data-f="port" data-i="${i}" value="${this._esc(t.protocol==='icmp'?'':t.port)}" placeholder="${this._esc(this._portPlaceholder(t.protocol))}" ${portDisabled}><small>${this._esc(this._portHelp(t.protocol))}</small></label><button data-remove-target="${i}" class="komari-icon-danger">🗑</button></div>`;
    }).join('') || '<div class="komari-empty-small">暂无目标</div>';
  }
  _collectTargets() {
    this._el.querySelectorAll('#pt-target-editor [data-i]').forEach(input => {
      const i=Number(input.dataset.i); const f=input.dataset.f; if(!this._targets[i]) return;
      if (f === 'port') this._targets[i][f] = input.disabled || input.value.trim()==='' ? '' : Number(input.value || 0);
      else this._targets[i][f] = input.value.trim();
    });
    this._targets = this._targets.map((t, i) => this._normalizeTarget(t, i));
  }
  async _runCurrentNode() {
    const server = this._servers.find(s => String(s.id) === String(this._selectedServerId));
    if (!server?.ip) return this._appendLine('当前节点没有 IP', 'warn');
    const old = this._targets;
    this._targets = [{ key:'node', label:server.name || server.ip, protocol:'tcp', host:server.ip, port:80 }];
    this._renderTargetEditor();
    await this._runPing();
    this._targets = old;
    this._renderTargetEditor();
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
    this._collectTargets(); const targets = this._targets.filter(t => t.host);
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
  _savedPayload(targets){ const server=this._selectedServer(); const cfg=server?.agent_config && typeof server.agent_config === 'object' ? { ...server.agent_config } : {}; cfg.ping_targets = targets; return cfg; }
  async _saveTargets(){
    this._collectTargets();
    const server=this._selectedServer();
    if(!server?.id) return this._appendLine('请先选择 VPS', 'warn');
    const targets=this._targets.filter(t=>t.host).map(t=>this._exportTarget(t));
    const btn=this._el.querySelector('#pt-save'); const old=btn.textContent; btn.disabled=true; btn.textContent='保存中...';
    try{
      const data=await updateAgentConfig(server.id, this._savedPayload(targets));
      server.agent_config = data.agent_config || this._savedPayload(targets);
      this._targets = (server.agent_config.ping_targets || []).map((t,i)=>this._normalizeTarget(t,i));
      this._renderTargetEditor();
      this._el.querySelector('#pt-source-note').textContent = targets.length ? '已保存：当前使用该节点的 agent_config.ping_targets。' : '已保存为空：详情页 PING 显示 0 目标。';
      this._appendLine(`已保存 ${targets.length} 个目标到 VPS #${server.id}。`, 'ok');
    }catch(e){ this._appendLine(`保存失败：${e.message}`, 'fail'); }
    finally{ btn.disabled=false; btn.textContent=old; }
  }
  async _clearSavedTargets(){
    const server=this._selectedServer();
    if(!server?.id) return this._appendLine('请先选择 VPS', 'warn');
    const btn=this._el.querySelector('#pt-clear'); const old=btn.textContent; btn.disabled=true; btn.textContent='清空中...';
    try{
      const data=await updateAgentConfig(server.id, this._savedPayload([]));
      server.agent_config = data.agent_config || this._savedPayload([]);
      this._targets=[];
      this._renderTargetEditor();
      this._el.querySelector('#pt-source-note').textContent = '已清空并保存：详情页 PING 显示 0 目标，不再回退默认目标。';
      this._appendLine(`已清空 VPS #${server.id} 的 ping_targets。`, 'ok');
    }catch(e){ this._appendLine(`清空失败：${e.message}`, 'fail'); }
    finally{ btn.disabled=false; btn.textContent=old; }
  }
  _exportJson(){ this._collectTargets(); const out=JSON.stringify({ ping_targets:this._targets.filter(t=>t.host).map(t=>this._exportTarget(t)) },null,2); navigator.clipboard?.writeText(out); this._appendLine('已复制 ping_targets JSON。', 'ok'); }
  _setEmptyState(text){ this._el.querySelector('#pt-results').innerHTML=`<div class="ping-empty-state">${this._esc(text)}</div>`; }
  _appendLine(text,type='info'){ const c=this._el.querySelector('#pt-results'); let out=c.querySelector('.ping-result'); if(!out){out=document.createElement('div');out.className='ping-result';c.innerHTML='';c.appendChild(out);} const line=document.createElement('div'); line.className=`ping-line ping-${type}`; line.textContent=text||'\u00A0'; out.appendChild(line); out.scrollTop=out.scrollHeight; }
  _clearResults(){ this._el.querySelector('#pt-results').innerHTML='<div class="ping-empty-state">正在探测中...</div>'; }
  async _lookupIP(){ const ip=this._el.querySelector('#pt-ip-input').value.trim(); const out=this._el.querySelector('#pt-ip-result'); out.textContent='查询中...'; try{ const d=await getIPInfo(ip); const rows=[['IP',d.query],['城市',d.city],['地区',d.regionName],['国家',d.country],['ISP/ASN',`${d.isp||'—'} / ${d.as||'—'}`],['经纬度',`${d.lat}, ${d.lon}`],['组织',d.org]]; out.innerHTML=rows.map(([k,v])=>`<div><span>${this._esc(k)}</span><b>${this._esc(v||'—')}</b></div>`).join(''); }catch(e){ out.innerHTML=`<em>查询失败：${this._esc(e.message)}</em>`; }}
  _esc(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
}
